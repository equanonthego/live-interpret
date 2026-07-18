/**
 * AudioInputPacer — LiveKit이 불규칙하게 전달하는 PCM 오디오를 버퍼에 모아,
 * 고정 크기(기본 20ms) 청크로 일정한 wall-clock 간격에 맞춰 Gemini Live로
 * 흘려보낸다.
 *
 * 배경: gemini-3.5-live-translate-preview 모델은 입력 오디오가 고르지 않으면
 * 번역 출력에 지터/단어잘림이 생긴다. 또한 입력 공백을 "발화 종료"로 오인할
 * 수 있어, 강의처럼 말 사이 정적이 잦은 상황에서 번역이 끊긴다. 이를 막기 위해
 * (1) 균등 페이싱 (2) 프라임 버퍼 (3) 버퍼가 마르면 디지털 무음 주입을 한다.
 * 참조: GetStream/Vision-Agents AudioInputPacingConfig.virtual_microphone().
 *
 * 이 파일의 버퍼/청크 결정 로직(push/nextChunk)은 타이머와 분리된 순수 로직으로,
 * 단위 테스트 대상이다. start()/stop()의 wall-clock 루프는 이를 구동하는 글루다.
 */

export interface AudioInputPacerConfig {
  /** 입력 PCM 샘플레이트 (Hz). Gemini Live 네이티브 입력은 16000. */
  sampleRate: number;
  /** 청크 길이 (ms). 기본 20ms. */
  chunkMs: number;
  /** 송출 시작 전 미리 채워둘 버퍼 (ms). 짧은 정체에도 굶지 않게 한다. */
  startupBufferMs: number;
  /** 버퍼 상한 (ms). 초과분은 오래된 것부터 버려 지연 누적을 막는다. */
  maxBufferMs: number;
  /** true면 버퍼가 비었을 때 무음 청크를 주입한다 (speech-to-speech 모델용). */
  silenceWhenEmpty: boolean;
}

/**
 * speech-to-speech(번역) 모델용 프리셋: 프라임 버퍼 + 무음 주입.
 *
 * startupBufferMs는 정상 지연에 그대로 상주하는 값이다(프라임한 만큼 버퍼가
 * 유지되므로). 강의 통역에서는 지연을 우선해 250ms(0.25초)로 둔다. Vision-Agents
 * 원본 기본값은 500ms(더 견고하지만 지연 +0.5초). 끊김이 잦으면 다시 올린다.
 */
export function virtualMicrophoneConfig(
  sampleRate: number
): AudioInputPacerConfig {
  return {
    sampleRate,
    chunkMs: 20,
    startupBufferMs: 250,
    maxBufferMs: 1500,
    silenceWhenEmpty: true,
  };
}

export class AudioInputPacer {
  private readonly chunkSamples: number;
  private readonly startupSamples: number;
  private readonly maxSamples: number;
  private readonly silenceWhenEmpty: boolean;
  private readonly intervalMs: number;

  private segments: Int16Array[] = [];
  private readOffset = 0;
  private primed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;

  /** 현재 버퍼에 쌓인 유효 샘플 수. */
  bufferedSamples = 0;

  constructor(config: AudioInputPacerConfig) {
    this.intervalMs = config.chunkMs;
    this.chunkSamples = Math.round((config.sampleRate * config.chunkMs) / 1000);
    this.startupSamples = Math.round(
      (config.sampleRate * config.startupBufferMs) / 1000
    );
    this.maxSamples = Math.round(
      (config.sampleRate * config.maxBufferMs) / 1000
    );
    this.silenceWhenEmpty = config.silenceWhenEmpty;
  }

  /** 불규칙하게 도착하는 PCM을 버퍼에 넣는다. 상한 초과분은 오래된 것부터 버린다. */
  push(samples: Int16Array): void {
    if (samples.length === 0) return;
    this.segments.push(samples);
    this.bufferedSamples += samples.length;

    while (this.bufferedSamples > this.maxSamples) {
      const over = this.bufferedSamples - this.maxSamples;
      const head = this.segments[0];
      const avail = head.length - this.readOffset;
      if (avail <= over) {
        this.segments.shift();
        this.readOffset = 0;
        this.bufferedSamples -= avail;
      } else {
        this.readOffset += over;
        this.bufferedSamples -= over;
      }
    }
  }

  /**
   * 한 tick에 보낼 청크를 반환한다.
   * - 프라임 전(버퍼 < startup): null (아직 송출하지 않음)
   * - 버퍼에 청크분 이상 쌓임: 정확히 chunkSamples 만큼 FIFO로 꺼내 반환
   * - 버퍼가 말랐고 silenceWhenEmpty=true: 무음(0) 청크
   * - 그 외: null (skip)
   */
  nextChunk(): Int16Array | null {
    if (!this.primed) {
      if (this.bufferedSamples >= this.startupSamples) {
        this.primed = true;
      } else {
        return null;
      }
    }

    if (this.bufferedSamples >= this.chunkSamples) {
      return this.dequeue(this.chunkSamples);
    }

    if (this.silenceWhenEmpty) {
      return new Int16Array(this.chunkSamples);
    }

    return null;
  }

  /**
   * chunkMs 간격의 self-correcting 타이머를 켠다. 매 tick마다 nextChunk()를
   * 호출하고, 결과가 있으면 onChunk 콜백으로 넘긴다. setInterval의 드리프트
   * 누적을 피하려고 다음 기준 시각(nextTickAt)에 맞춰 setTimeout 지연을 보정한다.
   */
  start(onChunk: (chunk: Int16Array) => void): void {
    if (this.timer) return;
    this.nextTickAt = performance.now() + this.intervalMs;
    const tick = () => {
      const chunk = this.nextChunk();
      if (chunk) onChunk(chunk);

      this.nextTickAt += this.intervalMs;
      let delay = this.nextTickAt - performance.now();
      if (delay < -1000) {
        // 이벤트 루프가 크게 밀렸으면 기준 시각을 리셋해 폭주(catch-up)를 막는다.
        this.nextTickAt = performance.now() + this.intervalMs;
        delay = this.intervalMs;
      } else if (delay < 0) {
        delay = 0;
      }
      this.timer = setTimeout(tick, delay);
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  /** 타이머를 끄고 버퍼를 비운다. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.segments = [];
    this.readOffset = 0;
    this.bufferedSamples = 0;
    this.primed = false;
  }

  private dequeue(n: number): Int16Array {
    const out = new Int16Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.segments[0];
      const avail = head.length - this.readOffset;
      const take = Math.min(avail, n - filled);
      out.set(head.subarray(this.readOffset, this.readOffset + take), filled);
      filled += take;
      this.readOffset += take;
      this.bufferedSamples -= take;
      if (this.readOffset >= head.length) {
        this.segments.shift();
        this.readOffset = 0;
      }
    }
    return out;
  }
}

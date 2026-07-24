/**
 * CaptionSegmenter — 연속으로 흘러오는 자막 텍스트를 "세그먼트(문장 단위)"로
 * 끊어 발행한다.
 *
 * 왜 필요한가:
 * gemini-3.5-live-translate-preview(번역 전용 모델)는 turnComplete를 보내지
 * 않는다(실측: serverContent 126건 중 0건). 그런데 클라이언트 자막 UI는
 * segmentId가 같으면 기존 자막에 텍스트를 이어붙이도록 되어 있다. 따라서
 * turnComplete에만 의존해 세그먼트를 넘기면 segmentId가 0에 고정되고, 자막 한
 * 줄이 강의 내내 무한히 길어져 화면상 "자막이 멈춘" 것처럼 보인다.
 *
 * 그래서 발화 사이의 무음(idleMs)을 문장 경계로 삼아 세그먼트를 마감한다.
 * turnComplete를 보내는 모델에서는 close()로 즉시 마감할 수 있다.
 */

// 세그먼트를 끊는 무음 간격(ms).
export const DEFAULT_SEGMENT_IDLE_MS = 1200;

// interim 자막을 모아 내보내는 스로틀 간격(ms).
export const DEFAULT_THROTTLE_MS = 150;

export interface CaptionSegmenterOptions {
  /** 자막 조각을 실제로 내보낸다. segmentId는 이 조각이 속한 세그먼트 번호. */
  publish: (text: string, interim: boolean, segmentId: number) => void;
  /** 지금 발행해도 되는 상태인지(예: 브릿지가 active인지). */
  canPublish: () => boolean;
  idleMs?: number;
  throttleMs?: number;
}

export class CaptionSegmenter {
  private segmentId = 0;
  private pending = "";
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 현재 세그먼트로 이미 내보낸 내용이 있는지. 빈 세그먼트 마감을 막는다. */
  private hasText = false;

  private readonly publish: CaptionSegmenterOptions["publish"];
  private readonly canPublish: CaptionSegmenterOptions["canPublish"];
  private readonly idleMs: number;
  private readonly throttleMs: number;

  constructor(options: CaptionSegmenterOptions) {
    this.publish = options.publish;
    this.canPublish = options.canPublish;
    this.idleMs = options.idleMs ?? DEFAULT_SEGMENT_IDLE_MS;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  }

  /** 지금 발행 중인 세그먼트 번호. */
  get currentSegmentId(): number {
    return this.segmentId;
  }

  /** 새 자막 조각이 도착했다. 스로틀해서 내보내고, 마감 타이머를 뒤로 민다. */
  push(text: string): void {
    this.pending += text;

    if (!this.throttleTimer) {
      this.throttleTimer = setTimeout(() => this.flush(), this.throttleMs);
    }

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
  }

  /**
   * 현재 세그먼트를 final로 마감하고 다음 세그먼트로 넘어간다.
   * 남은 버퍼가 있으면 final로 내보내고, 이미 다 내보냈으면 빈 텍스트 +
   * final=true로 마감만 통지한다(클라이언트는 ""를 이어붙이고 final 표시만
   * 갱신한다). 내보낸 내용이 없는 세그먼트는 번호를 소모하지 않는다.
   */
  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    if (this.pending) {
      // 발행하지 못했으면 버퍼를 버리지 않는다(발행 가능해지면 이어서 나간다).
      if (this.emit(this.pending, false)) this.pending = "";
    } else if (this.hasText) {
      this.emit("", false);
    }

    if (this.hasText) {
      this.segmentId++;
      this.hasText = false;
    }
  }

  /** 타이머와 버퍼를 모두 정리한다(브릿지 종료 시). */
  reset(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.pending = "";
    this.hasText = false;
  }

  private flush(): void {
    this.throttleTimer = null;
    if (!this.pending) return;
    if (this.emit(this.pending, true)) this.pending = "";
  }

  /** 실제로 발행했으면 true. 발행 불가 상태(예: 브릿지가 아직 active 아님)면 false. */
  private emit(text: string, interim: boolean): boolean {
    if (!this.canPublish()) return false;
    this.publish(text, interim, this.segmentId);
    // 빈 마감 통지는 "내용 있음"으로 치지 않는다.
    if (text) this.hasText = true;
    return true;
  }
}

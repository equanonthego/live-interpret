/**
 * 지연 계측 유틸 — 리전(브릿지 위치)이 통역 지연에 주는 영향을 숫자로 재기
 * 위한 도구. 두 가지를 담는다.
 *
 *  1. tcpConnectMs(): 브릿지 프로세스에서 특정 호스트까지의 TCP 연결 왕복(RTT).
 *     Gemini·LiveKit 엔드포인트까지의 거리를 재는 데 쓴다. 로컬 Mac에서 재고,
 *     클라우드(예: asia-northeast3)에 배포해 다시 재면 "리전이 바꾸는 구간"이
 *     그대로 드러난다.
 *
 *  2. RollingLatency: 응답 지연 표본을 모아 min/중앙값/p95/max로 요약. 순수
 *     로직이라 단위테스트가 가능하다(latency-probe.test.ts).
 *
 * 계측 전용이라 통역 오디오 경로에는 관여하지 않는다.
 */

import net from "net";

/**
 * host:port 로의 TCP 연결이 성립하기까지 걸린 시간(ms)을 잰다. ICMP(ping)는
 * 막히는 환경이 많아, 실제 앱이 쓰는 TCP 경로로 잰다. TLS 이전 단계라
 * 순수 왕복에 가깝다.
 */
export function tcpConnectMs(
  host: string,
  port = 443,
  timeoutMs = 4000
): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(() => resolve(Date.now() - start)));
    socket.once("timeout", () =>
      done(() => reject(new Error(`timeout after ${timeoutMs}ms`)))
    );
    socket.once("error", (err) => done(() => reject(err)));

    socket.connect(port, host);
  });
}

export interface LatencySummary {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

/**
 * 지연 표본(ms)을 모아 요약 통계를 낸다. 최근 N개만 유지해 세션이 길어져도
 * 메모리가 늘지 않는다.
 */
export class RollingLatency {
  private samples: number[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 500) {
    this.maxSamples = maxSamples;
  }

  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  /** 표본이 없으면 null. */
  summary(): LatencySummary | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct = (p: number) => {
      // nearest-rank: 표본이 적을 때도 실제 값 하나를 그대로 돌려준다.
      const idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
      );
      return sorted[idx];
    };
    return {
      count: sorted.length,
      min: sorted[0],
      median: pct(50),
      p95: pct(95),
      max: sorted[sorted.length - 1],
    };
  }
}

/** Int16 PCM 프레임의 피크 절댓값(0~32768). 발화/무음 구분에 쓴다. */
export function peakAmplitude(pcm: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (v > peak) peak = v;
  }
  return peak;
}

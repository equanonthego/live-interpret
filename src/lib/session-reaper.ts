/**
 * 세션 자동 종료(리퍼) 판정 — 순수 로직.
 *
 * 방송 비용(Gemini·LiveKit·Cloud Run)이 무한정 새는 것을 막기 위해, 발표자가
 * 이탈했거나(절전/닫힘/전원차단 → 심장박동 끊김) 오래 말을 안 하면(무음) 세션을
 * 종료할지 판정한다. 부작용 없는 순수 함수라 단위테스트로 검증한다.
 */

export type ReapReason = "heartbeat" | "idle";

export interface ReapInput {
  now: number;
  /** 발표자의 마지막 심장박동(status 폴링) 시각(ms). */
  lastHeartbeatAt: number;
  /** 세션의 마지막 발화 활동 시각(ms). 발화가 없었으면 세션 생성 시각. */
  lastAudioAt: number;
  heartbeatTimeoutMs: number;
  idleAudioTimeoutMs: number;
}

/**
 * 종료 사유를 돌려준다. 종료하지 않으면 null.
 * 심장박동 끊김(발표자 이탈)을 무음보다 우선한다 — 더 확실한 이탈 신호이므로.
 */
export function evaluateReap(input: ReapInput): ReapReason | null {
  const {
    now,
    lastHeartbeatAt,
    lastAudioAt,
    heartbeatTimeoutMs,
    idleAudioTimeoutMs,
  } = input;

  if (now - lastHeartbeatAt > heartbeatTimeoutMs) return "heartbeat";
  if (now - lastAudioAt > idleAudioTimeoutMs) return "idle";
  return null;
}

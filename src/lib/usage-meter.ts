/**
 * Gemini Live 응답의 usageMetadata를 누적하는 순수 로직.
 *
 * 한 브릿지 내에서 usageMetadata는 세션 누계로 보고되므로 totalTokenCount를
 * "누적 최대값"으로 취급한다(증분으로 오해해 더하면 값이 부풀려진다). 서로
 * 다른 브릿지의 사용량을 합칠 때만 mergeUsage로 필드별 합산한다.
 */

export interface UsageTotals {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

export function emptyUsage(): UsageTotals {
  return { promptTokens: 0, responseTokens: 0, totalTokens: 0 };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function accumulateUsage(prev: UsageTotals, message: unknown): UsageTotals {
  if (typeof message !== "object" || message === null) return prev;
  const meta = (message as { usageMetadata?: unknown }).usageMetadata;
  if (typeof meta !== "object" || meta === null) return prev;

  const m = meta as {
    promptTokenCount?: unknown;
    responseTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
  const prompt = num(m.promptTokenCount);
  const response = num(m.responseTokenCount);
  const total = num(m.totalTokenCount) || prompt + response;

  return {
    promptTokens: Math.max(prev.promptTokens, prompt),
    responseTokens: Math.max(prev.responseTokens, response),
    totalTokens: Math.max(prev.totalTokens, total),
  };
}

export function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    responseTokens: a.responseTokens + b.responseTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export function estimateUsd(
  totals: UsageTotals,
  usdPerMillionTokens: number | null
): number | null {
  if (usdPerMillionTokens === null) return null;
  return (totals.totalTokens / 1_000_000) * usdPerMillionTokens;
}

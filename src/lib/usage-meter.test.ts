import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyUsage,
  accumulateUsage,
  mergeUsage,
  estimateUsd,
} from "./usage-meter.ts";

test("emptyUsage는 0으로 시작", () => {
  assert.deepEqual(emptyUsage(), {
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
  });
});

test("usageMetadata 없는 메시지는 누계를 그대로 둔다", () => {
  const prev = { promptTokens: 5, responseTokens: 7, totalTokens: 12 };
  assert.deepEqual(accumulateUsage(prev, { serverContent: {} }), prev);
  assert.deepEqual(accumulateUsage(prev, null), prev);
  assert.deepEqual(accumulateUsage(prev, "nope"), prev);
});

test("usageMetadata를 누적값(최대)으로 취급 — 더 큰 값이 오면 갱신", () => {
  const prev = emptyUsage();
  const next = accumulateUsage(prev, {
    usageMetadata: {
      promptTokenCount: 100,
      responseTokenCount: 40,
      totalTokenCount: 140,
    },
  });
  assert.deepEqual(next, {
    promptTokens: 100,
    responseTokens: 40,
    totalTokens: 140,
  });
});

test("더 작은 totalTokenCount가 와도 누계가 줄지 않는다", () => {
  const prev = { promptTokens: 100, responseTokens: 40, totalTokens: 140 };
  const next = accumulateUsage(prev, {
    usageMetadata: { promptTokenCount: 10, responseTokenCount: 5, totalTokenCount: 15 },
  });
  assert.deepEqual(next, prev);
});

test("totalTokenCount가 없으면 prompt+response로 합산", () => {
  const next = accumulateUsage(emptyUsage(), {
    usageMetadata: { promptTokenCount: 30, responseTokenCount: 20 },
  });
  assert.equal(next.totalTokens, 50);
});

test("mergeUsage는 필드별로 합산(여러 브릿지 합계용)", () => {
  const a = { promptTokens: 10, responseTokens: 20, totalTokens: 30 };
  const b = { promptTokens: 1, responseTokens: 2, totalTokens: 3 };
  assert.deepEqual(mergeUsage(a, b), {
    promptTokens: 11,
    responseTokens: 22,
    totalTokens: 33,
  });
});

test("estimateUsd — 단가가 null이면 null", () => {
  const t = { promptTokens: 0, responseTokens: 0, totalTokens: 1_000_000 };
  assert.equal(estimateUsd(t, null), null);
});

test("estimateUsd — 100만 토큰 × 단가", () => {
  const t = { promptTokens: 0, responseTokens: 0, totalTokens: 2_000_000 };
  assert.equal(estimateUsd(t, 3), 6);
});

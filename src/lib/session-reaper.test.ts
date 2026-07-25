import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReap } from "./session-reaper.ts";

const HB = 90_000; // 90초
const IDLE = 300_000; // 5분

const base = {
  now: 1_000_000,
  lastHeartbeatAt: 1_000_000,
  lastAudioAt: 1_000_000,
  heartbeatTimeoutMs: HB,
  idleAudioTimeoutMs: IDLE,
};

test("정상(둘 다 최근) → null", () => {
  assert.equal(evaluateReap(base), null);
});

test("심장박동 초과 → 'heartbeat'", () => {
  assert.equal(
    evaluateReap({ ...base, lastHeartbeatAt: base.now - HB - 1 }),
    "heartbeat"
  );
});

test("심장박동 경계(정확히 임계) → null (초과만 종료)", () => {
  assert.equal(
    evaluateReap({ ...base, lastHeartbeatAt: base.now - HB }),
    null
  );
});

test("무음 초과, 심장박동 정상 → 'idle'", () => {
  assert.equal(
    evaluateReap({ ...base, lastAudioAt: base.now - IDLE - 1 }),
    "idle"
  );
});

test("무음 경계 → null", () => {
  assert.equal(evaluateReap({ ...base, lastAudioAt: base.now - IDLE }), null);
});

test("둘 다 초과 → 'heartbeat' 우선", () => {
  assert.equal(
    evaluateReap({
      ...base,
      lastHeartbeatAt: base.now - HB - 1,
      lastAudioAt: base.now - IDLE - 1,
    }),
    "heartbeat"
  );
});

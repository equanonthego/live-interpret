import { test } from "node:test";
import assert from "node:assert/strict";
import { RollingLatency, peakAmplitude } from "./latency-probe.ts";

test("summary() 는 표본이 없으면 null", () => {
  assert.equal(new RollingLatency().summary(), null);
});

test("summary() 기본 통계", () => {
  const r = new RollingLatency();
  for (const ms of [100, 200, 300, 400, 500]) r.push(ms);
  const s = r.summary();
  assert.ok(s);
  assert.equal(s.count, 5);
  assert.equal(s.min, 100);
  assert.equal(s.max, 500);
  assert.equal(s.median, 300);
  // nearest-rank p95: ceil(0.95*5)-1 = 4 → 500
  assert.equal(s.p95, 500);
});

test("push() 는 음수/NaN 을 버린다", () => {
  const r = new RollingLatency();
  r.push(-5);
  r.push(NaN);
  r.push(Infinity);
  r.push(42);
  assert.equal(r.count, 1);
  assert.equal(r.summary()?.median, 42);
});

test("maxSamples 초과 시 오래된 표본을 버린다(FIFO)", () => {
  const r = new RollingLatency(3);
  for (const ms of [10, 20, 30, 40]) r.push(ms);
  const s = r.summary();
  assert.equal(s?.count, 3);
  assert.equal(s?.min, 20); // 10 은 밀려남
  assert.equal(s?.max, 40);
});

test("peakAmplitude 는 절댓값 최대", () => {
  assert.equal(peakAmplitude(Int16Array.from([0, 0, 0])), 0);
  assert.equal(peakAmplitude(Int16Array.from([100, -3000, 50])), 3000);
  assert.equal(peakAmplitude(Int16Array.from([-32768])), 32768);
});

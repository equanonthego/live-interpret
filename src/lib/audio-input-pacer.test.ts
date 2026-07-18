import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioInputPacer } from "./audio-input-pacer.ts";

// 16kHz 기준: 20ms = 320샘플, 500ms(프라임) = 8000샘플, 1500ms(최대) = 24000샘플
const CFG = {
  sampleRate: 16000,
  chunkMs: 20,
  startupBufferMs: 500,
  maxBufferMs: 1500,
  silenceWhenEmpty: true,
};

function filled(n: number, value = 1): Int16Array {
  return new Int16Array(n).fill(value);
}

function isAllZero(a: Int16Array): boolean {
  for (const v of a) if (v !== 0) return false;
  return true;
}

test("프라임 전에는 chunk를 내보내지 않는다 (null)", () => {
  const pacer = new AudioInputPacer(CFG);
  pacer.push(filled(7999)); // 500ms(8000샘플)에 1샘플 부족
  assert.equal(pacer.nextChunk(), null);
});

test("프라임(500ms) 도달 후 정확히 320샘플 청크를 내보낸다", () => {
  const pacer = new AudioInputPacer(CFG);
  pacer.push(filled(8000)); // 정확히 500ms
  const chunk = pacer.nextChunk();
  assert.ok(chunk instanceof Int16Array);
  assert.equal(chunk!.length, 320);
});

test("연속 tick에서 매번 320샘플씩 FIFO 순서로 빠진다", () => {
  const pacer = new AudioInputPacer(CFG);
  // 8000샘플: 앞 320은 값 1, 다음 320은 값 2로 구분
  pacer.push(filled(320, 1));
  pacer.push(filled(7680, 2));
  const c1 = pacer.nextChunk()!;
  const c2 = pacer.nextChunk()!;
  assert.equal(c1.length, 320);
  assert.equal(c2.length, 320);
  assert.ok(c1.every((v) => v === 1), "첫 청크는 먼저 push된 값");
  assert.ok(c2.every((v) => v === 2), "둘째 청크는 그 다음 값");
});

test("silenceWhenEmpty: 프라임 후 버퍼가 마르면 무음(0) 청크를 낸다", () => {
  const pacer = new AudioInputPacer(CFG);
  pacer.push(filled(8000)); // 프라임
  // 8000 / 320 = 25개 청크 소진
  for (let i = 0; i < 25; i++) assert.ok(!isAllZero(pacer.nextChunk()!));
  const silent = pacer.nextChunk();
  assert.ok(silent instanceof Int16Array);
  assert.equal(silent!.length, 320);
  assert.ok(isAllZero(silent!), "버퍼가 비면 무음이어야 함");
});

test("silenceWhenEmpty=false: 프라임 후 버퍼가 마르면 null을 낸다", () => {
  const pacer = new AudioInputPacer({ ...CFG, silenceWhenEmpty: false });
  pacer.push(filled(8000));
  for (let i = 0; i < 25; i++) pacer.nextChunk();
  assert.equal(pacer.nextChunk(), null, "무음모드 아니면 skip(null)");
});

test("버퍼가 최대치(1500ms)를 넘으면 오래된 샘플을 버린다", () => {
  const pacer = new AudioInputPacer(CFG);
  pacer.push(filled(20000, 1)); // 오래된 것
  pacer.push(filled(20000, 2)); // 새 것 → 합 40000, 최대 24000 초과
  assert.equal(pacer.bufferedSamples, 24000, "최대 24000샘플로 캡");
  // 가장 오래된 값 1이 앞에서 잘려나갔으므로, 첫 청크에 값 2가 섞여 나오면 안 되고
  // 남은 건 value 1 4000개 + value 2 20000개. 첫 청크는 value 1.
  const first = pacer.nextChunk()!;
  assert.ok(first.every((v) => v === 1), "가장 오래된 유효 샘플부터 나온다");
});

test("한 번 프라임되면 이후 버퍼가 다시 낮아져도 계속 흐른다", () => {
  const pacer = new AudioInputPacer(CFG);
  pacer.push(filled(8000)); // 프라임
  for (let i = 0; i < 25; i++) pacer.nextChunk(); // 소진
  pacer.push(filled(320, 5)); // 소량 추가 (프라임 임계 미만)
  const chunk = pacer.nextChunk()!;
  assert.ok(chunk.every((v) => v === 5), "재프라임 대기 없이 즉시 흐른다");
});

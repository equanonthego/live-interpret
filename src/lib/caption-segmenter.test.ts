import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptionSegmenter } from "./caption-segmenter.ts";

// 배경: gemini-3.5-live-translate-preview는 turnComplete를 보내지 않는다
// (실측 — serverContent 126건 중 0건). 클라이언트 자막 UI는 segmentId가 같으면
// 기존 자막에 텍스트를 이어붙이므로, 세그먼트가 안 넘어가면 자막 한 줄이 강의
// 내내 무한히 길어지고 화면상 "자막이 멈춘" 것처럼 보인다. 아래 테스트가 그
// 회귀를 막는다.

interface Published {
  text: string;
  interim: boolean;
  segmentId: number;
}

function make(canPublish: () => boolean = () => true) {
  const published: Published[] = [];
  const segmenter = new CaptionSegmenter({
    publish: (text, interim, segmentId) =>
      published.push({ text, interim, segmentId }),
    canPublish,
  });
  return { segmenter, published };
}

test("발화 중에는 interim으로 내보내고 세그먼트를 유지한다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter, published } = make();

  segmenter.push("안녕하세요");
  t.mock.timers.tick(150); // 스로틀 플러시

  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    text: "안녕하세요",
    interim: true,
    segmentId: 0,
  });
  assert.equal(segmenter.currentSegmentId, 0);
});

test("turnComplete 없이도 무음 1200ms면 세그먼트를 마감하고 번호를 넘긴다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter, published } = make();

  segmenter.push("안녕하세요");
  t.mock.timers.tick(150);
  t.mock.timers.tick(1200); // 무음 → 마감

  const last = published[published.length - 1];
  assert.equal(last.interim, false, "마감은 final로 발행돼야 한다");
  assert.equal(last.segmentId, 0, "마감 통지는 0번 세그먼트 소속");
  assert.equal(segmenter.currentSegmentId, 1, "다음 세그먼트로 넘어간다");
});

test("말이 이어지는 동안(무음 1200ms 미달)에는 같은 세그먼트를 유지한다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter } = make();

  for (let i = 0; i < 5; i++) {
    segmenter.push(`조각${i}`);
    t.mock.timers.tick(1000);
  }
  assert.equal(segmenter.currentSegmentId, 0);
});

test("마감 후 새 발화는 새 segmentId로 나간다 (무한 누적 회귀 방지)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter, published } = make();

  segmenter.push("첫 문장");
  t.mock.timers.tick(150);
  t.mock.timers.tick(1200);

  segmenter.push("둘째 문장");
  t.mock.timers.tick(150);

  const last = published[published.length - 1];
  assert.equal(last.text, "둘째 문장");
  assert.equal(last.segmentId, 1);
});

test("내용이 없는 세그먼트는 마감해도 아무것도 발행하지 않는다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter, published } = make();

  segmenter.close();

  assert.equal(published.length, 0);
  assert.equal(segmenter.currentSegmentId, 0, "빈 세그먼트는 번호를 안 쓴다");
});

test("close()는 남은 버퍼를 final로 내보내며 즉시 마감한다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter, published } = make();

  segmenter.push("완결 문장"); // 스로틀 전에 바로 close
  segmenter.close();

  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    text: "완결 문장",
    interim: false,
    segmentId: 0,
  });
  assert.equal(segmenter.currentSegmentId, 1);
});

test("canPublish가 false면 발행하지 않고 세그먼트도 소모하지 않는다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter, published } = make(() => false);

  segmenter.push("보내면 안 되는 자막");
  t.mock.timers.tick(150);
  t.mock.timers.tick(1200);

  assert.equal(published.length, 0);
  assert.equal(segmenter.currentSegmentId, 0);
});

test("발행 불가 상태에서 모인 자막은 버려지지 않고 이어서 나간다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let active = false;
  const published: Published[] = [];
  const segmenter = new CaptionSegmenter({
    publish: (text, interim, segmentId) =>
      published.push({ text, interim, segmentId }),
    canPublish: () => active,
  });

  // 브릿지가 아직 active가 되기 전에 도착한 자막.
  segmenter.push("먼저 온 자막");
  t.mock.timers.tick(150);
  assert.equal(published.length, 0, "아직 발행하지 않는다");

  // active가 된 뒤 다음 자막이 오면 앞서 모인 것까지 함께 나가야 한다.
  active = true;
  segmenter.push(" 다음 자막");
  t.mock.timers.tick(150);

  assert.equal(published.length, 1);
  assert.equal(published[0].text, "먼저 온 자막 다음 자막");
});

test("reset()은 대기 중인 타이머와 버퍼를 정리한다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { segmenter, published } = make();

  segmenter.push("정리될 자막");
  segmenter.reset();
  t.mock.timers.tick(5000); // 남은 타이머가 있으면 여기서 터진다

  assert.equal(published.length, 0);
});

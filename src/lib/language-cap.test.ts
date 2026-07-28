import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenLanguage, LanguageCapReachedError } from "./language-cap.ts";

test("상한 미만이면 새 언어를 열 수 있다", () => {
  assert.equal(canOpenLanguage(["en", "ja"], "ko", 8), true);
});

test("상한 직전(7개)에서 8번째 언어는 허용", () => {
  const open = ["en", "ja", "vi", "ru", "de", "fr", "es"];
  assert.equal(canOpenLanguage(open, "zh-Hans", 8), true);
});

test("상한(8개)에 도달하면 9번째 새 언어는 거부", () => {
  const open = ["en", "ja", "vi", "ru", "de", "fr", "es", "zh-Hans"];
  assert.equal(canOpenLanguage(open, "ko", 8), false);
});

test("이미 열린 언어는 상한이 찼어도 재요청 허용(재사용은 자리를 안 씀)", () => {
  const open = ["en", "ja", "vi", "ru", "de", "fr", "es", "zh-Hans"];
  assert.equal(canOpenLanguage(open, "ja", 8), true);
});

test("LanguageCapReachedError는 openLanguages를 보존한다", () => {
  const open = ["en", "ja"];
  const err = new LanguageCapReachedError(open);
  assert.ok(err instanceof Error);
  assert.deepEqual(err.openLanguages, open);
  assert.equal(err.name, "LanguageCapReachedError");
});

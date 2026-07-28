import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeviceLanguage, getLanguageByCode } from "./languages.ts";

test("지역코드를 벗겨 기본 코드로", () => {
  assert.equal(resolveDeviceLanguage("ru-RU"), "ru");
  assert.equal(resolveDeviceLanguage("en-GB"), "en");
  assert.equal(resolveDeviceLanguage("de-AT"), "de");
});

test("중국어 스크립트 구분", () => {
  assert.equal(resolveDeviceLanguage("zh-CN"), "zh-Hans");
  assert.equal(resolveDeviceLanguage("zh-SG"), "zh-Hans");
  assert.equal(resolveDeviceLanguage("zh-Hans-CN"), "zh-Hans");
  assert.equal(resolveDeviceLanguage("zh-TW"), "zh-Hant");
  assert.equal(resolveDeviceLanguage("zh-HK"), "zh-Hant");
  assert.equal(resolveDeviceLanguage("zh-Hant-TW"), "zh-Hant");
  assert.equal(resolveDeviceLanguage("zh"), "zh-Hans");
});

test("포르투갈어 지역 구분", () => {
  assert.equal(resolveDeviceLanguage("pt-BR"), "pt-BR");
  assert.equal(resolveDeviceLanguage("pt"), "pt-PT");
  assert.equal(resolveDeviceLanguage("pt-PT"), "pt-PT");
});

test("레거시 별칭 유지", () => {
  assert.equal(resolveDeviceLanguage("nb"), "no");
  assert.equal(resolveDeviceLanguage("nb-NO"), "no");
  assert.equal(resolveDeviceLanguage("iw"), "he");
});

test("대소문자·공백에 견고", () => {
  assert.equal(resolveDeviceLanguage("EN-us"), "en");
  assert.equal(resolveDeviceLanguage("  ko  "), "ko");
});

test("지원 목록에 없으면 undefined", () => {
  assert.equal(resolveDeviceLanguage("xx-YY"), undefined);
  assert.equal(resolveDeviceLanguage(""), undefined);
});

test("getLanguageByCode는 기존 별칭 정규화를 그대로 유지", () => {
  assert.equal(getLanguageByCode("nb")?.code, "no");
  assert.equal(getLanguageByCode("zh")?.code, "zh-Hans");
  assert.equal(getLanguageByCode("pt")?.code, "pt-BR");
  assert.equal(getLanguageByCode("de")?.code, "de");
});

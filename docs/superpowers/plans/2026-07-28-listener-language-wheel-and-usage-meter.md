# 청자 언어 전면 개방(휠) + 사용량 계량기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 청자가 79개 언어 전부를 휠에서 직접 고르게 하되, 세션당 동시 8개 언어로 비용 상한을 유지하고, 강사에게 세션 실사용량을 계량해 보여준다.

**Architecture:** 정적 허용목록(랜딩이 보내던 5개 언어)을 제거하고 매니저에 동시 상한 게이트를 추가한다. Gemini Live의 `usageMetadata`를 브릿지에서 누적해 매니저 세션 누계로 flush하고, 발표자 폴링 엔드포인트에 얹어 방송 패널에 표시한다. 청자 UI는 네이티브 `<select>`를 커스텀 바텀시트 휠로 교체하되 접근성용 숨김 `<select>`를 병행한다.

**Tech Stack:** Next.js 16, React 19, TypeScript, `ws`(Gemini Live), LiveKit, `node --test`(순수 함수 테스트만).

## Global Constraints

- 판정·누적·정규화 **로직은 전부 `src/lib/`의 순수 함수**로 분리한다. 컴포넌트는 그 함수를 호출하는 얇은 껍데기. (React 테스트 인프라 없음 — 테스트는 `node --test src/lib/*.test.ts`.)
- 테스트 파일은 `import { test } from "node:test";` + `import assert from "node:assert/strict";`, 대상 모듈은 **`.ts` 확장자 포함**해서 import (`from "./foo.ts"`).
- TypeScript 타입 에러 0, 미사용 import/변수 0. 커밋 전 `npx tsc --noEmit` 통과.
- Gemini API 키·WS URL은 로그·응답 어디에도 노출하지 않는다.
- 동시 상한 값: `MAX_CONCURRENT_LANGUAGES = 8`.
- 충전 링크: `https://aistudio.google.com/app/apikey` (`target="_blank" rel="noopener noreferrer"`).
- 단가 env: `GEMINI_LIVE_USD_PER_1M_TOKENS`. 미설정이면 금액을 렌더하지 않고 토큰 수만 표시. 금액에는 항상 `약` 접두사.
- `previousLanguage` 해지를 `getOrCreate`보다 **먼저** 하는 `/api/translate` POST의 현재 순서를 반드시 유지한다.

---

## File Structure

**신규**
- `src/lib/language-cap.ts` — 동시 상한 판정 순수 함수 + `LanguageCapReachedError`
- `src/lib/language-cap.test.ts`
- `src/lib/usage-meter.ts` — 사용량 누적/병합/추정 순수 함수
- `src/lib/usage-meter.test.ts`
- `src/lib/languages.test.ts` — `resolveDeviceLanguage` 테스트
- `src/app/session/[id]/watch/components/LanguageWheel.tsx` — 바텀시트 휠

**수정**
- `src/lib/interpret-config.ts` — `DEFAULT_INTERPRET_LANGUAGES` 삭제, `MAX_CONCURRENT_LANGUAGES`·단가 추가
- `src/lib/languages.ts` — `resolveDeviceLanguage` 추가, 정규화 규칙 흡수
- `src/lib/translation-bridge.ts` — `usage` 필드 + 누적 호출
- `src/lib/translation-session-manager.ts` — 상한 게이트, `retiredUsage`, flush, `getSessionUsage`
- `src/app/api/translate/route.ts` — 상한 초과 시 409
- `src/app/api/translate/status/route.ts` — 응답에 usage·maxLanguages·estimatedUsd 추가
- `src/app/api/sessions/[sessionId]/route.ts` — 응답에 `maxLanguages` 추가
- `src/app/page.tsx` — `allowedLanguages` 전송 제거, 충전 링크 추가
- `src/app/session/[id]/broadcast/page.tsx` — 계량기 표시
- `src/app/session/[id]/watch/page.tsx` — `maxLanguages`·열린 언어 전달
- `src/app/session/[id]/watch/components/LanguageSelector.tsx` — 휠 사용 + 409 처리

---

## Task 1: 설정 개방 + 랜딩 충전 링크

정적 허용목록을 걷어내고 상한/단가 상수를 추가한다. 랜딩은 `allowedLanguages`를 더 이상 보내지 않고(서버가 `undefined`=전체 허용으로 처리) 충전 링크를 노출한다.

**Files:**
- Modify: `src/lib/interpret-config.ts`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Produces: `MAX_CONCURRENT_LANGUAGES: number`, `GEMINI_LIVE_USD_PER_1M_TOKENS: number | null` (from `interpret-config.ts`)

- [ ] **Step 1: `interpret-config.ts` 상수 교체**

`src/lib/interpret-config.ts`의 3행(`DEFAULT_INTERPRET_LANGUAGES` 줄)을 삭제하고 그 자리에 다음을 넣는다:

```ts
// 세션당 동시에 열 수 있는 청자 언어(=Gemini Live 브릿지) 최대 개수.
// 청자는 79개 전부에서 고를 수 있으나, 동시 개설은 이 수로 제한해 비용 상한을
// 유지한다. 상한에 닿으면 이후 청자는 이미 열린 언어 중에서만 고를 수 있다.
export const MAX_CONCURRENT_LANGUAGES = 8;
```

파일 하단(`MAX_PRESENTATION_BYTES` 다음)에 단가 상수를 추가한다:

```ts
// 사용량 계량을 통화로 환산할 때 쓰는 100만 토큰당 USD 단가. gemini-3.5-live-
// translate-preview는 프리뷰라 공개 단가를 확정할 수 없으므로 env로만 받는다.
// 미설정(null)이면 금액을 표시하지 않고 토큰 수만 노출한다(틀린 금액 방지).
export const GEMINI_LIVE_USD_PER_1M_TOKENS: number | null =
  process.env.GEMINI_LIVE_USD_PER_1M_TOKENS &&
  !Number.isNaN(Number(process.env.GEMINI_LIVE_USD_PER_1M_TOKENS))
    ? Number(process.env.GEMINI_LIVE_USD_PER_1M_TOKENS)
    : null;
```

- [ ] **Step 2: `page.tsx`에서 허용목록 전송 제거**

`src/app/page.tsx` 21행의 import를 삭제한다:

```ts
import { DEFAULT_INTERPRET_LANGUAGES } from "@/lib/interpret-config";
```

141~144행의 다음 블록을 **통째로 삭제**한다:

```ts
      form.append(
        "allowedLanguages",
        JSON.stringify(DEFAULT_INTERPRET_LANGUAGES)
      );
```

- [ ] **Step 3: 랜딩에 충전 링크 추가**

`src/app/page.tsx`에서 `연결 테스트` 버튼과 실패 메시지를 감싸는 `<div style={{ marginBottom: 4 }}>` 블록(212~255행)의 닫는 `</div>` 직전, `{keyStatus === "fail" && (...)}` 다음 줄에 링크를 추가한다:

```tsx
            <div style={{ marginTop: 8, textAlign: "left" }}>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="body-sm"
                style={{ color: "var(--fg-secondary)", textDecoration: "underline" }}
              >
                사용량·충전 →
              </a>
            </div>
```

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음 (특히 `DEFAULT_INTERPRET_LANGUAGES` 미해결 참조가 남지 않아야 함)

- [ ] **Step 5: 잔여 참조 확인**

Run: `grep -rn "DEFAULT_INTERPRET_LANGUAGES" src`
Expected: `translation-session-manager.ts`의 **주석 한 줄**(245행 부근)만 매치. 그 주석 문구에서 `DEFAULT_INTERPRET_LANGUAGES or a` 부분을 `a`로 정리한다(코드 참조 아님, 문구만 수정). 그 외 코드 매치가 있으면 실패이니 제거한다.

- [ ] **Step 6: Commit**

```bash
git add src/lib/interpret-config.ts src/app/page.tsx src/lib/translation-session-manager.ts
git commit -m "feat(config): 청자 언어 개방 — 허용목록 제거·동시 상한/단가 상수 추가·충전 링크"
```

---

## Task 2: 동시 상한 판정 순수 함수

상한 규칙을 매니저 밖의 순수 함수로 만들어 실제 브릿지 없이 테스트한다.

**Files:**
- Create: `src/lib/language-cap.ts`
- Test: `src/lib/language-cap.test.ts`

**Interfaces:**
- Produces:
  - `class LanguageCapReachedError extends Error { readonly openLanguages: string[] }`
  - `function canOpenLanguage(openLanguages: string[], target: string, max: number): boolean`

- [ ] **Step 1: 실패 테스트 작성**

Create `src/lib/language-cap.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test src/lib/language-cap.test.ts`
Expected: FAIL — `Cannot find module './language-cap.ts'`

- [ ] **Step 3: 구현**

Create `src/lib/language-cap.ts`:

```ts
/**
 * 세션당 동시 언어(=Gemini Live 브릿지) 개수 상한을 판정하는 순수 로직.
 * 실제 브릿지를 띄우지 않고 단위 테스트할 수 있도록 매니저에서 분리한다.
 */

export class LanguageCapReachedError extends Error {
  readonly openLanguages: string[];
  constructor(openLanguages: string[]) {
    super("Concurrent language limit reached for this session");
    this.name = "LanguageCapReachedError";
    this.openLanguages = openLanguages;
  }
}

/**
 * target 언어를 새로 열 수 있는지 판정한다.
 * - 이미 열려 있으면 재사용이므로 상한과 무관하게 true(새 자리를 쓰지 않음).
 * - 아니면 현재 열린 개수가 max 미만일 때만 true.
 */
export function canOpenLanguage(
  openLanguages: string[],
  target: string,
  max: number
): boolean {
  if (openLanguages.includes(target)) return true;
  return openLanguages.length < max;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test src/lib/language-cap.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/language-cap.ts src/lib/language-cap.test.ts
git commit -m "feat(cap): 동시 언어 상한 판정 순수 함수 + 테스트"
```

---

## Task 3: 상한 게이트를 매니저·라우트에 배선

**Files:**
- Modify: `src/lib/translation-session-manager.ts`
- Modify: `src/app/api/translate/route.ts`

**Interfaces:**
- Consumes: `canOpenLanguage`, `LanguageCapReachedError` (Task 2), `MAX_CONCURRENT_LANGUAGES` (Task 1)
- Produces: `/api/translate` POST가 상한 초과 시 `409 { error, code: "LANGUAGE_CAP_REACHED", openLanguages: string[] }` 반환

- [ ] **Step 1: 매니저 import 추가**

`src/lib/translation-session-manager.ts`의 import 블록(27~30행 부근)에 추가:

```ts
import { SOURCE_LANGUAGE, MAX_CONCURRENT_LANGUAGES } from "./interpret-config";
import { canOpenLanguage, LanguageCapReachedError } from "./language-cap";
```

(기존 `import { SOURCE_LANGUAGE } from "./interpret-config";` 줄을 위 첫 줄로 교체한다.)

- [ ] **Step 2: `getOrCreate`에 상한 게이트 삽입**

`getOrCreate` 안에서 "기존 브릿지 재사용/정리" 블록(253~272행)이 끝난 직후, `// Create a new bridge` 주석(274행) **바로 앞**에 삽입한다:

```ts
    // 동시 상한 게이트. 이 지점부터 languageMap.set(...)까지 await가 없어
    // 단일 스레드에서 원자적으로 실행되므로, 두 청자가 동시에 마지막 자리를
    // 요청해도 상한을 넘겨 브릿지가 초과 생성되지 않는다.
    const openLanguages = [...(this.translations.get(sessionId)?.keys() ?? [])];
    if (!canOpenLanguage(openLanguages, targetLanguage, MAX_CONCURRENT_LANGUAGES)) {
      throw new LanguageCapReachedError(openLanguages);
    }
```

**주의:** 이 코드와 그 아래 `if (!languageMap) { ... }` / `languageMap.set(...)` 사이에 `await`를 추가하지 말 것. `bridge.start()`의 `await`(307행)는 `languageMap.set` **이후**라 무방하다.

- [ ] **Step 3: 라우트에서 409 변환**

`src/app/api/translate/route.ts` 상단 import에 추가:

```ts
import { LanguageCapReachedError } from "@/lib/language-cap";
```

68~73행의 `getOrCreate` 호출을 try/catch로 감싼다:

```ts
    // Get or create the translation bridge
    let bridge;
    try {
      bridge = await manager.getOrCreate(
        sessionId,
        targetLanguage,
        session.organizerIdentity
      );
    } catch (err) {
      if (err instanceof LanguageCapReachedError) {
        return NextResponse.json(
          {
            error: "이 방송의 동시 통역 언어 정원이 찼습니다. 열려 있는 언어 중에서 선택하세요.",
            code: "LANGUAGE_CAP_REACHED",
            openLanguages: err.openLanguages,
          },
          { status: 409 }
        );
      }
      throw err;
    }
```

(이후 `return NextResponse.json({ translatorIdentity: bridge.identity, ... })`는 그대로 둔다.)

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 5: 기존 테스트 회귀 확인**

Run: `node --test src/lib/*.test.ts`
Expected: 전부 PASS (기존 + Task 2)

- [ ] **Step 6: Commit**

```bash
git add src/lib/translation-session-manager.ts src/app/api/translate/route.ts
git commit -m "feat(cap): getOrCreate 동시 상한 게이트 + translate 라우트 409 처리"
```

---

## Task 4: 사용량 누적 순수 함수

**Files:**
- Create: `src/lib/usage-meter.ts`
- Test: `src/lib/usage-meter.test.ts`

**Interfaces:**
- Produces:
  - `interface UsageTotals { promptTokens: number; responseTokens: number; totalTokens: number }`
  - `function emptyUsage(): UsageTotals`
  - `function accumulateUsage(prev: UsageTotals, message: unknown): UsageTotals`
  - `function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals`
  - `function estimateUsd(totals: UsageTotals, usdPerMillionTokens: number | null): number | null`

- [ ] **Step 1: 실패 테스트 작성**

Create `src/lib/usage-meter.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test src/lib/usage-meter.test.ts`
Expected: FAIL — `Cannot find module './usage-meter.ts'`

- [ ] **Step 3: 구현**

Create `src/lib/usage-meter.ts`:

```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `node --test src/lib/usage-meter.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage-meter.ts src/lib/usage-meter.test.ts
git commit -m "feat(usage): usageMetadata 누적 순수 함수 + 테스트"
```

---

## Task 5: 사용량을 브릿지·매니저에 배선

브릿지가 자기 토큰을 누적하고, 해체 시 매니저의 세션 누계(`retiredUsage`)로 flush한다. `getSessionUsage`가 해체분 + 살아있는 모든 브릿지(청자 번역·호스트 자막·질문)를 합산한다.

**Files:**
- Modify: `src/lib/translation-bridge.ts`
- Modify: `src/lib/translation-session-manager.ts`

**Interfaces:**
- Consumes: `emptyUsage`, `accumulateUsage`, `mergeUsage`, `UsageTotals` (Task 4)
- Produces:
  - `TranslationBridge.usage: UsageTotals` (public 읽기)
  - `TranslationSessionManager.getSessionUsage(sessionId: string): UsageTotals`

- [ ] **Step 1: 브릿지에 usage 필드 + 누적 배선**

`src/lib/translation-bridge.ts` 상단 import에 추가:

```ts
import { emptyUsage, accumulateUsage, type UsageTotals } from "./usage-meter";
```

public 필드 블록(`public subscriberCount: number = 0;` 다음, 70행 부근)에 추가:

```ts
  // 이 브릿지가 Gemini로부터 계량한 세션 누계 토큰. 해체 시 매니저의
  // retiredUsage로 flush된다. usageMetadata는 누계로 오므로 max 누적.
  public usage: UsageTotals = emptyUsage();
```

`handleGeminiMessage`에서 `const message = JSON.parse(data.toString());`(626행) **바로 다음 줄**에 추가:

```ts
      this.usage = accumulateUsage(this.usage, message);
```

- [ ] **Step 2: 매니저 import + SessionInfo 확장**

`src/lib/translation-session-manager.ts` import 블록에 추가:

```ts
import { emptyUsage, mergeUsage, type UsageTotals } from "./usage-meter";
```

`SessionInfo` 인터페이스(`handRaised: HandRaise[];` 필드 근처)에 추가:

```ts
  // 이미 해체된 브릿지들의 토큰 누계. 살아있는 브릿지 usage와 합쳐 세션 총량을
  // 낸다. 이게 없으면 청자가 나가 브릿지가 해체될 때 총량이 거꾸로 줄어든다.
  retiredUsage: UsageTotals;
```

`createSession`의 `info` 객체 리터럴(`handRaised: [],` 옆)에 추가:

```ts
      retiredUsage: emptyUsage(),
```

- [ ] **Step 3: flush 헬퍼 추가**

`translation-session-manager.ts`의 `getActiveTranslations` 메서드 **바로 앞**에 private 헬퍼를 추가한다:

```ts
  // 브릿지를 해체하기 직전에 그 usage를 세션 누계로 옮긴다. 반드시 bridge.stop()
  // 및 맵에서 제거하기 "전"에 호출해, 살아있는 브릿지 합산과 이중 계상되지 않게
  // 한다(옮긴 뒤엔 맵에서 사라지므로 getSessionUsage가 다시 세지 않는다).
  private flushBridgeUsage(sessionId: string, bridge: TranslationBridge): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.retiredUsage = mergeUsage(session.retiredUsage, bridge.usage);
  }
```

- [ ] **Step 4: 모든 해체 지점에서 flush 호출**

같은 파일에서 `await bridge.stop();`가 청자 번역 브릿지를 해체하는 **세 지점**에 각각 그 `await bridge.stop();` **바로 앞** 줄에 `this.flushBridgeUsage(sessionId, bridge);`를 넣는다:

1. `unsubscribe`의 마지막 구독자 해체 (`if (bridge.subscriberCount === 0) { ... await bridge.stop();`)
2. `removeTranslation` (`if (bridge) { await bridge.stop();`)
3. `removeAllTranslations`의 루프 (`for (const [, bridge] of languageMap) { this.flushBridgeUsage(sessionId, bridge); await bridge.stop(); }`)

호스트 자막·질문 브릿지도 `removeAllTranslations`에서 `stopQuestionBridge`/`stopHostTranscription`를 통해 해체되지만, 이들은 `getSessionUsage`가 **살아있는 동안 이미 합산**하고, `removeAllTranslations` 직후 세션 자체가 삭제되어(`this.sessions.delete(sessionId)`) 더는 조회되지 않으므로 별도 flush가 불필요하다. (세션이 사라진 뒤의 누계는 의미가 없다.)

- [ ] **Step 5: `getSessionUsage` 추가**

`getActiveTranslations` 메서드 바로 뒤에 추가:

```ts
  /**
   * 세션의 현재까지 총 토큰 사용량 = 해체된 브릿지 누계(retiredUsage) +
   * 살아있는 모든 브릿지(청자 번역 + 호스트 자막 + 질문)의 usage 합.
   */
  getSessionUsage(sessionId: string): UsageTotals {
    const session = this.sessions.get(sessionId);
    let total = session ? session.retiredUsage : emptyUsage();

    const languageMap = this.translations.get(sessionId);
    if (languageMap) {
      for (const [, bridge] of languageMap) total = mergeUsage(total, bridge.usage);
    }
    const host = this.hostTranscriptions.get(sessionId);
    if (host) total = mergeUsage(total, host.usage);
    const question = this.questionBridges.get(sessionId);
    if (question) total = mergeUsage(total, question.usage);

    return total;
  }
```

(질문 브릿지 맵 이름이 `questionBridges`가 맞는지 확인: 파일 상단 필드 선언에 `private questionBridges: Map<string, TranslationBridge>`가 있다.)

- [ ] **Step 6: 타입 체크 + 회귀 테스트**

Run: `npx tsc --noEmit && node --test src/lib/*.test.ts`
Expected: 타입 에러 없음, 모든 테스트 PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/translation-bridge.ts src/lib/translation-session-manager.ts
git commit -m "feat(usage): 브릿지 usage 누적 + 해체 시 세션 누계 flush + getSessionUsage"
```

---

## Task 6: 방송 패널 계량기 + 상태 엔드포인트

**Files:**
- Modify: `src/app/api/translate/status/route.ts`
- Modify: `src/app/api/sessions/[sessionId]/route.ts`
- Modify: `src/app/session/[id]/broadcast/page.tsx`

**Interfaces:**
- Consumes: `manager.getSessionUsage` (Task 5), `MAX_CONCURRENT_LANGUAGES`·`GEMINI_LIVE_USD_PER_1M_TOKENS` (Task 1), `estimateUsd` (Task 4)
- Produces:
  - `/api/translate/status` 응답: `{ translations, usage: UsageTotals, maxLanguages: number, estimatedUsd: number | null }`
  - `/api/sessions/:id` 응답에 `maxLanguages: number` 추가

- [ ] **Step 1: status 라우트 확장**

`src/app/api/translate/status/route.ts` import에 추가:

```ts
import { MAX_CONCURRENT_LANGUAGES, GEMINI_LIVE_USD_PER_1M_TOKENS } from "@/lib/interpret-config";
import { estimateUsd } from "@/lib/usage-meter";
```

`const translations = manager.getActiveTranslations(sessionId);` 다음, `return` 전에 추가:

```ts
  const usage = manager.getSessionUsage(sessionId);
  const estimatedUsd = estimateUsd(usage, GEMINI_LIVE_USD_PER_1M_TOKENS);

  return NextResponse.json({
    translations,
    usage,
    maxLanguages: MAX_CONCURRENT_LANGUAGES,
    estimatedUsd,
  });
```

(기존 `return NextResponse.json({ translations });`를 위 블록으로 교체.)

- [ ] **Step 2: sessions/:id 라우트에 maxLanguages 추가**

`src/app/api/sessions/[sessionId]/route.ts` import에 추가:

```ts
import { MAX_CONCURRENT_LANGUAGES } from "@/lib/interpret-config";
```

GET의 `return NextResponse.json({ ...safe, ... translations });`(40~47행) 객체에 필드 추가:

```ts
    maxLanguages: MAX_CONCURRENT_LANGUAGES,
```

- [ ] **Step 3: 방송 패널 상태 추가**

`src/app/session/[id]/broadcast/page.tsx`에서 `const [translations, setTranslations] = useState<TranslationInfo[]>([]);`(54행) 다음에 추가:

```ts
  const [usageTokens, setUsageTokens] = useState(0);
  const [estimatedUsd, setEstimatedUsd] = useState<number | null>(null);
  const [maxLanguages, setMaxLanguages] = useState(8);
```

`fetchTranslations` 함수에서 `setTranslations(data.translations || []);`(191행) 다음에 추가:

```ts
      setUsageTokens(data.usage?.totalTokens ?? 0);
      setEstimatedUsd(data.estimatedUsd ?? null);
      setMaxLanguages(data.maxLanguages ?? 8);
```

- [ ] **Step 4: 계량기 렌더**

`src/app/session/[id]/broadcast/page.tsx`의 활성 번역 헤더(`번역 · {translations.length}개`, 807행 부근)를 다음으로 교체한다:

```tsx
          번역 · {translations.length}/{maxLanguages}개
          {usageTokens > 0 && (
            <span
              className="mono"
              style={{ color: "var(--fg-secondary)", fontSize: 12, marginLeft: 8 }}
            >
              · {formatTokens(usageTokens)} 토큰
              {estimatedUsd !== null && ` · 약 $${estimatedUsd.toFixed(2)}`}
            </span>
          )}
```

같은 파일의 컴포넌트 함수 **바깥 상단**(파일의 import 다음)에 헬퍼를 추가한다:

```ts
// 토큰 수를 사람이 읽기 쉬운 축약형으로. 1_250_000 → "1.3M".
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
```

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 6: Commit**

```bash
git add src/app/api/translate/status/route.ts src/app/api/sessions/[sessionId]/route.ts src/app/session/[id]/broadcast/page.tsx
git commit -m "feat(usage): status 엔드포인트에 사용량 노출 + 방송 패널 계량기 표시"
```

---

## Task 7: 기기 언어 정규화 순수 함수

**Files:**
- Modify: `src/lib/languages.ts`
- Test: `src/lib/languages.test.ts`

**Interfaces:**
- Produces: `function resolveDeviceLanguage(tag: string): string | undefined`
- `getLanguageByCode`는 내부적으로 `resolveDeviceLanguage`의 정규화를 재사용(규칙 단일화). 시그니처·반환은 기존과 동일하게 유지.

- [ ] **Step 1: 실패 테스트 작성**

Create `src/lib/languages.test.ts`:

```ts
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
```

주의: `getLanguageByCode("pt")`는 **기존 동작(pt→pt-BR)** 을 보존한다. `resolveDeviceLanguage("pt")`는 기기 언어 해석용이라 `pt-PT`로 다르게 매핑한다 — 두 함수의 목적이 다르므로 의도된 차이다.

- [ ] **Step 2: 실패 확인**

Run: `node --test src/lib/languages.test.ts`
Expected: FAIL — `resolveDeviceLanguage` export 없음

- [ ] **Step 3: 구현**

`src/lib/languages.ts` 하단의 기존 `getLanguageByCode`(104~112행)를 다음으로 **교체**한다:

```ts
const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

/**
 * BCP-47 언어 태그(navigator.language 등)를 이 앱의 지원 코드로 정규화한다.
 * 지원 목록에 없으면 undefined. 휠을 기기 언어 위치에서 열기 위해 쓴다.
 */
export function resolveDeviceLanguage(tag: string): string | undefined {
  const raw = (tag || "").trim().toLowerCase();
  if (!raw) return undefined;
  const parts = raw.split("-");
  const base = parts[0];

  // 중국어: 스크립트/지역으로 간체·번체 판별
  if (base === "zh") {
    if (raw.includes("hant") || parts.includes("tw") || parts.includes("hk") || parts.includes("mo")) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }
  // 포르투갈어: 브라질만 pt-BR, 나머지(pt/pt-pt 등)는 pt-PT
  if (base === "pt") {
    return parts.includes("br") ? "pt-BR" : "pt-PT";
  }
  // 레거시 별칭
  if (base === "nb") return "no";
  if (base === "iw") return "he";

  return SUPPORTED_CODES.has(base) ? base : undefined;
}

export function getLanguageByCode(code: string): Language | undefined {
  const normalized =
    code === "nb" ? "no" :
    code === "iw" ? "he" :
    code === "zh" ? "zh-Hans" :
    code === "pt" ? "pt-BR" :
    code;
  return SUPPORTED_LANGUAGES.find((lang) => lang.code === normalized);
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test src/lib/languages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/languages.ts src/lib/languages.test.ts
git commit -m "feat(i18n): resolveDeviceLanguage — 기기 언어를 지원 코드로 정규화 + 테스트"
```

---

## Task 8: 청자 언어 휠 컴포넌트

바텀시트 + scroll-snap 휠. 기기 언어 위치 자동 스크롤, 검색, A-2 정원 마감 표시, 접근성용 숨김 `<select>`.

**Files:**
- Create: `src/app/session/[id]/watch/components/LanguageWheel.tsx`

**Interfaces:**
- Consumes: `SUPPORTED_LANGUAGES`, `Language`, `resolveDeviceLanguage` (Task 7)
- Produces: default export `LanguageWheel`
  ```ts
  interface LanguageWheelProps {
    open: boolean;
    languages: Language[];        // 후보(보통 SUPPORTED_LANGUAGES)
    openLanguages: string[];      // 현재 세션에서 이미 열린 언어 코드
    capReached: boolean;          // 정원(maxLanguages)이 찼는지
    value: string;                // 현재 선택("original" 또는 코드)
    onSelect: (code: string) => void;  // "original" 또는 언어 코드
    onClose: () => void;
  }
  ```

- [ ] **Step 1: 컴포넌트 작성**

Create `src/app/session/[id]/watch/components/LanguageWheel.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SUPPORTED_LANGUAGES,
  resolveDeviceLanguage,
  type Language,
} from "@/lib/languages";

interface LanguageWheelProps {
  open: boolean;
  languages?: Language[];
  openLanguages: string[];
  capReached: boolean;
  value: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}

// 정원이 찼고 아직 안 열린 언어는 선택 불가(A-2). 이미 열린 언어와 원본은 항상 가능.
function isDisabled(code: string, openLanguages: string[], capReached: boolean): boolean {
  if (code === "original") return false;
  if (!capReached) return false;
  return !openLanguages.includes(code);
}

export default function LanguageWheel({
  open,
  languages = SUPPORTED_LANGUAGES,
  openLanguages,
  capReached,
  value,
  onSelect,
  onClose,
}: LanguageWheelProps) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return languages;
    return languages.filter(
      (l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)
    );
  }, [languages, query]);

  // 열릴 때: 검색 초기화 + 기기 언어(또는 현재 선택) 위치로 스크롤.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const target =
      (value !== "original" && value) ||
      resolveDeviceLanguage(typeof navigator !== "undefined" ? navigator.language : "") ||
      "";
    if (!target) return;
    // 렌더 후 DOM에서 해당 항목을 찾아 가운데로.
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-code="${target}"]`);
      el?.scrollIntoView({ block: "center" });
    });
  }, [open, value]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="언어 선택"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg, #fff)",
          width: "100%",
          maxHeight: "70vh",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          display: "flex",
          flexDirection: "column",
          padding: "16px 16px 24px",
        }}
      >
        <input
          className="input-field"
          placeholder="언어 검색 / search language"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          style={{ marginBottom: 12 }}
        />

        {/* 원본 오디오 — 번역 언어가 아니라 모드이므로 휠 위 고정 항목 */}
        <button
          type="button"
          onClick={() => {
            onSelect("original");
            onClose();
          }}
          className="btn btn-outline"
          style={{
            justifyContent: "flex-start",
            fontWeight: value === "original" ? 700 : 400,
            marginBottom: 8,
          }}
        >
          원본 오디오 {value === "original" ? "✓" : ""}
        </button>

        <div
          ref={listRef}
          style={{
            overflowY: "auto",
            scrollSnapType: "y proximity",
            borderTop: "1px solid var(--border)",
          }}
        >
          {filtered.map((lang) => {
            const disabled = isDisabled(lang.code, openLanguages, capReached);
            const selected = value === lang.code;
            return (
              <button
                key={lang.code}
                data-code={lang.code}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onSelect(lang.code);
                  onClose();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "12px 8px",
                  scrollSnapAlign: "center",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  textAlign: "left",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.4 : 1,
                  fontWeight: selected ? 700 : 400,
                }}
              >
                <span>{lang.flag}</span>
                <span style={{ flex: 1 }}>{lang.name}</span>
                {selected && <span>✓</span>}
                {disabled && (
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--fg-secondary)" }}
                  >
                    정원 마감
                  </span>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="body-sm" style={{ padding: "16px 8px", color: "var(--fg-secondary)" }}>
              일치하는 언어가 없습니다.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 3: Commit**

```bash
git add "src/app/session/[id]/watch/components/LanguageWheel.tsx"
git commit -m "feat(watch): 청자 언어 휠 바텀시트 컴포넌트(기기언어 자동 위치·검색·정원마감 표시)"
```

---

## Task 9: LanguageSelector를 휠로 교체 + 409 처리 + watch 배선

네이티브 `<select>`를 "현재 선택 버튼 + 휠"로 바꾸되, 접근성용 숨김 `<select>`를 병행한다. 구독/해지 로직은 유지. 상한 409 응답을 처리한다. watch 페이지가 `maxLanguages`·열린 언어를 내려준다.

**Files:**
- Modify: `src/app/session/[id]/watch/components/LanguageSelector.tsx`
- Modify: `src/app/session/[id]/watch/page.tsx`

**Interfaces:**
- Consumes: `LanguageWheel` (Task 8), `SUPPORTED_LANGUAGES`·`getLanguageByCode` (기존)
- `LanguageSelector`에 props 추가: `maxLanguages?: number`, `openLanguages?: string[]`, `onOpenWheel?: () => void`

- [ ] **Step 1: watch 페이지에서 열린 언어·maxLanguages 상태화**

`src/app/session/[id]/watch/page.tsx`에서 `const [allowedLanguages, ...]`(112행) 다음에 추가:

```ts
  const [maxLanguages, setMaxLanguages] = useState(8);
  const [openLanguages, setOpenLanguages] = useState<string[]>([]);
```

`fetchSessionDetails`(116~131행)의 `setAllowedLanguages(data.allowedLanguages);` 다음에 추가:

```ts
          setMaxLanguages(data.maxLanguages ?? 8);
          setOpenLanguages(
            Array.isArray(data.translations)
              ? data.translations.map((t: { language: string }) => t.language)
              : []
          );
```

`fetchSessionDetails()`를 열린 언어가 최신이도록, 마운트 1회에 더해 **주기 폴링**한다. `useEffect`의 `fetchSessionDetails();`(130행) 다음에 인터벌을 추가하고 cleanup을 반환한다:

```ts
    fetchSessionDetails();
    const t = setInterval(fetchSessionDetails, 5000);
    return () => clearInterval(t);
```

- [ ] **Step 2: LanguageSelector에 휠 배선**

`src/app/session/[id]/watch/components/LanguageSelector.tsx` import에 추가:

```ts
import LanguageWheel from "./LanguageWheel";
```

Props 인터페이스(`allowedLanguages?: string[];` 옆)에 추가:

```ts
  maxLanguages?: number;
  openLanguages?: string[];
```

컴포넌트 시그니처 구조분해에 추가하고, 내부 상태에 휠 열림 상태를 추가한다(`const [loading, ...]` 근처):

```ts
  const [wheelOpen, setWheelOpen] = useState(false);
```

- [ ] **Step 3: 선택 핸들러를 코드 기반으로 리팩터**

기존 `handleChange`(`async (e: React.ChangeEvent<HTMLSelectElement>) => {`, 70행)를 코드 문자열을 받는 `applyLanguage`로 바꾼다. 첫 줄의 `const langCode = e.target.value;`를 파라미터로 대체하고, 나머지 본문은 유지하되 409를 처리한다:

```ts
  const applyLanguage = useCallback(
    async (langCode: string) => {
      const previousLanguage = activeLanguageRef.current;
      setError(null);

      if (langCode === "original") {
        if (previousLanguage && previousLanguage !== "original") {
          fetch("/api/translate", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, targetLanguage: previousLanguage }),
          }).catch(() => {});
        }
        onLanguageChange("original", null);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            targetLanguage: langCode,
            previousLanguage:
              previousLanguage !== "original" ? previousLanguage : undefined,
          }),
        });
        const data = await res.json();

        if (res.status === 409 && data.code === "LANGUAGE_CAP_REACHED") {
          // 정원 마감: 열린 언어 목록을 즉시 반영하고 안내(폴링을 안 기다림).
          setError("정원이 찼습니다 — 열려 있는 언어 중에서 선택하세요.");
          if (Array.isArray(data.openLanguages)) {
            onCapUpdate?.(data.openLanguages);
          }
          return;
        }
        if (!res.ok) throw new Error(data.error || "Translation request failed");

        onLanguageChange(langCode, data.translatorIdentity);
      } catch (err) {
        setError((err as Error).message);
        console.error("Translation request error:", err);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, onLanguageChange, onCapUpdate]
  );
```

Props 인터페이스와 구조분해에 `onCapUpdate?: (openLanguages: string[]) => void;`를 추가한다.

- [ ] **Step 4: `<select>`를 트리거 버튼 + 휠 + 숨김 select로 교체**

`return (...)` 안의 `<div style={{ position: "relative" }}>...</div>` 블록(134~161행, 즉 `<select>`와 로딩 스피너 래퍼)을 다음으로 교체한다:

```tsx
      <div style={{ position: "relative" }}>
        {/* 표시용 트리거: 누르면 휠이 열린다 */}
        <button
          type="button"
          className="select-field"
          onClick={() => setWheelOpen(true)}
          disabled={loading || disabled}
          style={{
            width: "100%",
            textAlign: "left",
            opacity: loading || disabled ? 0.5 : 1,
            cursor: loading || disabled ? "not-allowed" : "pointer",
          }}
        >
          {currentLanguage === "original"
            ? "원본 오디오"
            : currentLang
            ? `${currentLang.name} ${currentLang.flag}`
            : currentLanguage}
        </button>

        {/* 접근성: 키보드·스크린리더용 네이티브 select(시각적으로만 숨김) */}
        <select
          aria-label="Language"
          value={currentLanguage}
          onChange={(e) => applyLanguage(e.target.value)}
          disabled={loading || disabled}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          <option value="original">원본 오디오</option>
          {visibleLanguages.map((lang) => (
            <option
              key={lang.code}
              value={lang.code}
              disabled={
                (maxLanguages ?? 8) <= (openLanguages?.length ?? 0) &&
                !(openLanguages ?? []).includes(lang.code)
              }
            >
              {lang.name} {lang.flag}
            </option>
          ))}
        </select>

        {loading && (
          <div style={{ position: "absolute", right: 40, top: "50%", transform: "translateY(-50%)" }}>
            <span className="spinner" />
          </div>
        )}
      </div>

      <LanguageWheel
        open={wheelOpen}
        languages={visibleLanguages}
        openLanguages={openLanguages ?? []}
        capReached={(maxLanguages ?? 8) <= (openLanguages?.length ?? 0)}
        value={currentLanguage}
        onSelect={applyLanguage}
        onClose={() => setWheelOpen(false)}
      />
```

- [ ] **Step 5: watch 페이지에서 새 props 전달**

`src/app/session/[id]/watch/page.tsx`의 `<LanguageSelector ... />`(542~548행)에 props를 추가한다:

```tsx
        <LanguageSelector
          sessionId={sessionId}
          currentLanguage={currentLanguage}
          onLanguageChange={handleLanguageChange}
          disabled={false}
          allowedLanguages={allowedLanguages}
          maxLanguages={maxLanguages}
          openLanguages={openLanguages}
          onCapUpdate={setOpenLanguages}
        />
```

- [ ] **Step 6: 타입 체크 + 전체 테스트**

Run: `npx tsc --noEmit && node --test src/lib/*.test.ts`
Expected: 타입 에러 없음, 모든 테스트 PASS

- [ ] **Step 7: 린트 + 빌드**

Run: `npm run lint && npm run build`
Expected: 경고·에러 없이 빌드 성공

- [ ] **Step 8: Commit**

```bash
git add "src/app/session/[id]/watch/components/LanguageSelector.tsx" "src/app/session/[id]/watch/page.tsx"
git commit -m "feat(watch): 언어 선택을 휠로 교체 + 정원마감(409) 처리 + 접근성 숨김 select 병행"
```

---

## Task 10: 문서 마무리

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: 단가 env 문서화**

`.env.example`에 항목을 추가한다:

```
# 사용량 계량을 통화로 환산할 100만 토큰당 USD 단가(선택). 미설정 시 방송
# 패널은 금액 없이 토큰 수만 표시한다. gemini-3.5-live-translate-preview는
# 프리뷰라 공개 단가가 확정되지 않아 기본값을 두지 않는다.
# GEMINI_LIVE_USD_PER_1M_TOKENS=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): GEMINI_LIVE_USD_PER_1M_TOKENS 단가 env 문서화"
```

---

## 최종 검증 (모든 태스크 후)

- [ ] `npx tsc --noEmit` — 타입 에러 0
- [ ] `node --test src/lib/*.test.ts` — 신규 3개 파일 포함 전부 PASS
- [ ] `npm run lint` — 경고 0
- [ ] `npm run build` — 성공
- [ ] `grep -rn "DEFAULT_INTERPRET_LANGUAGES" src` — 매치 0
- [ ] 수동 QA (스펙의 수동 QA 항목):
  - 청자 모바일에서 휠이 기기 언어 위치에서 열림(iOS·Android)
  - 8개를 채운 뒤 9번째 청자 화면에서 미개설 언어가 흐리게 + `정원 마감` 배지
  - 8/8 상태에서 유일 구독자가 언어를 바꾸면 성공(자기 자리 회수)
  - 청중이 나가면 방송 패널 언어 수가 줄고 토큰 누계는 줄지 않음
  - 키보드만으로 언어 선택 가능(숨김 select 경로)
  - 랜딩 `사용량·충전 →` 링크가 새 탭으로 AI Studio 키 페이지를 연다

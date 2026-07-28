# 청자 언어 전면 개방(휠 선택) + 사용량 계량기 설계

- 날짜: 2026-07-28
- 범위: ① 언어 개방 + 동시 상한, ② 사용량 계량, ③ 방송 패널 계량기, ④ 랜딩 충전 링크, ⑤ 청자 휠 UI

## 배경

청자는 현재 5개 언어(`DEFAULT_INTERPRET_LANGUAGES = ["en","zh-Hans","ja","vi","ru"]`) 중에서만 고를 수 있다. 목록이 부족한 게 아니라 — [languages.ts](../../src/lib/languages.ts)의 `SUPPORTED_LANGUAGES`에는 이미 79개가 있다 — [page.tsx:141](../../src/app/page.tsx:141)이 세션 생성 시 이 5개를 `allowedLanguages`로 고정 전송하기 때문이다.

이 제한은 실수가 아니라 **의도된 비용 상한**이었다. [2026-07-15 스펙](../superpowers/specs/2026-07-15-host-transcription-and-landing-simplify-design.md)에 "비용은 최대 4개 언어로 예측 가능하게 유지됨"이라고 명시돼 있고, 청자가 고른 언어 하나당 Gemini Live 브릿지가 하나씩 뜬다.

따라서 언어를 열려면 비용 상한을 다른 형태로 되돌려놔야 한다. 이 스펙은 **정적 허용목록을 동시 상한으로 교체**하고, 강사가 실제 지출을 볼 수 있는 **계량기**를 함께 넣는다.

### "잔액 조회"를 하지 않는 이유

원래 요청은 "남은 금액 표시"였으나 기술적으로 불가능하다:

- AI Studio에서 발급한 Gemini API 키에는 잔액/크레딧 조회 엔드포인트가 없다. 키는 모델 호출 권한만 부여한다.
- Cloud Billing API는 API 키로 인증되지 않고 OAuth/서비스 계정(`billing.viewer`)을 요구한다. 게다가 GCP는 후불제라 "잔액"이라는 값 자체가 존재하지 않고 *누적 사용액*만 나온다. 무료 체험 크레딧 잔액은 콘솔에서만 확인된다.

강사가 실제로 알고 싶은 것(**이 방송에 돈이 얼마나 나가는가**)은 우리가 직접 계량해서 답한다. Gemini Live 응답에 `usageMetadata`가 실려 오는데 현재 [translation-bridge.ts:626](../../src/lib/translation-bridge.ts:626)에서 파싱만 하고 버리고 있다.

## 결정 요약

| 항목 | 결정 |
|---|---|
| 청자 언어 | 79개 전부 개방 |
| 비용 상한 | 세션당 동시 8개 언어 (`MAX_CONCURRENT_LANGUAGES`) |
| 정원 마감 시 | 미개설 언어를 흐리게 + 배지 표시, 선택 불가 (숨기지 않음) |
| 잔액 | 조회 불가 — 대신 세션 실사용량 계량 |
| 금액 표시 | 단가 env 설정 시에만. 미설정이면 토큰 수만 |
| 충전 링크 | `https://aistudio.google.com/app/apikey` |
| 청자 UI | 커스텀 바텀시트 휠 + 기기 언어 자동 위치 + 검색 |

## 아키텍처 제약

테스트 러너가 `node --test src/lib/*.test.ts`라 **React 컴포넌트 테스트 인프라가 없다.** 따라서 판정·누적·정규화 로직은 전부 `src/lib/`의 순수 함수로 분리하고, 컴포넌트는 그 함수를 호출하는 얇은 껍데기로 유지한다. 이 경계가 이 설계의 테스트 가능성을 결정한다.

---

## ① 언어 개방 + 동시 상한

`allowedLanguages`(정적 허용목록)와 동시 상한은 **서로 다른 층위**이며 둘 다 유지한다:

- **허용목록** — "애초에 어떤 언어가 가능한가". 랜딩은 더 이상 보내지 않아 `undefined`(=79개 전부)가 된다. `/api/sessions`는 계속 이 필드를 받으므로, 기관 배포에서 언어를 제한하고 싶으면 API로 지정할 수 있다.
- **동시 상한** — "동시에 몇 개까지 여는가". 항상 적용된다.

두 게이트는 충돌 없이 합성된다: 허용목록이 후보를 정하고, 상한이 동시 개수를 정한다.

### 변경

**[src/lib/interpret-config.ts](../../src/lib/interpret-config.ts)**

- `DEFAULT_INTERPRET_LANGUAGES` **삭제** — 유일한 사용처가 랜딩이었다. ([manager:245](../../src/lib/translation-session-manager.ts:245)의 주석에도 이름이 등장하므로 함께 정리한다.)
- `MAX_CONCURRENT_LANGUAGES = 8` 추가.

**[src/app/page.tsx](../../src/app/page.tsx)**

- `DEFAULT_INTERPRET_LANGUAGES` import 제거, `form.append("allowedLanguages", ...)` 제거(141~144행).

**신규 [src/lib/language-cap.ts](../../src/lib/language-cap.ts)** — 판정만 담당하는 순수 함수:

```
export class LanguageCapReachedError extends Error { openLanguages: string[] }
export function canOpenLanguage(
  openLanguages: string[], target: string, max: number
): boolean
```

`target`이 이미 열려 있으면 `max`와 무관하게 `true`(재사용은 새 자리를 쓰지 않는다). 아니면 `openLanguages.length < max`. 상한 규칙을 매니저 밖에 두어야 실제 브릿지를 띄우지 않고 단위 테스트할 수 있다.

**[src/lib/translation-session-manager.ts](../../src/lib/translation-session-manager.ts)**

`getOrCreate`의 "기존 브릿지 재사용" 블록 직후, `new TranslationBridge(...)` 직전(현재 274행 위치)에 이 함수를 호출한다:

```
const open = [...(this.translations.get(sessionId)?.keys() ?? [])]
if (!canOpenLanguage(open, targetLanguage, MAX_CONCURRENT_LANGUAGES))
  throw new LanguageCapReachedError(open)
```

**이 위치가 경쟁 조건을 해소한다.** 274행부터 `languageMap.set(targetLanguage, bridge)`(304행)까지 `await`가 하나도 없어 동일한 동기 블록에 묶인다. Node의 단일 스레드 이벤트 루프에서 이 구간은 원자적이므로, 두 청자가 동시에 마지막 자리를 요청해도 9번째 브릿지가 생기지 않는다.

재사용 경로(257~263행)와 죽은 브릿지 정리 경로(265~271행)는 이미 열린 언어를 다루므로 새 자리를 소비하지 않는다 — 검사 이전에 그대로 통과시킨다.

`LanguageCapReachedError`는 `openLanguages: string[]`를 실어 라우트가 청자에게 전달할 수 있게 한다.

**[src/app/api/translate/route.ts](../../src/app/api/translate/route.ts)**

- 기존 허용목록 검사(42~52행)는 **유지**한다.
- `getOrCreate` 호출을 `try/catch`로 감싸 `LanguageCapReachedError`를 `409`로 변환:
  `{ error, code: "LANGUAGE_CAP_REACHED", openLanguages }`
- **`previousLanguage` 해지를 먼저 하는 현재 순서(55~57행)를 반드시 유지한다.** 8/8 상태에서 언어를 바꾸는 청자가 자기가 비운 자리로 들어갈 수 있어야 하기 때문이다. 이 순서가 깨지면 마지막 자리를 차지한 청자가 영원히 언어를 못 바꾼다.

### 정원 회수

별도 로직이 필요 없다. 브릿지는 이미 참조 카운트로 관리되어 구독자가 0이 되면 해체되고([manager:468](../../src/lib/translation-session-manager.ts:468)) `onStop`이 `languageMap`에서 항목을 지운다(286~297행). 즉 청중이 나가면 정원이 자동으로 빈다.

---

## ② 사용량 계량

### 신규: [src/lib/usage-meter.ts](../../src/lib/usage-meter.ts)

```
export interface UsageTotals { promptTokens: number; responseTokens: number; totalTokens: number }
export function emptyUsage(): UsageTotals
export function accumulateUsage(prev: UsageTotals, message: unknown): UsageTotals
export function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals
export function estimateUsd(totals: UsageTotals, usdPerMillionTokens: number | null): number | null
```

`accumulateUsage`는 임의의 파싱된 메시지를 받아 `usageMetadata`가 없으면 `prev`를 그대로 돌려준다. Gemini Live는 누적값을 보내는지 증분값을 보내는지 필드마다 다를 수 있으므로, **`totalTokenCount`를 누적 최대값으로 취급**한다(`max(prev, incoming)`). 증분으로 오해해 더하면 값이 부풀려진다. 순수 함수이므로 실제 응답 샘플로 테스트에서 고정한다.

`estimateUsd`는 단가가 `null`이면 `null`을 반환한다 — 호출부는 이 경우 금액을 렌더하지 않는다.

### [src/lib/translation-bridge.ts](../../src/lib/translation-bridge.ts)

- 인스턴스 필드 `usage: UsageTotals` 추가.
- 626행의 메시지 파싱 직후 `this.usage = accumulateUsage(this.usage, message)` 호출. 기존 분기 로직은 건드리지 않는다.

### [src/lib/translation-session-manager.ts](../../src/lib/translation-session-manager.ts)

- `SessionInfo`에 `retiredUsage: UsageTotals` 추가 — **해체된 브릿지의 누계**.
- 브릿지 해체 시(`onStop` 및 `unsubscribe`의 teardown 경로) 해당 브릿지의 `usage`를 `retiredUsage`로 flush한다. **이 flush가 없으면 청중이 나갈 때 강사 화면의 숫자가 거꾸로 줄어든다.**
- `getSessionUsage(sessionId): UsageTotals` 추가 = `retiredUsage` + 살아있는 모든 브릿지의 `usage` 합계. 청자 번역 브릿지뿐 아니라 **호스트 자막 브릿지(`hostTranscriptions`)와 질문 브릿지(`questionBridges`)도 포함**한다 — 셋 다 같은 키로 과금된다.

flush와 합산 경로가 겹쳐 이중 계상되지 않도록, flush 시점에 브릿지를 맵에서 제거한 뒤 `retiredUsage`에 더하는 순서를 지킨다.

### 단가

**[src/lib/interpret-config.ts](../../src/lib/interpret-config.ts)**에 추가:

```
export const GEMINI_LIVE_USD_PER_1M_TOKENS =
  process.env.GEMINI_LIVE_USD_PER_1M_TOKENS
    ? Number(process.env.GEMINI_LIVE_USD_PER_1M_TOKENS)
    : null;
```

`gemini-3.5-live-translate-preview`는 프리뷰 모델이라 공개 단가를 확정할 수 없다. 코드에 단가를 박으면 강사에게 **틀린 금액**을 보여주게 되므로, 미설정 시에는 금액을 표시하지 않고 토큰 수만 노출한다. `.env.example`에 주석과 함께 항목을 추가한다.

---

## ③ 방송 패널 계량기

발표자 페이지는 이미 `/api/translate/status`를 주기 폴링하고 있고, 이 폴링이 리퍼의 심장박동 역할까지 한다([status/route.ts](../../src/app/api/translate/status/route.ts)). 새 엔드포인트나 새 폴링을 만들지 않고 여기에 얹는다.

**응답 확장**: `{ translations, usage, maxLanguages, estimatedUsd }`
(`estimatedUsd`는 단가 미설정 시 `null`)

**[src/app/session/[id]/broadcast/page.tsx](../../src/app/session/[id]/broadcast/page.tsx)** 표시:

- 단가 설정됨: `언어 3/8 · 1.2M 토큰 · 약 $1.80`
- 단가 미설정: `언어 3/8 · 1.2M 토큰`

`약`이라는 접두사를 반드시 유지한다 — 추정치임을 표시에서 드러낸다.

---

## ④ 랜딩 충전 링크

**[src/app/page.tsx](../../src/app/page.tsx)** — `연결 테스트` 버튼 아래에 링크 추가:

```
사용량·충전 →   → https://aistudio.google.com/app/apikey  (target="_blank" rel="noopener noreferrer")
```

BYOK 키를 발급받은 화면이라 강사에게 익숙하고, 거기서 결제 설정으로 이어진다. 키 상태와 무관하게 항상 노출한다(키가 실패했을 때야말로 필요하다).

---

## ⑤ 청자 휠 UI

### 신규: [src/app/session/[id]/watch/components/LanguageWheel.tsx](../../src/app/session/[id]/watch/components/LanguageWheel.tsx)

바텀시트 + CSS `scroll-snap` 휠. 상단에 검색 입력.

**Props**: `languages`, `openLanguages`, `capReached`, `value`, `onChange`, `onClose`

**동작**:

- 열릴 때 **기기 언어 위치로 스크롤**한다. 79개를 손으로 넘기게 하지 않는 것이 이 설계의 핵심이다 — 청중은 QR을 찍고 들어온 모바일 사용자다.
- 검색어 입력 시 휠 항목을 필터링한다.
- **정원 마감 표시(A-2)**: `capReached && !openLanguages.includes(code)`인 언어는 흐리게 렌더하고 `정원 마감` 배지를 붙이며 선택을 막는다. 목록에서 **숨기지 않는다** — 자기 언어가 왜 없는지 청자가 이해해야 강사에게 요청이라도 할 수 있다.
- `원본 오디오`는 휠 안이 아니라 시트 상단의 고정 항목으로 둔다(번역 언어가 아니라 모드이므로).

### 접근성

네이티브 `<select>`를 버리면 키보드 조작과 스크린리더 지원을 직접 구현해야 한다. **시각적으로 숨긴 `<select>`를 같은 상태로 동기화해 함께 렌더**하는 방식으로 해결한다 — 보조기술 사용자에게는 원래의 완전한 네이티브 경험이 남고, 구현 부담은 최소다. 숨김은 `display:none`이 아니라 clip 방식(스크린리더가 읽을 수 있어야 함)을 쓴다.

### [src/lib/languages.ts](../../src/lib/languages.ts)

`resolveDeviceLanguage(tag: string): string | undefined` 추가 — `navigator.language`를 우리 코드로 정규화한다.

- 지역코드 분리: `ru-RU`→`ru`, `en-GB`→`en`, `de-AT`→`de`
- 중국어 스크립트 구분: `zh-CN`/`zh-SG`/`zh-Hans-*`→`zh-Hans`, `zh-TW`/`zh-HK`/`zh-Hant-*`→`zh-Hant`
- 포르투갈어: `pt-BR`→`pt-BR`, `pt`/`pt-PT`→`pt-PT`
- 기존 별칭(`nb`→`no`, `iw`→`he`) 유지
- 지원 목록에 없으면 `undefined` → 호출부는 휠을 목록 처음에서 연다

`getLanguageByCode`의 기존 정규화 로직을 이 함수로 흡수해 정규화 규칙이 한 곳에만 존재하게 한다.

### [src/app/session/[id]/watch/components/LanguageSelector.tsx](../../src/app/session/[id]/watch/components/LanguageSelector.tsx)

`<select>`(135행)를 "현재 선택 표시 버튼 + `LanguageWheel`"로 교체한다. **구독/해지 로직(50~120행)은 그대로 유지**한다 — `sendBeacon` 해지와 언어 전환 시 이전 언어 해지는 이미 올바르게 동작하고 있다.

추가로 `409 LANGUAGE_CAP_REACHED` 응답을 처리해 "정원이 찼습니다 — 열려 있는 언어 중에서 선택하세요" 안내를 띄우고, 응답의 `openLanguages`로 휠 상태를 즉시 갱신한다(폴링을 기다리지 않는다).

### [src/app/api/sessions/[sessionId]/route.ts](../../src/app/api/sessions/[sessionId]/route.ts)

응답에 `maxLanguages: MAX_CONCURRENT_LANGUAGES` 추가. 열린 언어 목록은 기존 `translations`로 이미 나가고 있다.

### [src/app/session/[id]/watch/page.tsx](../../src/app/session/[id]/watch/page.tsx)

`maxLanguages`와 열린 언어를 상태로 받아 `LanguageSelector`에 내린다(현재 `allowedLanguages`를 내리는 경로 112~122·547행 확장).

---

## 테스트

`node --test src/lib/*.test.ts`로 검증하는 순수 함수 3종:

**`src/lib/usage-meter.test.ts`** (신규)
- `usageMetadata` 없는 메시지는 누계를 바꾸지 않는다
- 누적값 의미론: 더 작은 `totalTokenCount`가 와도 누계가 줄지 않는다
- `mergeUsage`가 필드별로 합산한다
- `estimateUsd`가 단가 `null`일 때 `null`을 반환한다

**`src/lib/languages.test.ts`** (신규)
- `ru-RU`→`ru`, `en-GB`→`en`
- `zh-CN`→`zh-Hans`, `zh-TW`→`zh-Hant`
- `pt`→`pt-PT`, `pt-BR`→`pt-BR`
- `nb`→`no`, `iw`→`he`
- 미지원 태그(`xx-YY`)는 `undefined`

**`src/lib/language-cap.test.ts`** (신규)
- 8개가 열린 상태에서 9번째 언어는 `canOpenLanguage`가 `false`
- 이미 열린 언어의 재요청은 상한이 찼어도 `true` (재사용은 자리를 안 씀)
- 7개일 때 8번째는 `true`
- `LanguageCapReachedError`가 `openLanguages`를 보존한다

### 수동 QA

- 청자 모바일에서 휠이 기기 언어 위치에서 열린다(iOS·Android 각 1회)
- 8개를 채운 뒤 9번째 청자 화면에서 미개설 언어가 흐리게 + 배지로 보인다
- 8/8 상태에서 유일한 구독자가 언어를 바꾸면 성공한다(자기 자리 회수)
- 청중이 나가면 방송 패널의 언어 수가 줄고 토큰 누계는 줄지 않는다
- 키보드만으로 언어 선택이 가능하다(숨김 `<select>` 경로)

## 범위 밖

- Cloud Billing 연동 및 실제 잔액 조회 — 위 "배경"의 사유로 불가
- 언어별 비용 분해(어느 언어가 얼마를 썼는지)
- 상한 도달 시 강사에게 알림 / 강사가 상한을 실시간 조정
- 휠 컴포넌트 자동화 테스트 — React 테스트 인프라 도입은 별도 작업

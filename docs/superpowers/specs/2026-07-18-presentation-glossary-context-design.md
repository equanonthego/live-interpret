# 발표자료 기반 용어집·맥락 주입 (스펙 1)

- 날짜: 2026-07-18
- 상태: 설계 승인 대기
- 관련: 스펙 2(발표자료 화면 표시 + 자막 오버레이)의 토대. 이 스펙은 업로드·추출·주입까지만 다룬다.

## 1. 목적

강의 통역 정확도를 높인다. 발표자가 강의자료(PDF)를 올리면, 별도 AI 모델이 그 자료에서 **도메인 맥락 요약 + 용어집**을 추출하고, 이를 Gemini 3.5 Live 번역 세션에 컨텍스트로 주입해 전문 용어를 일관되고 정확하게 번역한다.

성공 기준:
- PDF를 올린 세션에서, 자료에 등장하는 전문 용어가 컨텍스트 없이 번역할 때보다 일관되고 정확하게 번역된다.
- PDF를 올리지 않으면 기존 세션 생성 흐름이 그대로 동작한다(회귀 없음).

## 2. 검증된 전제 (spike 완료)

Gemini 3.5 Live translate-preview 모델이 setup의 `systemInstruction`을 **번역에 실제로 반영**함을 실측으로 확인했다. 임시로 "회사 → ACME_CORP" 규칙을 주입하자 영어 출력이 규칙대로 나왔다. 따라서 주입 방식은 `systemInstruction`으로 확정한다(대안 프라이밍 불필요).

## 3. 아키텍처 (2-모델)

```
발표자 홈 (page.tsx)
  [Google API Key] [PDF 업로드(선택)] → [세션 만들기]
        │ PDF 있으면 함께 전송
        ▼
POST /api/sessions  (멀티파트 FormData로 PDF 포함)
  ① 원본 PDF 보관 (스펙 2 화면 표시용)
  ② Gemini Flash 호출: PDF → { domainSummary, glossary[] } (구조화 JSON)
  ③ 세션에 glossaryContext 저장
        ▼
언어별 TranslationBridge 생성 시 glossaryContext 주입
  → sendGeminiSetup 의 systemInstruction 으로 조립  ✅ 검증됨
  → 용어집·맥락 반영 번역
```

역할 분리:
- **추출**: Gemini Flash 계열(PDF 네이티브 입력 지원, 저지연·저비용). 세션당 1회.
- **번역**: 기존 Gemini 3.5 Live. 추출물을 systemInstruction으로 소비만 한다.

## 4. 컴포넌트

### 4.1 홈 화면 (`src/app/page.tsx`)
- 기존 "이벤트 ID" 입력을 **PDF 업로드(선택)** 로 대체/보강.
- PDF 선택 시 파일명 표시. `세션 만들기` 클릭 → 업로드+추출 진행 표시(수 초 로딩). PDF 없으면 즉시 기존 흐름.
- 파일 형식: PDF만(스펙 1). 크기 상한 예: 20MB(구현 시 확정).

### 4.2 세션 생성 API (`src/app/api/sessions`)
- PDF를 함께 받도록 확장(멀티파트 `FormData`, Next 라우트 핸들러의 `req.formData()`로 수신). 기존 JSON 필드는 FormData 필드로 이전.
- PDF가 있으면 `extractGlossaryContext(pdf, geminiApiKey)` 호출 → 결과를 세션에 저장.
- **동기 처리**: 추출이 끝난 뒤 세션 생성을 완료해 응답(번역이 처음부터 컨텍스트를 갖도록). 로딩은 클라이언트가 표시.

### 4.3 추출 모듈 (신규 `src/lib/glossary-extractor.ts`)
- 입력: PDF 바이트 + Google API Key. 출력: `GlossaryContext`.
- Gemini Flash에 PDF와 프롬프트를 보내 **구조화 JSON**을 강제(JSON 스키마/`responseMimeType: application/json`).
- 프롬프트 요지: "이 강의자료의 도메인을 2~4문장으로 요약하고, 통역 시 일관성이 중요한 핵심 용어를 뽑아 각 용어의 의미/번역 처리 지침을 적어라. 특정 타겟 언어에 못박지 말고 언어 중립적으로."

```ts
interface GlossaryTerm {
  term: string;       // 소스(한국어) 용어
  note: string;       // 의미 + 번역 처리 지침 (언어 중립)
}
interface GlossaryContext {
  domainSummary: string;
  glossary: GlossaryTerm[];
}
```

### 4.4 저장 (`src/lib/translation-session-manager.ts`)
- 세션 객체에 필드 추가:
  - `glossaryContext?: GlossaryContext` (이 스펙에서 소비)
  - `presentationFile?: { name: string; bytes: Buffer|경로; mime: string }` (스펙 2용 보관; 이 스펙에선 저장만)
- 브릿지 생성 시 `glossaryContext`를 브릿지 config로 전달.

### 4.5 주입 (`src/lib/translation-bridge.ts`)
- 브릿지 config에 `glossaryContext?` 추가.
- `sendGeminiSetup`에서 glossaryContext가 있으면 `systemInstruction` 조립:
  ```
  You are translating a live lecture.
  Domain: <domainSummary>
  Glossary (translate these consistently and accurately):
  - <term>: <note>
  - ...
  ```
  형식: `systemInstruction: { parts: [{ text: <조립문> }] }`.
- glossaryContext가 없으면 systemInstruction을 넣지 않는다(기존 동작 유지).
- 호스트 자막 브릿지(transcribeOnly, target=ko)에도 동일 주입(맥락은 한국어 자막 정확도에도 도움). 단 회귀 위험 최소화를 위해 동일 조립문 사용.

## 5. 데이터 흐름 (한 세션)

1. 발표자가 PDF 선택 → `세션 만들기`.
2. 클라이언트가 PDF + geminiApiKey + allowedLanguages 를 `/api/sessions`에 전송.
3. 서버: PDF 보관 → Flash 추출 → `glossaryContext` 세션 저장 → 세션 생성 응답.
4. 청자가 언어 선택 → 해당 언어 브릿지 생성 → setup에 systemInstruction 주입 → 번역.

## 6. 에러 처리 / 그레이스풀 디그레이드

- Flash 추출 실패(잘못된 PDF, API 오류, 타임아웃): 에러 로깅 후 **glossaryContext 없이 세션 생성 계속**. PDF는 선택이므로 서비스는 정상 동작(회귀 없음). 클라이언트에 "자료 분석 실패, 컨텍스트 없이 진행" 정도의 비차단 안내.
- 추출 타임아웃 상한(예: 30초) 설정.

## 7. 범위 밖 (스펙 2에서)

- 발표자료를 화면에 전체화면으로 렌더 + 페이지 네비게이션.
- 하단 한국어 자막 오버레이 + 우하단 QR.
- HTML 형식 발표자료 지원.
- 용어집 검토/수정 UI(현재는 완전 자동).

## 8. 테스트

- **단위**: `glossary-extractor` — Flash 응답을 목킹해 `GlossaryContext` 파싱/검증. 잘못된 JSON 방어.
- **통합**: PDF 포함 세션 생성 → 세션에 glossaryContext 저장됨 + 브릿지 setup 메시지에 systemInstruction 포함됨(문자열 검증).
- **회귀**: PDF 없는 세션 생성 → systemInstruction 없음, 기존 흐름 정상.
- **E2E(수동)**: spike 방식 재사용 — 자료에 있는 용어를 발화 → 청자 언어 출력이 용어집대로 나오는지 확인.

## 9. 결정 기록

- PDF 선택(필수 아님) — 유연성/회귀 최소화.
- 완전 자동 추출(검토 단계 없음) — "버튼 하나" 흐름.
- 추출은 Gemini Flash, 번역은 Gemini 3.5 Live(2-모델).
- 주입은 `systemInstruction`(실측 검증).
- PDF 전체를 Flash에 전달(텍스트만 추출하지 않음) — 표·이미지 속 용어 보존.

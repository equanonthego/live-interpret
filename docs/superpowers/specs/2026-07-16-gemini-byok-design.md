# Gemini BYOK (사용자 부담 키) 설계

- 날짜: 2026-07-16
- 범위: 방송을 만드는 사람이 **자기 Gemini API 키**를 랑딩에서 입력하고, 그 키로 세션의 모든 통역이 돌아가게 한다. 목적은 **비용 전가** — 비싼 Gemini 3.5 Live 과금을 방송자 본인이 부담.
- 관련: 이전 설계문서 [2026-07-15-host-transcription-and-landing-simplify-design.md](2026-07-15-host-transcription-and-landing-simplify-design.md)에서 "기능 ③ 순수 BYOK"로 범위 밖 후속 과제로 미뤄뒀던 것. 그 문서가 명시한 대로, 키 저장/전달·로그 노출 방지 등 **보안 설계를 본 스펙에서 확정**한다.
- 별도 스펙: 청자 재생 토글은 [2026-07-16-attendee-playback-toggle-design.md](2026-07-16-attendee-playback-toggle-design.md).

## 배경 / 목표

- 현재 통역은 서버의 단일 `process.env.GEMINI_API_KEY`(폴더 주인 키)로 **모든 세션**이 돌아간다 → 남이 방송해도 폴더 주인이 Gemini 요금을 낸다.
- LiveKit(오디오 전송 인프라)는 폴더 주인의 LiveKit Cloud 계정(env 3개)을 그대로 쓴다. LiveKit은 오디오 기준 저렴/무료티어라 사용자 부담 대상에서 제외. **Gemini 키만** 사용자 부담으로 전환한다.
- 이 앱은 **서버 앱**이다: 폴더 주인 한 명이 서버(+터널)를 띄우고, 여러 방송자가 같은 서버에서 각자 세션을 만든다. 각 세션이 자기 Gemini 키를 들고 있으면 방송자별로 요금이 분리된다.

## 정책 결정 (확정)

- **키 필수**: 방송 생성 시 유효한 Gemini 키가 없으면 세션을 만들 수 없다. 서버 env 키로의 **자동 폴백은 없다**(폴백이 있으면 깜빡한 사용자가 폴더 주인에게 과금됨).
- **키 범위**: Gemini 키만. LiveKit 자격증명 3개는 계속 서버 env.
- **키 수명**: 서버 메모리(세션) + 방송자 본인 브라우저 localStorage뿐. 디스크·DB·로그에 저장하지 않는다.

## 설계

### ① 랑딩 페이지 ([src/app/page.tsx](../../../src/app/page.tsx))

- **Gemini API Key 입력칸** 추가: `type="password"`로 마스킹.
- **"연결 테스트" 버튼**: 누르면 `POST /api/verify-key` 호출 → 결과를 상태로 표시(테스트 중 스피너 / 성공 초록 체크 / 실패 에러 메시지).
- **"세션 만들기" 비활성 조건**: 키가 비었거나, 아직 테스트를 통과하지 않았으면 disabled. 키를 수정하면 "테스트 통과" 상태를 초기화(수정된 키는 다시 테스트해야 함).
- **자동채움**: 페이지 로드 시 `localStorage`의 마지막 키를 입력칸에 채운다. 테스트 통과 시 `localStorage`에 저장(방송자 본인 기기에만).
- 세션 생성 요청 body에 `geminiApiKey`를 포함해 보낸다.

### ② 연결 테스트 엔드포인트 — 신규 `POST /api/verify-key`

- body: `{ geminiApiKey: string }` — **POST 바디로만** 받는다(쿼리스트링 금지).
- 서버가 **실제 Gemini Live 모델**로 짧은 핸드셰이크를 시도한다:
  - `wss://generativelanguage.googleapis.com/...BidiGenerateContent?key=<키>`에 접속 → setup 메시지 전송 → `setupComplete` 수신되면 `{ ok: true }`, 타임아웃(예: 10초)/에러/조기 close면 `{ ok: false, error }`.
- **REST(models.list)가 아니라 Live WS로 테스트하는 이유**: 무료 티어 키는 REST는 통과해도 Live Translate 사용 시 실패한다(이전 문서 명시: Live는 유료 티어 필요). 실제 모델로 확인해야 "이 키로 방송 가능"이 보장된다.
- 모델명은 현재 [translation-bridge.ts](../../../src/lib/translation-bridge.ts)의 `geminiModel`(`gemini-3.5-live-translate-preview`)과 **동일해야** 한다. 두 곳이 어긋나지 않도록 모델명을 [interpret-config.ts](../../../src/lib/interpret-config.ts)의 상수(예: `GEMINI_LIVE_MODEL`)로 추출해 브릿지와 verify 엔드포인트가 공유한다.
- 응답에 키를 절대 되돌려주지 않고, 실패 사유는 일반화된 메시지로 반환한다.

### ③ 세션에 키 실어 저장

- `POST /api/sessions` ([route.ts](../../../src/app/api/sessions/route.ts)) body에서 `geminiApiKey`를 읽는다. 문자열이 아니거나 비어 있으면 **400** 반환.
- `SessionInfo`에 `geminiApiKey: string` 필드 추가. `createSession(sessionId, organizerIdentity, allowedLanguages, geminiApiKey)` 시그니처 확장. 키는 **서버 메모리에만** 저장.
- `TranslationSessionManager.buildBridgeConfig()`를 `buildBridgeConfig(sessionId)`로 바꿔, `geminiApiKey`를 `process.env.GEMINI_API_KEY` 대신 **해당 세션의 키**(`this.sessions.get(sessionId)?.geminiApiKey`)로 채운다. LiveKit 3개 값은 계속 env.
  - 호출부 3곳(`getOrCreate`, `startQuestionBridge`, `getOrCreateHostTranscription`)은 모두 `sessionId`를 갖고 있으므로 `buildBridgeConfig(sessionId)`로 통일 호출.
  - 세션이 없거나 키가 없으면 브릿지 생성 단계에서 명확한 에러를 던진다(키 필수 정책과 일관).
- 청자가 `/api/translate`로 번역을 요청하면 방송자의 세션 키가 자동으로 쓰인다 → **청자는 아무 키도 입력하지 않는다**. 방송자 한 명의 키로 그 세션의 강의자 자막·언어별 번역·질문 브릿지가 모두 과금된다.

### ④ 보안 필수사항 (loop.md 인증·보안 경계)

- 키는 **POST 바디로만** 전달. 우리 API의 쿼리스트링·URL에 키를 넣지 않는다.
- **로그 노출 0**: Gemini WS URL은 `?key=<키>`를 포함하므로, 그 URL 문자열을 `console.log` 등으로 **절대 출력하지 않는다**. 현재 [translation-bridge.ts](../../../src/lib/translation-bridge.ts)의 `connectGemini`/`reconnectGemini`는 URL을 로그하지 않는데(불변식), 신규 verify 엔드포인트에서도 이 불변식을 지킨다. 구현 후 `grep`으로 키·wsUrl이 로그 경로에 없음을 확인한다.
- 키 저장 위치는 **서버 메모리(SessionInfo) + 방송자 브라우저 localStorage** 두 곳뿐. 서버가 디스크·DB·파일 로그에 키를 쓰지 않는다.
- 세션 종료 시 `removeAllTranslations`가 `this.sessions.delete(sessionId)`로 SessionInfo(키 포함)를 메모리에서 제거한다(이미 동작).
- 전송은 HTTPS 위에서만 이뤄진다(cloudflared 터널이 TLS 종단 제공).

## 엣지 케이스

- 방송 중 키가 무효화(할당량 초과·폐기)되면 브릿지가 `error` 상태가 되고 기존 상태 표시 로직으로 노출된다. 자동 재시도/키 교체는 본 스펙 범위 밖.
- 같은 서버에서 여러 방송자가 각자 세션 생성 → 세션별로 키가 분리되어 각자 과금.
- 테스트 통과한 키를 방송 생성 직전에 수정하면, 랑딩의 "테스트 통과" 상태가 초기화되어 재테스트를 강제한다.

## 범위 밖 (YAGNI / 후속)

- 사용량(세션 시간/횟수) 집계·표시. (Gemini는 잔액 조회 API가 없음 — 이전 문서 명시.)
- LiveKit BYOK(사용자가 LiveKit 계정도 자기 것으로).
- 키의 서버 측 암호화 저장/영속화 — 메모리 전용 원칙으로 불필요.

## 검증 기준

- `npx tsc --noEmit` / `npm run build` 통과, 신규 lint 에러 0.
- 유효한 유료 키: "연결 테스트" 성공 → 세션 생성 → 방송 시 통역/자막 정상.
- 무효/무료 키: "연결 테스트" 실패 메시지, "세션 만들기" 비활성 유지.
- 키 미입력: 세션 생성 API가 400.
- 보안: 코드·서버 로그 어디에도 Gemini 키 또는 `?key=` 포함 URL이 출력되지 않음(grep 증빙).
- 서로 다른 키로 두 세션 생성 시 각 세션 브릿지가 각자 키를 사용(서버 로그로 세션별 브릿지 생성 확인, 키 값 자체는 로그 금지).

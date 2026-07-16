# 강연자 한국어 자막 + 랜딩 단순화 설계

- 날짜: 2026-07-15
- 범위: 기능 ①(랜딩 언어제한 UI 제거) + 기능 ②(강연자 한국어 자막을 방송 컨트롤 패널에 표시)
- 기능 ③(순수 BYOK)은 **본 스펙 범위 밖** — 별도 스펙으로 후속 진행 (마지막 절 참고)

## 배경

- 청중 watch 페이지에서 각자 언어를 고를 수 있게 됐으므로, 강연자 랜딩의 "청중 언어 제한" UI는 불필요.
- 강연자가 자기 마이크로 말할 때(특히 청중 질문을 대신 읽어줄 때) 자신의 한국어가 어떻게 인식되는지 컨트롤 패널에서 확인할 방법이 현재 없음.
- 소스 언어 상수 `SOURCE_LANGUAGE = "ko"`가 [interpret-config.ts](../../../src/lib/interpret-config.ts)에 이미 정의돼 있으나 미사용.

## 기능 ① — 랜딩페이지 단순화

**변경 대상**: [src/app/page.tsx](../../../src/app/page.tsx)

- "청중 언어 제한" 체크박스, 언어 검색 입력, 선택 칩, 언어 체크리스트, 전체선택/해제, "N개 선택됨" UI를 **전부 제거**.
- 관련 상태(`restrictLanguages`, `selectedLanguages`, `langSearch`, `filteredLanguages`)와 미사용 import(`SUPPORTED_LANGUAGES`) 정리.
- 세션 생성 시 `allowedLanguages`는 **항상** `DEFAULT_INTERPRET_LANGUAGES`(en·zh-Hans·ja·vi)로 고정 전송.
- 청중 watch 페이지 및 `/api/sessions`의 allowlist 검증 로직은 **변경 없음** (여전히 4개로 제한됨).

**결과**: 강연자는 언어를 고를 필요 없이 "세션 만들기"만 누르면 되고, 비용은 최대 4개 언어로 예측 가능하게 유지됨.

## 기능 ② — 강연자 한국어 자막 (접근 A: 전용 트랜스크립션 브릿지)

### 데이터 흐름

```
강연자 마이크(한국어)
  → LiveKit room
  → [전용 트랜스크립션 브릿지 translator-ko] 오디오 구독
  → Gemini Live (target=ko, transcribeOnly)
  → outputTranscription(한국어 텍스트)
  → publishData(topic="transcription", language="ko", destination=강연자)
  → 방송 컨트롤 패널 "내 음성 (한국어)" 자막 패널
```

### 서버: TranslationBridge에 `transcribeOnly` 모드 추가

**변경 대상**: [src/lib/translation-bridge.ts](../../../src/lib/translation-bridge.ts), [translation-session-manager.ts](../../../src/lib/translation-session-manager.ts), 신규 API

- `TranslationBridge` 생성자에 `transcribeOnly: boolean` 옵션 추가(기본 false).
- `transcribeOnly === true`일 때:
  - `targetLanguage`를 `ko`(= `SOURCE_LANGUAGE`)로 사용. echo 번역(ko→ko)의 `outputAudioTranscription`이 곧 한국어 전사가 되므로 **기존 `handleGeminiMessage`의 outputTranscription 경로를 그대로 재사용**(신규 메시지 파싱 코드 불필요).
  - `joinLiveKitRoom()`에서 **오디오 트랙을 발행하지 않음**(`AudioSource`/`publishTrack` 생략) → 에코·불필요 트랙 없음.
  - `queueAudioFrame`/`publishTranslatedAudio`(오디오 캡처) 경로 비활성(수신 오디오 프레임 무시).
  - 트랜스크립션은 기존 `publishTranscriptionText` 경로 그대로 사용(강연자에게 전달).
- 나머지(조직자 오디오 구독, Gemini 재연결, 트랜스크립션 세그먼트 처리)는 기존 코드 재사용.
- 참고: ko→ko echo 전사 품질이 부족하면 `inputAudioTranscription`(소스 직접 전사) + 해당 메시지 필드 파싱 추가를 폴백으로 고려(구현 중 검증).

### 매니저 & API

- `getOrCreate`에 `transcribeOnly` 전달 경로 추가. 언어 맵 키 충돌을 피하기 위해 host 전사 브릿지는 별도 키(예: `__host_ko`)로 저장하거나 `translations` 맵과 분리 관리.
- **신규 엔드포인트** `POST /api/transcribe` (start) / `DELETE /api/transcribe` (stop):
  - body: `{ sessionId }`. 서버가 세션의 `organizerIdentity`로 `transcribeOnly` 브릿지를 기동/중지.
- `getActiveTranslations()`(청중 "번역 · N개" 표시용)에서 host 전사 브릿지는 **제외**.

### 클라이언트: 방송 컨트롤 패널

**변경 대상**: [src/app/session/[id]/broadcast/page.tsx](../../../src/app/session/[id]/broadcast/page.tsx)

- `BroadcastControls`가 room 연결 후:
  1. `POST /api/transcribe`로 host 전사 브릿지 기동.
  2. `room.localParticipant.setAttributes({ language: "ko" })` — ko 브릿지가 강연자를 목적지로 인식하게 함.
  3. `RoomEvent.DataReceived`(topic `"transcription"`, `language === "ko"`) 구독 → 한국어 자막 상태 누적.
- QR 섹션 위 또는 오디오 인풋 아래에 **"내 음성 (한국어)"** 자막 패널 추가(watch 페이지 트랜스크립션 UI와 동일 스타일: 스크롤 영역, interim=회색/final=검정).
- "방송 종료" 시 `DELETE /api/transcribe`도 호출(기존 `DELETE /api/sessions/[id]`의 `removeAllTranslations`로도 정리되지만 명시적으로 중지).

### 엣지 케이스

- 조직자 미접속/마이크 off: ko 브릿지는 기존 "조직자 대기" 로직으로 대기, 말하기 시작하면 자막 흐름.
- Gemini 재연결(GoAway): 기존 재연결 로직 그대로 적용.
- 청중 "번역" 목록에 ko가 노출되지 않아야 함(위 매니저 필터).

## 비범위 (YAGNI / 후속)

- **기능 ③ 순수 BYOK** — 별도 스펙. 확정된 방향과 제약:
  - 각 사용자가 AI Studio에서 발급한 **본인 Gemini 키**를 붙여넣어 사용. 랜딩에 "키 발급 링크"(AI Studio) 제공.
  - **잔액 표시는 불가**: Gemini는 OpenRouter 같은 크레딧/잔액 조회 API가 없음. Live API는 OpenRouter 프록시 대상도 아님. → 무비킥 방식 그대로는 재현 불가.
  - 대안으로 앱 자체 집계 "사용량(세션 시간/수)" 표시는 가능(후속 스펙에서 결정).
  - 키 저장/전달 방식(브라우저 보관 vs 서버 세션 인메모리), 로그 노출 방지 등 **보안 설계는 후속 스펙에서 확정**(loop.md 인간 호출 경계선: 인증·보안 아키텍처).

## 검증 기준

- `npm run build` 통과, `tsc --noEmit` 통과, 신규 린트 경고 0(기존 17건 외 추가 0).
- 미사용 import/변수 0(특히 ① 제거 후 page.tsx 정리).
- 시크릿 노출 0(키·토큰이 코드/로그에 노출되지 않음).
- E2E: 방송 시작 → 강연자 한국어 발화 → 컨트롤 패널에 한국어 자막 표시 확인(서버 로그 + 브라우저).
- 청중 파이프라인(언어 선택 → 번역 음성/자막) 회귀 없음.

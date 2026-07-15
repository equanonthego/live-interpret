# 발언권 이양형 Q&A (텍스트 읽기) 구현 계획

> **실행 방식:** 각 태스크를 순서대로. 코드 태스크 끝마다 게이트(`npx tsc --noEmit` + `npm run build`)를 통과시키고, 마지막에 실기기 종단 검증. 실시간 오디오/권한이 본질이라 단위 테스트 대신 게이트+수동 검증으로 수용 판정한다.

**Goal:** 청자가 손들기 → 강의자가 마이크를 넘김 → 청자가 자기 언어로 질문 → 강의자 화면에 한국어 텍스트로 표시(오디오 없음) → 강의자가 마이크 회수. 한 번에 한 명만 발언.

**설계 정본:** `docs/specs/2026-07-15-floor-passing-qa-design.md`

**Architecture:** "발언권 쥔 현재 화자 → 청취자 언어들"의 일반화. 기존 브릿지(출발 언어 자동 감지)를 재사용하되 **구독 대상을 강의자 고정에서 임의 화자로 일반화**하고, 질문용 `→ko` 브릿지를 질문 시간에만 띄운다. 발언권 제어는 LiveKit data 메시지 + 세션매니저 상태로 구현.

**Tech Stack:** Next.js 16.2.6, `@livekit/rtc-node`(서버 브릿지), `livekit-server-sdk`(토큰/권한), `livekit-client`(브라우저), LiveKit data messages.

**중요 — LiveKit API 정본 확인:** 아래 태스크는 설치된 SDK 버전의 실제 시그니처를 구현 시점에 확인한다(추측 금지):
- 참가자 권한 갱신: `livekit-server-sdk`의 `RoomServiceClient.updateParticipant(room, identity, {permission})` 또는 발언권 부여 시 **새 토큰 재발급**(단순·확실). → **재발급 방식을 기본으로 채택**(RoomServiceClient 도입 없이 기존 `/api/token` 재사용).
- 브라우저 발행: `livekit-client`의 `room.localParticipant.setMicrophoneEnabled(true/false)`.
- 데이터 메시지: `localParticipant.publishData(payload, {reliable, topic, destination_identities})` (브릿지 코드에 이미 사용 중 — 동일 패턴).
- 참가자 속성: `localParticipant.setAttributes({...})` / 수신측 `participant.attributes`.

---

## File Structure

**수정:**
- `src/lib/translation-bridge.ts` — 구독 대상 일반화(`organizerIdentity` → `sourceIdentity`)
- `src/lib/translation-session-manager.ts` — 발언권(floor) 상태 + 질문 브릿지 생성/종료 헬퍼
- `src/app/api/token/route.ts` — 발언권 받은 청자에게 `canPublish` 부여하는 경로
- `src/app/session/[id]/broadcast/page.tsx` — 대기열 UI + "마이크 넘기기/회수" + 한국어 텍스트 패널 + `language=ko` 속성
- `src/app/session/[id]/watch/page.tsx` — "질문하기" 버튼 + 발언권 수신 시 마이크 발행

**신규:**
- `src/app/api/floor/route.ts` — 발언권 상태 조회/변경(승인·회수) API (세션매니저 경유)
- `src/lib/floor-messages.ts` — floor data 메시지 타입 상수(양쪽 공유)

---

## Task 1: 브릿지 구독 대상 일반화

브릿지가 "강의자"가 아니라 "지정된 화자"를 구독하도록 바꾼다. 정방향(강의)은 강의자를, 질문 브릿지는 질문자를 구독.

**Files:** `src/lib/translation-bridge.ts`

- [ ] **Step 1: 필드/생성자 파라미터명 일반화**

`organizerIdentity` 관련 이름을 `sourceIdentity`로 바꾼다. 생성자 3번째 인자 의미를 "구독할 화자 identity"로 확장(하위호환 위해 이름만 변경, 시그니처 위치 동일).
- 필드 `private organizerIdentity: string;` → `private sourceIdentity: string;`
- 생성자 인자 `organizerIdentity: string` → `sourceIdentity: string`, 본문 `this.organizerIdentity = organizerIdentity` → `this.sourceIdentity = sourceIdentity`
- 참조 3곳(구독 대기/구독/화자 이탈 감지: 약 196·368 부근 `=== this.organizerIdentity`)을 `this.sourceIdentity`로 치환

- [ ] **Step 2: 로그 문구 유지(선택)**

"organizer disconnected" 로그는 "source speaker disconnected"로 문구만 수정(동작 무관).

- [ ] **Step 3: 게이트**

Run: `npx tsc --noEmit`
Expected: 에러 없음(호출부는 Task 3에서 맞춤).

- [ ] **Step 4: 커밋**

```bash
git add src/lib/translation-bridge.ts
git commit -m "refactor(bridge): 구독 대상을 강의자 고정에서 sourceIdentity로 일반화"
```

---

## Task 2: floor 메시지 타입 + 세션매니저 발언권 상태

**Files:** `src/lib/floor-messages.ts`(신규), `src/lib/translation-session-manager.ts`

- [ ] **Step 1: floor 메시지 타입 상수 작성**

`src/lib/floor-messages.ts`:
```ts
// 강의자↔청자 발언권 신호 (LiveKit data, topic "floor")
export const FLOOR_TOPIC = "floor";
export type FloorMessage =
  | { type: "raise-hand"; identity: string; name?: string; language: string }
  | { type: "lower-hand"; identity: string }
  | { type: "grant"; identity: string }   // 이 청자에게 발언권 부여
  | { type: "revoke"; identity: string }; // 발언권 회수
```

- [ ] **Step 2: 세션매니저에 발언권/대기열 상태 추가**

`SessionInfo`에 필드 추가(선택적):
```ts
// SessionInfo 인터페이스에 추가
currentSpeaker?: string;          // 발언권을 쥔 청자 identity (없으면 강의자만 발언)
handRaised?: { identity: string; name?: string; language: string }[];
```
`createSession`에서 `handRaised: []`로 초기화. 헬퍼 메서드 추가:
```ts
raiseHand(sessionId, entry): void            // 대기열에 추가(중복 방지)
lowerHand(sessionId, identity): void         // 대기열에서 제거
setSpeaker(sessionId, identity|null): void   // currentSpeaker 설정
getFloorState(sessionId): { currentSpeaker, handRaised }
```
(모두 in-memory Map 조작. 정본: 기존 `sessions` Map 패턴 그대로.)

- [ ] **Step 3: 질문 브릿지 생성/종료 헬퍼**

질문자가 발언권을 받으면 `질문자언어 → ko` 브릿지를 띄우고, 회수 시 종료한다. 기존 `getOrCreate`는 언어 키로 관리하므로, 질문 브릿지는 **소스가 질문자**라는 점이 달라 별도 경로가 필요하다.
```ts
// targetLanguage="ko", sourceIdentity=질문자, 언어키 충돌 피하려 별도 관리
async startQuestionBridge(sessionId, questionerIdentity): Promise<void>
async stopQuestionBridge(sessionId): Promise<void>
```
`startQuestionBridge`는 `new TranslationBridge(sessionId, "ko", questionerIdentity, config)` 생성·start, 세션별 1개만 유지(맵에 저장). `stopQuestionBridge`는 그 브릿지 `stop()` 후 제거.

- [ ] **Step 4: 게이트**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/floor-messages.ts src/lib/translation-session-manager.ts
git commit -m "feat(floor): 발언권/대기열 상태 + 질문 브릿지(→ko) 라이프사이클"
```

---

## Task 3: floor API + 토큰 발행 권한

**Files:** `src/app/api/floor/route.ts`(신규), `src/app/api/token/route.ts`

- [ ] **Step 1: floor API 작성**

`src/app/api/floor/route.ts`:
- `GET ?sessionId=` → `getFloorState` 반환(강의자 폴링용: 대기열·현재 발언자)
- `POST { sessionId, action: "grant"|"revoke", identity }` → 강의자만. `grant`: `setSpeaker(identity)` + `startQuestionBridge(sessionId, identity)`; `revoke`: `stopQuestionBridge` + `setSpeaker(null)` + `lowerHand`. 강의자 인증은 `BROADCAST_PASSWORD`(기존 패턴)로 보호.
- `PUT { sessionId, action: "raise"|"lower", identity, name?, language? }` → 청자 손들기/취소(`raiseHand`/`lowerHand`). 인증 불필요(청자).

각 응답은 최신 floor 상태 포함.

- [ ] **Step 2: 토큰 라우트에 발언권 청자 발행 허용**

현재 `canPublish: isOrganizer`. 발언권 받은 청자도 발행 가능해야 하므로, 세션의 `currentSpeaker`와 요청 identity가 일치하면 `canPublish=true`.
`src/app/api/token/route.ts`에서 grant 계산부:
```ts
const manager = TranslationSessionManager.getInstance();
const session = manager.getSession(room);
const isCurrentSpeaker = !!identity && session?.currentSpeaker === identity;
const canPublish = isOrganizer || isCurrentSpeaker;
// addGrant에서 canPublish, canPublishData 반영
```
청자는 발언권 받은 뒤 **토큰을 재발급**받아 재접속 없이 발행 권한을 얻는다(클라이언트가 `/api/token` 재호출 → `room` 연결에 새 토큰 적용은 재연결이 필요할 수 있음 → 구현 시 `livekit-client` 재연결/`prepareConnection` 확인. 대안: 처음부터 청자 토큰에 `canPublish=true`를 주되, 실제 발행은 발언권 있을 때만 UI가 허용 — **이 대안을 기본 채택**해 재연결 복잡도를 없앤다).

> 결정: 청자 토큰은 처음부터 `canPublish=true, canPublishData=true`로 발급하되, **마이크 실제 발행은 발언권(grant) 신호를 받은 청자만** 클라이언트에서 수행. 서버 신뢰경계는 floor API(강의자 승인)가 담당. 이로써 토큰 재발급/재연결 불필요.

즉 Step 2는 실제로: `canPublish`를 청자도 `true`로 주되, 남용 방지는 floor 승인 UX로. (원한다면 후속에서 서버 권한 강제 추가 가능 — 범위 밖.)

- [ ] **Step 3: 게이트**

Run: `npx tsc --noEmit && npm run build`
Expected: 빌드 성공, `/api/floor` 라우트 등장.

- [ ] **Step 4: 커밋**

```bash
git add src/app/api/floor src/app/api/token/route.ts
git commit -m "feat(floor): floor API(손들기/승인/회수) + 청자 발행 토큰"
```

---

## Task 4: watch — 질문하기 + 발언권 시 마이크 발행

**Files:** `src/app/session/[id]/watch/page.tsx`

- [ ] **Step 1: "질문하기/손내리기" 버튼 + 상태**

언어 선택 영역 아래에 버튼 추가. 상태: `idle | raised | speaking`.
- "질문하기" 클릭 → `PUT /api/floor {action:"raise", identity, name, language:선택언어}` → `raised`
- floor data 메시지 수신 리스너 추가(topic `FLOOR_TOPIC`): 내 identity로 `grant` 오면 `speaking`, `revoke` 오면 `idle`

- [ ] **Step 2: 발언권 수신 시 마이크 발행(푸시투톡)**

`grant` 수신 → `room.localParticipant.setMicrophoneEnabled(true)` (livekit-client 정본 확인). `revoke`/버튼 종료 → `setMicrophoneEnabled(false)` + `PUT lower`.
발행 중엔 "발언 중 — 종료" 버튼 표시.

- [ ] **Step 3: 게이트**

Run: `npx tsc --noEmit && npm run build`
Expected: 성공.

- [ ] **Step 4: 커밋**

```bash
git add src/app/session/\[id\]/watch/page.tsx
git commit -m "feat(watch): 질문하기(손들기) + 발언권 시 마이크 발행"
```

---

## Task 5: broadcast — 대기열 + 마이크 넘기기/회수 + 한국어 텍스트 패널

**Files:** `src/app/session/[id]/broadcast/page.tsx`

- [ ] **Step 1: 강의자 참가자에 `language=ko` 속성**

room 연결 후 `room.localParticipant.setAttributes({ language: "ko" })` (정본 확인). → 질문 브릿지(`→ko`)의 트랜스크립션 수신 대상이 됨.

- [ ] **Step 2: 대기열 패널 + 승인/회수**

`GET /api/floor?sessionId=` 폴링(1~2초) 또는 floor data 수신으로 대기열 표시. 각 대기자 옆 "마이크 넘기기" → `POST /api/floor {action:"grant", identity}` + data 메시지 `grant` 발행(해당 청자에게). 현재 발언자 표시 + "회수" → `POST {action:"revoke"}` + data `revoke`.

- [ ] **Step 3: 한국어 텍스트(질문) 패널**

watch 페이지의 transcription 수신·렌더 로직을 그대로 이식: topic `"transcription"` data 수신, `language==="ko"`(=질문 통역) 텍스트를 실시간 표시. 발언자 없을 땐 숨김/비움.

- [ ] **Step 4: 게이트**

Run: `npx tsc --noEmit && npm run build`
Expected: 성공, 라우트 목록 정상.

- [ ] **Step 5: 커밋**

```bash
git add src/app/session/\[id\]/broadcast/page.tsx
git commit -m "feat(broadcast): 대기열·마이크 넘기기/회수 + 한국어 질문 텍스트 패널"
```

---

## Task 6: 종단 실기기 검증 (수용 판정)

**Files:** 없음. cloudflared 터널(HTTPS)로 실기기 테스트.

- [ ] **Step 1:** 강의자(노트북) HTTPS 접속 → 세션 생성 → 마이크 방송. 청자(폰) 접속 → 언어 선택 → 통역 청취(기존 기능 회귀 없는지).
- [ ] **Step 2:** 청자가 "질문하기" → 강의자 화면 대기열에 뜨는지.
- [ ] **Step 3:** 강의자 "마이크 넘기기" → 청자 폰 마이크 활성화되는지.
- [ ] **Step 4:** 청자가 (예: 베트남어/영어) 질문 → **강의자 화면에 한국어 텍스트**가 실시간으로 뜨는지. 오디오는 안 나와야 함.
- [ ] **Step 5:** 강의자 "회수" → 서버 로그에 질문 브릿지 종료, 청자 마이크 꺼짐.
- [ ] **Step 6:** 강의자 한국어 답변 → 모든 청자(질문자 포함) 각자 언어로 듣는지.
- [ ] **Step 7:** 결과(지연·정상 여부·비용 로그: 질문 브릿지가 질문 시간에만 존재) 요약 보고.

---

## Self-Review

- **Spec coverage:** 손들기·마이크 이양(Task 3·4·5), 질문자→ko 브릿지(Task 2), 한국어 텍스트만 표시(Task 5 Step 3, 오디오 미재생), 강의자만 수신(질문 브릿지 target=ko, 강의자만 language=ko), 브릿지 일반화(Task 1). ✅
- **결정 반영:** 토큰 재발급 대신 "청자 canPublish=true + 발행은 승인 UX 게이트"로 재연결 복잡도 제거(Task 3 Step 2). 서버 강제 권한은 범위 밖으로 명시.
- **정본 확인 지점 명시:** livekit-client `setMicrophoneEnabled`/`setAttributes`, data 메시지 시그니처를 구현 시 확인(추측 금지) — 각 태스크에 표기.
- **범위:** 강의자만·텍스트만·1인 발언으로 한정. 다중 발언·전원 통역·오디오 재생·로그 저장 제외.

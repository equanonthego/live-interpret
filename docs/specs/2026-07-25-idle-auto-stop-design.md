# 유휴/이탈 시 방송 자동 종료 (비용 차단)

## 목적

발표자가 오래 말을 안 하거나(무음), 노트북을 덮거나 끄거나 절전되거나 탭을 닫으면
방송을 **서버가 자동으로 종료**한다. 종료 시 모든 브리지가 내려가 Gemini WebSocket과
LiveKit 봇 비용이 즉시 멈추고, 발표자 폴링도 끊겨 Cloud Run 컨테이너가 유휴로
축소(min-instances 0)돼 세 비용이 모두 끊긴다.

## 감지 대상과 방법

| 케이스 | 감지 | 임계 |
|---|---|---|
| 노트북 덮음/꺼짐/절전/탭 프리즈 | 발표자의 status 폴링(심장박동)이 멈춤 | **90초** |
| 발표자가 오래 말 안 함 | 브리지 `lastSpeechInputAt` 정지 | **5분(300초)** |
| 탭을 의도적으로 닫음 | `pagehide`(non-persisted) 즉시 종료 | 즉시 |

## 구성요소

### 1) 순수 판정 함수 — `src/lib/session-reaper.ts`
```
evaluateReap({ now, lastHeartbeatAt, lastAudioAt, heartbeatTimeoutMs, idleAudioTimeoutMs })
  → null | "heartbeat" | "idle"
```
- `now - lastHeartbeatAt > heartbeatTimeoutMs` → `"heartbeat"`
- 아니면 `now - lastAudioAt > idleAudioTimeoutMs` → `"idle"`
- 아니면 `null`
- 순수 함수라 단위테스트(`session-reaper.test.ts`)로 검증.

### 2) 세션 매니저 배선 — `translation-session-manager.ts`
- `SessionInfo`에 `lastHeartbeatAt: number` 추가(생성 시 `Date.now()`).
- `touchHeartbeat(sessionId)`: `lastHeartbeatAt = Date.now()`.
- 세션의 오디오 활동 시각 = 그 세션의 모든 브리지(통역+호스트) `lastSpeechAt` 중 최댓값,
  하한은 `createdAt`(발화가 아직 없으면 생성 시각 기준으로 무음 타이머 시작).
- 리퍼: 30초 간격 `setInterval`. 각 세션에 `evaluateReap` 적용해 결과가 있으면
  `removeAllTranslations(sessionId)` 후 사유 로그. 세션이 하나라도 있을 때만 돌도록
  첫 세션 생성 시 시작, 마지막 세션 종료 시 정지(불필요한 상시 타이머 방지).
- 상수: `HEARTBEAT_TIMEOUT_MS = 90_000`, `IDLE_AUDIO_TIMEOUT_MS = 300_000`.

### 3) 브리지 노출 — `translation-bridge.ts`
- `get lastSpeechAt(): number` (기존 private `lastSpeechInputAt` 공개용 getter).

### 4) 심장박동 출처 — `src/app/api/translate/status/route.ts`
- 발표자 전용 폴링(청자는 이 엔드포인트를 안 씀)이므로 GET 핸들러에서
  `manager.touchHeartbeat(sessionId)` 호출. 새 엔드포인트/타이머 불필요.

### 5) 즉시 종료 — `src/app/session/[id]/broadcast/page.tsx`
- `pagehide` 리스너: `event.persisted`가 false(실제 언로드)일 때만
  `fetch('/api/sessions/${sessionId}', { method:'DELETE', keepalive:true })`.
  bfcache/프리즈(persisted=true, 절전 등)는 서버 심장박동(90초)에 맡긴다.

## 비동작(무관)
- 기존 wakeLock은 화면 꺼짐만 막을 뿐 덮으면 절전됨 → 심장박동이 정상 감지. 충돌 없음.
- 백그라운드 탭은 폴링이 ~60초로 throttle되지만 90초 임계 안이라 정상 방송은 안 끊김.

## 테스트/검증
- `evaluateReap` 단위테스트: heartbeat 초과 / idle 초과 / 정상 / 경계값.
- 런타임: status 폴링으로 heartbeat 갱신 확인, 폴링 중단 시 90초 후 세션 제거 로그 확인.
```
[SessionManager] Reaped session <id> (reason: heartbeat|idle)
```

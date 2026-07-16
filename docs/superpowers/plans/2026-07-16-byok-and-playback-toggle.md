# Gemini BYOK + 청자 재생 토글 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 방송자가 자기 Gemini 키로 통역 과금을 부담하게 하고(BYOK), 청자 화면에 항상 보이는 하단 고정 재생 On/Off 토글을 추가한다.

**Architecture:** Part A(BYOK) — Gemini 키를 랑딩에서 입력·테스트하여 세션 생성 요청에 실어 보내고, 서버는 그 키를 세션 메모리에 저장해 해당 세션의 모든 TranslationBridge가 `process.env.GEMINI_API_KEY` 대신 세션 키를 쓰도록 한다. Part B(재생 토글) — LiveKit `RoomAudioRenderer`의 `muted` prop과 `useAudioPlayback` 훅으로 청자 재생을 제어하는 하단 스티키 버튼을 추가하고 기존 `StartAudio`를 제거한다. 두 파트는 서로 독립적이며 순서대로 구현한다.

**Tech Stack:** Next.js 16.2.6 (App Router, Turbopack), React 19, TypeScript, `@livekit/components-react`, `@livekit/rtc-node`, `ws`, `livekit-server-sdk`.

## Global Constraints

- **빌드 무결성**: 각 태스크 종료 시 `npx tsc --noEmit` 0 에러, `npm run build` 통과.
- **린트**: 변경한 파일에 `npx eslint <files>` 신규 에러 0 (기존 파일의 사전 존재 경고는 대상 아님).
- **미사용 임포트/변수 0** (~/.claude/CLAUDE.md: "미사용 임포트나 변수가 있는 코드를 절대 푸시하지 말 것").
- **시크릿 로그 노출 0**: Gemini 키, 또는 `?key=<키>`를 포함한 Gemini WS URL을 `console.log`/에러 메시지/디스크에 절대 출력하지 않는다.
- **테스트 러너 없음**: 이 저장소에는 유닛 테스트 프레임워크가 없다. 새로 도입하지 않는다. 검증은 태스크마다 `tsc --noEmit` + `eslint` + `npm run build` + (API는 `curl`, UI는 브라우저) 수동 확인으로 한다.
- **작업 경로**: 모든 편집은 `/Users/equan/Desktop/Story Kick_Series/04_개발/live-interpret` (branch `main`)에서 한다.
- **모델명 단일 출처**: Gemini Live 모델명은 `src/lib/interpret-config.ts`의 상수 하나로만 정의하고 브릿지·verify 엔드포인트가 공유한다.

---

# Part A — Gemini BYOK

## Task A1: Gemini Live 모델명을 공유 상수로 추출

**Files:**
- Modify: `src/lib/interpret-config.ts` (상수 추가)
- Modify: `src/lib/translation-bridge.ts:69` (하드코딩된 모델명을 상수 참조로 교체)

**Interfaces:**
- Produces: `export const GEMINI_LIVE_MODEL = "gemini-3.5-live-translate-preview"` in `src/lib/interpret-config.ts`.

- [ ] **Step 1: interpret-config.ts에 상수 추가**

`src/lib/interpret-config.ts` 파일 끝에 추가:

```ts
// Gemini Live 모델명 — 브릿지와 /api/verify-key가 반드시 동일 값을 써야
// 하므로 여기 한 곳에서만 정의한다.
export const GEMINI_LIVE_MODEL = "gemini-3.5-live-translate-preview";
```

- [ ] **Step 2: translation-bridge.ts가 상수를 사용하도록 수정**

`src/lib/translation-bridge.ts`의 import 블록(상단, `interpret-config`에서 이미 import하는 파일이 아니면 신규 import 추가)과 필드 정의를 수정.

import 추가 (파일 상단 import들 근처):

```ts
import { GEMINI_LIVE_MODEL } from "./interpret-config";
```

`src/lib/translation-bridge.ts:69` 근처의 하드코딩 라인을 교체:

```ts
// 변경 전:
//   private readonly geminiModel: string = "gemini-3.5-live-translate-preview";
// 변경 후:
  private readonly geminiModel: string = GEMINI_LIVE_MODEL;
```

- [ ] **Step 3: 타입체크**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: 값 회귀 확인 (모델명이 그대로인지)**

Run: `grep -rn "gemini-3.5-live-translate-preview" src/`
Expected: `src/lib/interpret-config.ts`에 **한 곳만** 출력 (bridge에는 더 이상 리터럴이 없어야 함)

- [ ] **Step 5: Commit**

```bash
git add src/lib/interpret-config.ts src/lib/translation-bridge.ts
git commit -m "refactor(config): Gemini Live 모델명을 공유 상수로 추출"
```

---

## Task A2: 연결 테스트 엔드포인트 `POST /api/verify-key`

**Files:**
- Create: `src/app/api/verify-key/route.ts`
- Test(수동): `curl`

**Interfaces:**
- Consumes: `GEMINI_LIVE_MODEL` (Task A1).
- Produces: `POST /api/verify-key` — 요청 body `{ geminiApiKey: string }`, 응답 `{ ok: true }` 또는 `{ ok: false, error: string }` (성공 200, 검증 실패도 200으로 `ok:false`, 잘못된 요청은 400).

- [ ] **Step 1: 엔드포인트 작성**

Create `src/app/api/verify-key/route.ts`:

```ts
/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextRequest, NextResponse } from "next/server";
import WebSocket from "ws";
import { GEMINI_LIVE_MODEL } from "@/lib/interpret-config";

// POST /api/verify-key — 방송자가 붙여넣은 Gemini 키가 실제로 Live 모델에
// 접속 가능한지(유료 티어 포함) 짧은 핸드셰이크로 확인한다. 키는 body로만
// 받고, 로그·응답 어디에도 키나 WS URL을 노출하지 않는다.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";

  if (!geminiApiKey) {
    return NextResponse.json({ error: "Missing geminiApiKey" }, { status: 400 });
  }

  const result = await verifyGeminiKey(geminiApiKey);
  return NextResponse.json(result);
}

function verifyGeminiKey(
  apiKey: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    // 주의: 이 URL은 ?key=<키>를 포함하므로 절대 로그로 출력하지 않는다.
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    let settled = false;
    const ws = new WebSocket(wsUrl);

    const done = (r: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // ignore
      }
      resolve(r);
    };

    const timer = setTimeout(
      () => done({ ok: false, error: "시간 초과 — 키 또는 네트워크를 확인하세요." }),
      10000
    );

    ws.on("open", () => {
      const setup = {
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: {
              targetLanguageCode: "en",
              echoTargetLanguage: true,
            },
          },
        },
      };
      ws.send(JSON.stringify(setup));
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.setupComplete) {
          done({ ok: true });
        }
      } catch {
        // 비-JSON 메시지는 무시하고 계속 대기
      }
    });

    ws.on("error", () => {
      done({ ok: false, error: "키 검증에 실패했습니다. 키가 올바른지 확인하세요." });
    });

    ws.on("close", () => {
      done({ ok: false, error: "키 검증에 실패했습니다 (연결이 종료됨)." });
    });
  });
}
```

- [ ] **Step 2: 타입체크 & 린트**

Run: `npx tsc --noEmit && npx eslint src/app/api/verify-key/route.ts`
Expected: 0 errors

- [ ] **Step 3: 잘못된 요청(키 없음) 확인**

개발 서버가 떠 있는 상태에서:

Run: `curl -s -X POST http://localhost:3000/api/verify-key -H "Content-Type: application/json" -d '{}'`
Expected: `{"error":"Missing geminiApiKey"}` (HTTP 400)

- [ ] **Step 4: 무효 키 확인**

Run: `curl -s -X POST http://localhost:3000/api/verify-key -H "Content-Type: application/json" -d '{"geminiApiKey":"invalid-key-123"}'`
Expected: `{"ok":false,"error":"..."}` (10초 내 응답)

- [ ] **Step 5: (사용자 확인) 유효 키 확인**

사용자에게 실제 유료 Gemini 키로 아래를 실행해 `{"ok":true}`가 나오는지 확인 요청:

Run: `curl -s -X POST http://localhost:3000/api/verify-key -H "Content-Type: application/json" -d '{"geminiApiKey":"<실제-키>"}'`
Expected: `{"ok":true}`

- [ ] **Step 6: 로그 노출 점검**

Run: `grep -n "wsUrl\|geminiApiKey\|apiKey" src/app/api/verify-key/route.ts | grep -i "console"`
Expected: 출력 없음 (키/URL을 로그하는 라인이 없어야 함)

- [ ] **Step 7: Commit**

```bash
git add src/app/api/verify-key/route.ts
git commit -m "feat(byok): Gemini 키 연결 테스트 엔드포인트 (/api/verify-key)"
```

---

## Task A3: 세션이 방송자 Gemini 키를 저장·사용

**Files:**
- Modify: `src/lib/translation-session-manager.ts` (SessionInfo 필드, createSession 시그니처, buildBridgeConfig)
- Modify: `src/app/api/sessions/route.ts` (키 필수 검증 + createSession 호출)

**Interfaces:**
- Consumes: 없음(내부 변경).
- Produces:
  - `SessionInfo.geminiApiKey: string`
  - `createSession(sessionId: string, organizerIdentity: string, allowedLanguages: string[] | undefined, geminiApiKey: string): SessionInfo`
  - `buildBridgeConfig(sessionId: string)` — 세션의 `geminiApiKey`를 사용, 세션/키 없으면 throw.

- [ ] **Step 1: SessionInfo에 geminiApiKey 필드 추가**

`src/lib/translation-session-manager.ts`의 `SessionInfo` 인터페이스에 필드 추가:

```ts
export interface SessionInfo {
  sessionId: string;
  organizerIdentity: string;
  createdAt: Date;
  allowedLanguages?: string[];
  // 이 세션의 통역을 돌릴 방송자 소유 Gemini 키. 서버 메모리에만 존재하며
  // 디스크·로그에 절대 기록하지 않는다.
  geminiApiKey: string;
  // 발언권을 쥔 청자 identity. 없으면(undefined) 강의자만 발언 중.
  currentSpeaker?: string;
  // 손든 청자 대기열 (순서대로).
  handRaised: HandRaise[];
}
```

- [ ] **Step 2: createSession 시그니처 확장**

같은 파일의 `createSession`을 수정:

```ts
  createSession(
    sessionId: string,
    organizerIdentity: string,
    allowedLanguages: string[] | undefined,
    geminiApiKey: string
  ): SessionInfo {
    const info: SessionInfo = {
      sessionId,
      organizerIdentity,
      createdAt: new Date(),
      allowedLanguages,
      geminiApiKey,
      handRaised: [],
    };
    this.sessions.set(sessionId, info);
    console.log(`[SessionManager] Created session ${sessionId} for organizer ${organizerIdentity} with allowed languages: ${allowedLanguages?.join(", ") || "all"}`);
    return info;
  }
```

(주의: 로그 라인에 `geminiApiKey`를 추가하지 말 것.)

- [ ] **Step 3: buildBridgeConfig가 세션 키를 쓰도록 수정**

같은 파일의 `buildBridgeConfig()`를 `sessionId` 인자를 받도록 교체:

```ts
  private buildBridgeConfig(sessionId: string) {
    const session = this.sessions.get(sessionId);
    const geminiApiKey = session?.geminiApiKey;
    if (!geminiApiKey) {
      throw new Error(`No Gemini API key stored for session ${sessionId}`);
    }
    return {
      geminiApiKey,
      livekitUrl: process.env.LIVEKIT_URL || "ws://localhost:7880",
      livekitApiKey: process.env.LIVEKIT_API_KEY!,
      livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
    };
  }
```

- [ ] **Step 4: 세 호출부를 buildBridgeConfig(sessionId)로 교체**

같은 파일에서 `this.buildBridgeConfig()` 호출 3곳을 `this.buildBridgeConfig(sessionId)`로 바꾼다:
- `getOrCreate` 내부 (`new TranslationBridge(sessionId, targetLanguage, organizerIdentity, this.buildBridgeConfig())` → `...this.buildBridgeConfig(sessionId))`)
- `startQuestionBridge` 내부 (`this.buildBridgeConfig()` → `this.buildBridgeConfig(sessionId)`)
- `getOrCreateHostTranscription` 내부 (`this.buildBridgeConfig()` → `this.buildBridgeConfig(sessionId)`)

Run: `grep -n "buildBridgeConfig" src/lib/translation-session-manager.ts`
Expected: 정의 1곳 + 호출 3곳 모두 `(sessionId)` 인자를 가짐

- [ ] **Step 5: /api/sessions에서 키 필수 검증 + 전달**

`src/app/api/sessions/route.ts`에서 `allowedLanguages` 파싱 직후, 비밀번호 검증 전에 키 파싱/검증을 추가:

```ts
    const geminiApiKey =
      typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";
    if (!geminiApiKey) {
      return NextResponse.json(
        { error: "Missing geminiApiKey" },
        { status: 400 }
      );
    }
```

그리고 같은 파일의 `manager.createSession(sessionId, organizerIdentity, allowedLanguages);` 호출을 다음으로 교체:

```ts
    manager.createSession(sessionId, organizerIdentity, allowedLanguages, geminiApiKey);
```

- [ ] **Step 6: 타입체크 & 린트**

Run: `npx tsc --noEmit && npx eslint src/lib/translation-session-manager.ts src/app/api/sessions/route.ts`
Expected: 0 errors

- [ ] **Step 7: 키 없는 세션 생성이 400인지 확인**

개발 서버가 떠 있는 상태에서 (BROADCAST_PASSWORD가 설정돼 있다면 password도 포함):

Run: `curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/sessions -H "Content-Type: application/json" -d '{"organizerName":"test"}'`
Expected: `400`

- [ ] **Step 8: 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 9: Commit**

```bash
git add src/lib/translation-session-manager.ts src/app/api/sessions/route.ts
git commit -m "feat(byok): 세션별 방송자 Gemini 키 저장 및 브릿지 사용 (키 필수)"
```

---

## Task A4: 랑딩 페이지에 키 입력 + 연결 테스트 UI

**Files:**
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `POST /api/verify-key` (Task A2), `POST /api/sessions`의 `geminiApiKey` 필드 (Task A3).
- Produces: 없음(최종 UI).

- [ ] **Step 1: 현재 page.tsx 확인**

Run: `sed -n '1,120p' src/app/page.tsx`
Expected: 현재 상태·핸들러(세션 생성 fetch), 입력 필드 구조 파악. 아래 스텝은 이 구조에 맞춰 삽입한다.

- [ ] **Step 2: 상태 및 핸들러 추가**

`src/app/page.tsx`의 컴포넌트 상단 상태 선언부에 추가 (기존 useState들 근처):

```tsx
  const [geminiApiKey, setGeminiApiKey] = useState("");
  // "idle" | "testing" | "ok" | "fail"
  const [keyStatus, setKeyStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [keyError, setKeyError] = useState<string | null>(null);
```

마운트 시 localStorage에서 마지막 키 자동채움 (컴포넌트 내 useEffect 추가, 이미 `useEffect` import 되어 있음을 Step 1에서 확인):

```tsx
  useEffect(() => {
    const saved = typeof window !== "undefined"
      ? localStorage.getItem("gemini_api_key")
      : null;
    if (saved) setGeminiApiKey(saved);
  }, []);
```

연결 테스트 핸들러 추가:

```tsx
  const testGeminiKey = async () => {
    const key = geminiApiKey.trim();
    if (!key) return;
    setKeyStatus("testing");
    setKeyError(null);
    try {
      const res = await fetch("/api/verify-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey: key }),
      });
      const data = await res.json();
      if (data.ok) {
        setKeyStatus("ok");
        localStorage.setItem("gemini_api_key", key);
      } else {
        setKeyStatus("fail");
        setKeyError(data.error || "키 검증에 실패했습니다.");
      }
    } catch {
      setKeyStatus("fail");
      setKeyError("네트워크 오류로 검증하지 못했습니다.");
    }
  };
```

키 입력이 바뀌면 통과 상태 초기화 (입력 onChange에서 호출):

```tsx
  const onKeyChange = (v: string) => {
    setGeminiApiKey(v);
    if (keyStatus !== "idle") {
      setKeyStatus("idle");
      setKeyError(null);
    }
  };
```

- [ ] **Step 3: 입력 필드 + 테스트 버튼 마크업 추가**

`src/app/page.tsx`의 폼에서 "방송 비밀번호 입력" 필드 근처(비밀번호 위 또는 아래)에 삽입. 클래스는 기존 입력 필드와 동일한 것을 사용(Step 1에서 확인한 클래스명으로 맞출 것 — 예: `input-field`):

```tsx
        <div style={{ marginBottom: 12 }}>
          <input
            type="password"
            className="input-field"
            placeholder="Gemini API Key (본인 키)"
            value={geminiApiKey}
            onChange={(e) => onKeyChange(e.target.value)}
            style={{ width: "100%" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={testGeminiKey}
              disabled={!geminiApiKey.trim() || keyStatus === "testing"}
            >
              {keyStatus === "testing" ? "확인 중…" : "연결 테스트"}
            </button>
            {keyStatus === "ok" && (
              <span style={{ color: "var(--success)", fontSize: 13 }}>✓ 연결됨</span>
            )}
            {keyStatus === "fail" && (
              <span style={{ color: "var(--error)", fontSize: 13 }}>{keyError}</span>
            )}
          </div>
        </div>
```

- [ ] **Step 4: "세션 만들기" 게이팅 + 키 전송**

"세션 만들기" 버튼에 `disabled={keyStatus !== "ok"}`를 추가한다 (기존 disabled 조건이 있으면 OR로 합친다). 그리고 세션 생성 fetch의 body에 `geminiApiKey`를 추가한다 (Step 1에서 찾은 `/api/sessions` POST 호출의 `JSON.stringify({...})`에 `geminiApiKey: geminiApiKey.trim()` 필드 추가).

- [ ] **Step 5: 타입체크 & 린트**

Run: `npx tsc --noEmit && npx eslint src/app/page.tsx`
Expected: 0 errors

- [ ] **Step 6: 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 7: (사용자 확인) 브라우저 수동 검증**

개발 서버에서 랑딩 접속 후 확인:
- 키 미입력 → "세션 만들기" 비활성.
- 무효 키 + 연결 테스트 → 빨간 에러, 버튼 여전히 비활성.
- 유효 키 + 연결 테스트 → "✓ 연결됨", "세션 만들기" 활성 → 클릭 시 방송 페이지로 이동, 통역 정상.
- 새로고침 시 키 입력칸이 자동채움되는지.

- [ ] **Step 8: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(byok): 랑딩에 Gemini 키 입력 + 연결 테스트 + 세션 생성 게이팅"
```

---

## Task A5: BYOK 보안 감사 (로그 노출 0 확인)

**Files:**
- (변경 없음 — 감사만)

- [ ] **Step 1: 키/URL 로그 경로 전수 확인**

Run: `grep -rn "console\." src/ | grep -iE "geminiApiKey|apiKey|wsUrl|\?key="`
Expected: 출력 없음.

- [ ] **Step 2: Gemini WS URL이 로그로 새지 않는지 확인**

Run: `grep -rn "generativelanguage.googleapis.com" src/`
Expected: `translation-bridge.ts`(connectGemini/reconnectGemini)와 `verify-key/route.ts`에만 등장하고, 각 라인이 `console.log(...)`의 인자가 아님(‑ URL은 `wsUrl` 변수로만 쓰이고 로그되지 않음). 육안 확인.

- [ ] **Step 3: 최종 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 4: (감사 결과가 깨끗하면) 별도 커밋 불필요**

감사에서 수정이 필요하면 그 파일만 고쳐 커밋하고, 아니면 스킵.

---

# Part B — 청자 재생 토글

## Task B1: `StartAudio`를 하단 고정 재생 토글로 교체

**Files:**
- Modify: `src/app/session/[id]/watch/page.tsx`

**Interfaces:**
- Consumes: `@livekit/components-react`의 `RoomAudioRenderer`(muted prop), `useAudioPlayback`.
- Produces: 없음(최종 UI).

- [ ] **Step 1: import 교체**

`src/app/session/[id]/watch/page.tsx` 상단 import에서 `StartAudio`를 제거하고 `useAudioPlayback`을 추가:

```tsx
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useTracks,
  useAudioPlayback,
} from "@livekit/components-react";
```

(주의: `StartAudio`가 다른 곳에서 안 쓰이는지 확인 — Run: `grep -n "StartAudio" src/app/session/[id]/watch/page.tsx`, JSX 사용부까지 함께 제거해야 함.)

- [ ] **Step 2: 재생 상태 + 토글 핸들러 추가**

`AttendeeView` 컴포넌트 내부(상태 선언부 근처)에 추가:

```tsx
  const [playbackEnabled, setPlaybackEnabled] = useState(false);
  const { canPlayAudio, startAudio } = useAudioPlayback(room);

  const togglePlayback = async () => {
    if (playbackEnabled) {
      setPlaybackEnabled(false);
      return;
    }
    if (!canPlayAudio) {
      try {
        await startAudio();
      } catch {
        // startAudio 실패 시에도 muted=false로 두면 다음 상호작용에서 재생 시도됨
      }
    }
    setPlaybackEnabled(true);
  };
```

- [ ] **Step 3: RoomAudioRenderer에 muted 바인딩**

같은 파일에서 `<RoomAudioRenderer />`를 교체:

```tsx
        <RoomAudioRenderer muted={!playbackEnabled} />
```

- [ ] **Step 4: 기존 StartAudio JSX 제거 + 하단 고정 토글 추가**

`<StartAudio ... />` 블록(주석 포함)을 삭제한다. 그리고 `AttendeeView`의 최상위 반환 컨테이너(`<div className="container enter">`) 안, 맨 끝(닫는 `</div>` 직전)에 하단 고정 버튼과, 버튼에 가리지 않도록 하단 여백을 추가:

```tsx
      {/* 스크롤과 무관하게 항상 하단에 고정되는 재생 On/Off 토글 */}
      <div style={{ height: 88 }} aria-hidden />
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          justifyContent: "center",
          padding: "16px",
          background: "linear-gradient(to top, var(--bg) 60%, transparent)",
          zIndex: 50,
          pointerEvents: "none",
        }}
      >
        <button
          onClick={togglePlayback}
          className={playbackEnabled ? "btn btn-outline" : "btn btn-dark"}
          style={{ width: "100%", maxWidth: 480, pointerEvents: "auto" }}
        >
          {playbackEnabled ? "⏸ 소리 끄기" : "🔊 소리 켜기"}
        </button>
      </div>
```

(주의: `--bg` 변수명은 실제 globals.css의 배경 변수명과 일치시킬 것 — Run: `grep -n "\-\-bg\b\|--bg:" src/app/globals.css`로 확인 후 맞는 이름 사용.)

- [ ] **Step 5: 타입체크 & 린트**

Run: `npx tsc --noEmit && npx eslint "src/app/session/[id]/watch/page.tsx"`
Expected: 0 errors (신규 에러 없음; 기존 파일의 사전 존재 경고는 대상 아님)

- [ ] **Step 6: 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 7: (사용자 확인) 브라우저 수동 검증**

- 데스크톱: watch 진입 → "🔊 소리 켜기" → 소리 재생/라벨 "⏸ 소리 끄기" → 다시 누르면 즉시 음소거.
- 모바일(또는 자동재생 차단): 첫 "소리 켜기" 탭에서 소리가 풀리고, 이후 껐다 켜기 반복 동작.
- 자막을 아래로 스크롤해도 버튼이 화면 하단에 계속 보이고, 마지막 자막이 버튼에 가리지 않음.

- [ ] **Step 8: Commit**

```bash
git add "src/app/session/[id]/watch/page.tsx"
git commit -m "feat(watch): 번역 오디오 하단 고정 재생 On/Off 토글 (StartAudio 대체)"
```

---

## Self-Review 체크 결과

- **스펙 커버리지**:
  - BYOK ① 랑딩 키 입력+테스트 → Task A4. ② verify-key 엔드포인트 → Task A2 (모델명 공유 → A1). ③ 세션 키 저장·사용·키 필수 → Task A3. ④ 보안(로그 0) → Task A2/A3에 내재 + Task A5 감사. → 전부 커버.
  - 재생 토글: StartAudio 제거·muted 바인딩·하단 고정·startAudio 잠금해제 → Task B1. → 커버.
- **플레이스홀더 스캔**: 코드 스텝마다 실제 코드 포함. UI 삽입 스텝(A4 Step3/4, B1 Step4)은 기존 클래스명/CSS 변수명을 grep로 확인 후 맞추도록 명시(저장소별 상이할 수 있는 값이라 확인 지시가 정확한 방법).
- **타입 일관성**: `createSession(..., geminiApiKey)`, `buildBridgeConfig(sessionId)`, verify 응답 `{ok}` 형태가 A2·A3·A4에서 일관.

## Execution Handoff (문서 하단 참고)

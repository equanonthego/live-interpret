# 발표자료 기반 용어집·맥락 주입 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 발표자가 올린 강의 PDF에서 Gemini Flash로 제목·발표자·도메인 요약·용어집을 추출해, 요약·용어집은 Gemini 3.5 Live 번역에 systemInstruction으로 주입하고 제목·발표자는 세션 화면에 표시한다.

**Architecture:** 세션 생성 시 서버가 PDF를 Gemini Flash(REST `generateContent`)로 보내 구조화 JSON을 받는다. 결과를 세션 메모리에 저장하고, 브릿지 config로 흘려보내 setup의 systemInstruction으로 조립한다. 제목·발표자는 세션 생성 응답과 GET 세션 라우트로 클라이언트에 전달해 표시한다. PDF는 선택이며 없으면 기존 흐름 그대로다.

**Tech Stack:** Next.js(App Router, 이 저장소는 breaking-change 버전 — 필요 시 `node_modules/next/dist/docs/` 참조), TypeScript, 기존 raw `fetch`(SDK 추가 없음), LiveKit rtc-node, Gemini Live(WebSocket) + Gemini Flash(REST).

## Global Constraints

- 이 코드베이스는 **단위 테스트 프레임워크가 없다**. 각 태스크의 검증은 `npx tsc --noEmit` + `npx eslint <file>` + 명시된 런타임 확인으로 한다. 새 테스트 러너/의존성을 추가하지 않는다.
- 커밋 전 항상 `npx tsc --noEmit`가 통과해야 한다. 미사용 임포트/변수 금지.
- 새 npm 의존성 추가 금지(REST/fetch로 해결). `@google/genai` 등 SDK 도입하지 않는다.
- 민감정보 로그 금지: geminiApiKey를 로그/응답에 남기지 않는다. PDF 원문 텍스트를 통째로 로그에 찍지 않는다.
- Gemini 추출 모델 기본값: `gemini-2.5-flash`. 해당 키에서 404/미지원이면 `gemini-flash-latest`로 대체(태스크 1에서 런타임 확인).
- 앱 실행/재시작은 프로젝트 런처로: 메인 폴더에서 `통역서버.command`를 실행(토글). 서버측(브릿지/라우트) 변경은 재시작해야 반영된다.

---

## File Structure

- **Create** `src/lib/glossary-extractor.ts` — 타입(`GlossaryTerm`, `PresentationContext`) + `extractPresentationContext(pdfBytes, mime, geminiApiKey)`.
- **Modify** `src/lib/interpret-config.ts` — 추출 모델 상수 `GEMINI_EXTRACT_MODEL` 추가.
- **Modify** `src/lib/translation-bridge.ts` — 브릿지 config에 `presentationContext?` 추가 + `sendGeminiSetup`에서 systemInstruction 조립.
- **Modify** `src/lib/translation-session-manager.ts` — `SessionInfo`에 `presentationContext?` 추가, `createSession` 파라미터 추가, `buildBridgeConfig`에 주입.
- **Modify** `src/app/api/sessions/route.ts` — FormData 수신, PDF 추출 호출, 세션 저장, 응답에 title·presenter.
- **Modify** `src/app/api/sessions/[sessionId]/route.ts` — GET 응답 정리(geminiApiKey·presentationContext 제외, title·presenter만 추가).
- **Modify** `src/app/page.tsx` — PDF 업로드 입력 + FormData 제출.
- **Modify** `src/app/session/[id]/broadcast/page.tsx` — title·presenter 표시.
- **Modify** `src/app/session/[id]/watch/page.tsx` — title·presenter 표시.

---

## Task 1: 추출 모듈 (Flash → PresentationContext)

**Files:**
- Create: `src/lib/glossary-extractor.ts`
- Modify: `src/lib/interpret-config.ts`

**Interfaces:**
- Produces:
  - `interface GlossaryTerm { term: string; note: string }`
  - `interface PresentationContext { title: string; presenter: string; domainSummary: string; glossary: GlossaryTerm[] }`
  - `async function extractPresentationContext(pdfBytes: Uint8Array, mime: string, geminiApiKey: string): Promise<PresentationContext | null>` — 실패 시 `null`.
  - `GEMINI_EXTRACT_MODEL: string` (from interpret-config)

- [ ] **Step 1: 추출 모델 상수 추가**

`src/lib/interpret-config.ts` 끝에 추가:

```ts
// 발표자료(PDF)에서 제목·발표자·용어집을 추출하는 모델. Live 모델과 별개.
// 해당 키에서 미지원이면 "gemini-flash-latest"로 교체.
export const GEMINI_EXTRACT_MODEL = "gemini-2.5-flash";
```

- [ ] **Step 2: 추출 모듈 작성**

`src/lib/glossary-extractor.ts` 생성:

```ts
import { GEMINI_EXTRACT_MODEL } from "./interpret-config";

export interface GlossaryTerm {
  term: string; // 소스(한국어) 용어
  note: string; // 의미 + 번역 처리 지침 (언어 중립)
}

export interface PresentationContext {
  title: string; // 없으면 ""
  presenter: string; // 없으면 ""
  domainSummary: string;
  glossary: GlossaryTerm[];
}

const EXTRACT_PROMPT = `You are analyzing a lecture's slide deck / handout to help a live interpreter.
Return JSON with these fields:
- "title": the presentation title exactly as written, or "" if none is found.
- "presenter": the speaker/author/presenter name exactly as written, or "" if none.
- "domainSummary": 2-4 sentences summarizing the subject domain, for translation context.
- "glossary": array of the key terms whose consistent translation matters. For each: "term" (the term in its original language) and "note" (its meaning and how it should be handled when translating, language-neutral — do NOT hardcode a specific target language).
Only output the JSON object.`;

// Gemini Flash(REST generateContent)로 PDF를 분석해 PresentationContext 반환.
// 어떤 이유로든(잘못된 PDF, API 오류, JSON 파싱 실패, 타임아웃) 실패하면 null.
export async function extractPresentationContext(
  pdfBytes: Uint8Array,
  mime: string,
  geminiApiKey: string
): Promise<PresentationContext | null> {
  try {
    const base64 = Buffer.from(pdfBytes).toString("base64");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EXTRACT_MODEL}:generateContent?key=${encodeURIComponent(
      geminiApiKey
    )}`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: base64 } },
            { text: EXTRACT_PROMPT },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            presenter: { type: "STRING" },
            domainSummary: { type: "STRING" },
            glossary: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  term: { type: "STRING" },
                  note: { type: "STRING" },
                },
                required: ["term", "note"],
              },
            },
          },
          required: ["title", "presenter", "domainSummary", "glossary"],
        },
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      console.error(
        `[glossary-extractor] Flash HTTP ${res.status} (model ${GEMINI_EXTRACT_MODEL})`
      );
      return null;
    }

    const data = await res.json();
    const text: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("[glossary-extractor] Empty Flash response");
      return null;
    }

    const parsed = JSON.parse(text);
    const glossary: GlossaryTerm[] = Array.isArray(parsed.glossary)
      ? parsed.glossary
          .filter(
            (g: unknown): g is GlossaryTerm =>
              !!g &&
              typeof (g as GlossaryTerm).term === "string" &&
              typeof (g as GlossaryTerm).note === "string"
          )
          .map((g: GlossaryTerm) => ({ term: g.term, note: g.note }))
      : [];

    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      presenter: typeof parsed.presenter === "string" ? parsed.presenter : "",
      domainSummary:
        typeof parsed.domainSummary === "string" ? parsed.domainSummary : "",
      glossary,
    };
  } catch (err) {
    console.error("[glossary-extractor] extraction failed:", err);
    return null;
  }
}
```

- [ ] **Step 3: 타입/린트 검증**

Run: `npx tsc --noEmit && npx eslint src/lib/glossary-extractor.ts src/lib/interpret-config.ts`
Expected: 에러 0.

- [ ] **Step 4: 모델 사용성 런타임 확인 (선택이지만 권장)**

임시 스크립트 없이, 태스크 4 이후 실제 세션에서 확인한다(여기선 스킵 가능). 만약 태스크 4 런타임에서 `Flash HTTP 404`가 뜨면 `GEMINI_EXTRACT_MODEL`을 `gemini-flash-latest`로 바꾼다.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/glossary-extractor.ts src/lib/interpret-config.ts
git commit -m "feat(extract): PDF에서 제목·발표자·용어집 추출 모듈 (Gemini Flash)"
```

---

## Task 2: 브릿지 주입 (systemInstruction)

**Files:**
- Modify: `src/lib/translation-bridge.ts`

**Interfaces:**
- Consumes: `PresentationContext` (from `./glossary-extractor`)
- Produces: 브릿지 생성자 `config`가 선택 필드 `presentationContext?: PresentationContext`를 받는다.

- [ ] **Step 1: config 타입에 presentationContext 추가**

`src/lib/translation-bridge.ts` 상단 import에 추가:

```ts
import type { PresentationContext } from "./glossary-extractor";
```

생성자 `config` 객체 타입(현재 `geminiApiKey/livekitUrl/livekitApiKey/livekitApiSecret`)에 필드 추가:

```ts
    config: {
      geminiApiKey: string;
      livekitUrl: string;
      livekitApiKey: string;
      livekitApiSecret: string;
      presentationContext?: PresentationContext;
    },
```

그리고 클래스 필드 + 생성자 대입 추가(다른 `private readonly` 필드 근처):

```ts
  private readonly presentationContext?: PresentationContext;
```
생성자 본문(`this.livekitApiSecret = config.livekitApiSecret;` 다음)에:
```ts
    this.presentationContext = config.presentationContext;
```

- [ ] **Step 2: systemInstruction 조립 헬퍼 추가**

클래스 안(예: `sendGeminiSetup` 바로 위)에 메서드 추가:

```ts
  // presentationContext가 있으면 번역용 systemInstruction 텍스트를 만든다.
  // title·presenter는 표시 전용이라 주입하지 않는다. 내용이 비면 undefined.
  private buildSystemInstruction():
    | { parts: { text: string }[] }
    | undefined {
    const ctx = this.presentationContext;
    if (!ctx) return undefined;
    const summary = ctx.domainSummary?.trim();
    const terms = (ctx.glossary || []).filter(
      (g) => g.term?.trim() && g.note?.trim()
    );
    if (!summary && terms.length === 0) return undefined;

    const lines: string[] = ["You are translating a live lecture."];
    if (summary) lines.push(`Domain: ${summary}`);
    if (terms.length > 0) {
      lines.push(
        "Glossary (translate these terms consistently and accurately):"
      );
      for (const t of terms) lines.push(`- ${t.term}: ${t.note}`);
    }
    return { parts: [{ text: lines.join("\n") }] };
  }
```

- [ ] **Step 3: setup에 systemInstruction 삽입**

`sendGeminiSetup`의 `setupMessage` 조립에서, `setup` 객체에 조건부로 systemInstruction을 넣는다. 현재:

```ts
    const setupMessage = {
      setup: {
        model: `models/${this.geminiModel}`,
        outputAudioTranscription: {},
        contextWindowCompression: {
```

를 다음으로 바꾼다:

```ts
    const systemInstruction = this.buildSystemInstruction();
    const setupMessage = {
      setup: {
        model: `models/${this.geminiModel}`,
        outputAudioTranscription: {},
        ...(systemInstruction ? { systemInstruction } : {}),
        contextWindowCompression: {
```

- [ ] **Step 4: 타입/린트 검증**

Run: `npx tsc --noEmit && npx eslint src/lib/translation-bridge.ts`
Expected: 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/translation-bridge.ts
git commit -m "feat(bridge): presentationContext를 systemInstruction으로 주입"
```

---

## Task 3: 세션 저장 + 브릿지 배선

**Files:**
- Modify: `src/lib/translation-session-manager.ts`

**Interfaces:**
- Consumes: `PresentationContext` (from `./glossary-extractor`), 브릿지 config의 `presentationContext?` (Task 2).
- Produces: `createSession(sessionId, organizerIdentity, allowedLanguages, geminiApiKey, presentationContext?)`; `SessionInfo.presentationContext?`.

- [ ] **Step 1: import + SessionInfo 필드**

상단 import에 추가:
```ts
import type { PresentationContext } from "./glossary-extractor";
```

`SessionInfo` 인터페이스에 필드 추가(`geminiApiKey` 아래):
```ts
  // 발표자료에서 추출한 제목·발표자·도메인 요약·용어집. 없을 수 있음.
  presentationContext?: PresentationContext;
```

- [ ] **Step 2: createSession 파라미터 추가**

시그니처를 확장(마지막에 선택 파라미터):
```ts
  createSession(
    sessionId: string,
    organizerIdentity: string,
    allowedLanguages: string[] | undefined,
    geminiApiKey: string,
    presentationContext?: PresentationContext
  ): SessionInfo {
```

`info` 객체에 필드 추가:
```ts
    const info: SessionInfo = {
      sessionId,
      organizerIdentity,
      createdAt: new Date(),
      allowedLanguages,
      geminiApiKey,
      presentationContext,
      handRaised: [],
    };
```

- [ ] **Step 3: buildBridgeConfig에 주입**

`buildBridgeConfig`의 반환 객체에 세션의 presentationContext를 실어 모든 브릿지에 전달:
```ts
    return {
      geminiApiKey,
      livekitUrl: process.env.LIVEKIT_URL || "ws://localhost:7880",
      livekitApiKey: process.env.LIVEKIT_API_KEY!,
      livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
      presentationContext: session?.presentationContext,
    };
```

- [ ] **Step 4: 타입/린트 검증**

Run: `npx tsc --noEmit && npx eslint src/lib/translation-session-manager.ts`
Expected: 에러 0. (createSession 호출부는 Task 4에서 인자를 넘긴다. 지금은 선택 파라미터라 컴파일 OK.)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/translation-session-manager.ts
git commit -m "feat(session): presentationContext 저장 및 브릿지 config 주입"
```

---

## Task 4: 세션 생성 API (FormData + 추출) + GET 정리

**Files:**
- Modify: `src/app/api/sessions/route.ts`
- Modify: `src/app/api/sessions/[sessionId]/route.ts`

**Interfaces:**
- Consumes: `extractPresentationContext` (Task 1), `createSession(..., presentationContext?)` (Task 3).
- Produces: POST 응답에 `title`, `presenter` 필드; GET 응답에 `title`, `presenter`(geminiApiKey·presentationContext 미노출).

- [ ] **Step 1: POST 라우트를 FormData 수신으로 변경**

`src/app/api/sessions/route.ts`의 import에 추가:
```ts
import { extractPresentationContext } from "@/lib/glossary-extractor";
```

`export async function POST(req)`의 body 파싱 부분(현재 `const body = await req.json()...` 블록)을 아래로 교체. FormData와 JSON 둘 다 허용(하위호환):

```ts
  try {
    const contentType = req.headers.get("content-type") || "";
    let organizerName = "organizer";
    let eventId: string | undefined;
    let allowedLanguages: string[] | undefined = undefined;
    let geminiApiKey = "";
    let pdfBytes: Uint8Array | null = null;
    let pdfMime = "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      organizerName = (form.get("organizerName") as string) || "organizer";
      eventId = (form.get("eventId") as string) || undefined;
      geminiApiKey = ((form.get("geminiApiKey") as string) || "").trim();
      const langsRaw = form.get("allowedLanguages");
      if (typeof langsRaw === "string" && langsRaw.length > 0) {
        try {
          const arr = JSON.parse(langsRaw);
          if (Array.isArray(arr)) {
            allowedLanguages = arr.filter((l) => typeof l === "string");
          }
        } catch {
          /* ignore malformed */
        }
      }
      const file = form.get("presentation");
      if (file && file instanceof File && file.size > 0) {
        pdfBytes = new Uint8Array(await file.arrayBuffer());
        pdfMime = file.type || "application/pdf";
      }
    } else {
      const body = await req.json().catch(() => ({}));
      organizerName = body.organizerName || "organizer";
      eventId = body.eventId;
      if (Array.isArray(body.allowedLanguages)) {
        allowedLanguages = body.allowedLanguages.filter(
          (l: unknown) => typeof l === "string"
        );
      }
      geminiApiKey =
        typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";
    }

    if (!geminiApiKey) {
      return NextResponse.json({ error: "Missing geminiApiKey" }, { status: 400 });
    }
```

주의: 이 블록은 기존 `try {` 이후의 파싱을 대체한다. 이후의 `sessionId` 계산 로직(`eventId` 사용)과 나머지는 그대로 둔다.

- [ ] **Step 2: 추출 호출 + createSession에 전달**

`manager.createSession(...)` 호출 직전에 추출을 수행하고, 호출에 인자를 추가한다. 기존:
```ts
    manager.createSession(sessionId, organizerIdentity, allowedLanguages, geminiApiKey);
```
를 아래로 교체:
```ts
    let presentationContext = undefined;
    if (pdfBytes) {
      presentationContext =
        (await extractPresentationContext(pdfBytes, pdfMime, geminiApiKey)) ??
        undefined;
    }

    manager.createSession(
      sessionId,
      organizerIdentity,
      allowedLanguages,
      geminiApiKey,
      presentationContext
    );
```

- [ ] **Step 3: POST 응답에 title·presenter 추가**

기존 응답 객체에 필드를 더한다:
```ts
    return NextResponse.json({
      sessionId,
      organizerIdentity,
      joinUrl,
      broadcastUrl: `${protocol}://${host}/session/${sessionId}/broadcast`,
      title: presentationContext?.title ?? "",
      presenter: presentationContext?.presenter ?? "",
    });
```

- [ ] **Step 4: GET 라우트 정리(민감정보 제외 + title·presenter)**

`src/app/api/sessions/[sessionId]/route.ts`의 GET 반환을 교체. 기존:
```ts
  return NextResponse.json({
    ...session,
    translations,
  });
```
를 아래로 (geminiApiKey·presentationContext 제외, title·presenter만 노출):
```ts
  const { geminiApiKey: _k, presentationContext, ...safe } = session;
  void _k;
  return NextResponse.json({
    ...safe,
    title: presentationContext?.title ?? "",
    presenter: presentationContext?.presenter ?? "",
    translations,
  });
```

- [ ] **Step 5: 타입/린트 검증**

Run: `npx tsc --noEmit && npx eslint "src/app/api/sessions/route.ts" "src/app/api/sessions/[sessionId]/route.ts"`
Expected: 에러 0.

- [ ] **Step 6: 런타임 확인 (추출 경로)**

메인 폴더에서 `통역서버.command`로 재시작. 그다음(태스크 7의 UI 전이라면 임시로 curl):
```bash
curl -s -X GET "http://localhost:3000/api/sessions/nonexistent" -o /dev/null -w "%{http_code}\n"
```
Expected: `404`(라우트 정상 동작). 실제 PDF 추출은 태스크 7 UI 완료 후 E2E로 확인. 이때 서버 로그에 `Flash HTTP 404`가 보이면 `GEMINI_EXTRACT_MODEL`을 `gemini-flash-latest`로 바꾸고 재확인.

- [ ] **Step 7: 커밋**

```bash
git add "src/app/api/sessions/route.ts" "src/app/api/sessions/[sessionId]/route.ts"
git commit -m "feat(api): 세션 생성 시 PDF 추출 + title·presenter 노출, GET 민감정보 제외"
```

---

## Task 5: 홈 화면 PDF 업로드

**Files:**
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: POST `/api/sessions`가 이제 FormData(멀티파트)를 받는다(Task 4).

- [ ] **Step 1: PDF 파일 상태 추가**

`page.tsx`의 컴포넌트 상태 근처(다른 `useState` 옆)에 추가:
```ts
  const [pdfFile, setPdfFile] = useState<File | null>(null);
```

- [ ] **Step 2: 이벤트 ID 입력 아래에 파일 입력 추가**

기존 이벤트 ID `<input>` 아래에 PDF 업로드 입력을 추가한다(레이아웃은 주변 스타일을 따른다):
```tsx
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
            disabled={loading}
            style={{ fontSize: 13 }}
          />
          {pdfFile && (
            <p className="body-sm" style={{ color: "var(--fg-secondary)" }}>
              발표자료: {pdfFile.name}
            </p>
          )}
```

- [ ] **Step 3: createSession을 FormData 제출로 변경**

기존 `createSession`의 `fetch("/api/sessions", { ... json ... })` 부분을 FormData로 교체:
```ts
      const form = new FormData();
      form.append("organizerName", "host");
      form.append("eventId", eventId);
      form.append("allowedLanguages", JSON.stringify(DEFAULT_INTERPRET_LANGUAGES));
      form.append("geminiApiKey", geminiApiKey.trim());
      if (pdfFile) form.append("presentation", pdfFile);

      const res = await fetch("/api/sessions", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create session");
      }
      router.push(`/session/${data.sessionId}/broadcast`);
```

(주의: FormData 사용 시 `Content-Type` 헤더를 직접 넣지 않는다 — 브라우저가 boundary 포함해 자동 설정.)

- [ ] **Step 4: 로딩 문구 보강(선택)**

`세션 만들기` 버튼의 로딩 라벨이 이미 "생성 중…"이면 그대로 둔다. PDF 추출로 수 초 걸릴 수 있으므로 사용자에게 대기가 자연스럽게 보인다.

- [ ] **Step 5: 타입/린트 검증**

Run: `npx tsc --noEmit && npx eslint src/app/page.tsx`
Expected: 에러 0.

- [ ] **Step 6: 커밋**

```bash
git add src/app/page.tsx
git commit -m "feat(home): 발표자료 PDF 업로드 입력 + FormData 제출"
```

---

## Task 6: 제목·발표자 표시 (broadcast + watch)

**Files:**
- Modify: `src/app/session/[id]/broadcast/page.tsx`
- Modify: `src/app/session/[id]/watch/page.tsx`

**Interfaces:**
- Consumes: broadcast는 URL로 넘어오지 않으므로 GET `/api/sessions/:id`에서 title·presenter를 읽는다. watch는 이미 `GET /api/sessions/:id`를 호출(라인 ~106)하므로 그 응답의 title·presenter를 사용.

- [ ] **Step 1: watch 페이지에 title·presenter 표시**

`watch/page.tsx`에서 `/api/sessions/${sessionId}` 응답을 저장하는 상태를 찾는다(라인 ~106 인근). 응답 데이터에서 title·presenter를 상태로 보관:
```ts
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionPresenter, setSessionPresenter] = useState("");
```
fetch 성공 처리부에 추가:
```ts
        setSessionTitle(data.title || "");
        setSessionPresenter(data.presenter || "");
```
헤더 영역(언어 선택 위 등 적절한 위치)에 표시:
```tsx
        {(sessionTitle || sessionPresenter) && (
          <div className="body-sm" style={{ color: "var(--fg-secondary)", marginBottom: 12 }}>
            {sessionTitle}
            {sessionTitle && sessionPresenter ? " — " : ""}
            {sessionPresenter}
          </div>
        )}
```

- [ ] **Step 2: broadcast 페이지에서 세션 정보 로드 + 표시**

`broadcast/page.tsx`에 상태 추가:
```ts
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionPresenter, setSessionPresenter] = useState("");
```
세션 정보를 한 번 가져오는 effect 추가(다른 useEffect 근처):
```ts
  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((d) => {
        setSessionTitle(d.title || "");
        setSessionPresenter(d.presenter || "");
      })
      .catch(() => {});
  }, [sessionId]);
```
QR/제어판 헤더 근처에 표시:
```tsx
        {(sessionTitle || sessionPresenter) && (
          <div className="body-sm" style={{ color: "var(--fg-secondary)", marginBottom: 12 }}>
            {sessionTitle}
            {sessionTitle && sessionPresenter ? " — " : ""}
            {sessionPresenter}
          </div>
        )}
```

- [ ] **Step 3: 타입/린트 검증**

Run: `npx tsc --noEmit && npx eslint "src/app/session/[id]/broadcast/page.tsx" "src/app/session/[id]/watch/page.tsx"`
Expected: 에러 0(내 변경 기준 신규 에러 0 — 두 파일엔 기존 린트 에러가 있을 수 있으니 변경 전후 개수 비교).

- [ ] **Step 4: 커밋**

```bash
git add "src/app/session/[id]/broadcast/page.tsx" "src/app/session/[id]/watch/page.tsx"
git commit -m "feat(ui): 세션 제목·발표자 표시 (broadcast + watch)"
```

---

## Task 7: E2E 런타임 검증

**Files:** (없음 — 실행/관찰만)

- [ ] **Step 1: 앱 재시작**

메인 폴더에서 `통역서버.command` 실행(off→on). livekit + 앱 기동 확인.

- [ ] **Step 2: PDF 있는 세션 (해피패스)**

`http://localhost:3000`에서 API 키 입력 → **강의 PDF 업로드** → 세션 만들기. 확인:
- broadcast 화면에 **제목·발표자** 표시.
- 폰(watch)로 QR 접속 → **제목·발표자** 표시.
- 서버 로그에 `Flash HTTP 404` 없음(있으면 `GEMINI_EXTRACT_MODEL`을 `gemini-flash-latest`로 교체 후 재시작).
- 자료에 있는 용어를 발화 → 청자 언어 출력이 용어집 취지대로 나오는지 확인(spike 방식).

- [ ] **Step 3: PDF 없는 세션 (회귀)**

PDF 없이 세션 생성 → 제목·발표자 미표시, 번역 정상 동작(systemInstruction 없이). 기존 흐름 회귀 없음.

- [ ] **Step 4: 보안 확인**

```bash
curl -s "http://localhost:3000/api/sessions/<실제세션ID>" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('has geminiApiKey:', 'geminiApiKey' in j, '| has presentationContext:', 'presentationContext' in j, '| title:', JSON.stringify(j.title));})"
```
Expected: `has geminiApiKey: false | has presentationContext: false | title: "..."`.

- [ ] **Step 5: 최종 커밋(있으면)**

런타임 중 모델명 교체 등 코드 수정이 있었으면 커밋:
```bash
git add -A && git commit -m "fix(extract): 추출 모델명 조정" # 필요 시에만
```

---

## Self-Review 결과

- **스펙 커버리지**: 추출(T1)·주입(T2)·저장(T3)·API+보안(T4)·업로드 UI(T5)·표시(T6)·E2E(T7) — 스펙 4.1~4.6 및 6·8 전부 태스크 존재.
- **플레이스홀더**: 없음(모든 코드 블록 실제 내용).
- **타입 일관성**: `PresentationContext`/`GlossaryTerm`/`extractPresentationContext`/`buildSystemInstruction`/`createSession(...presentationContext?)`/`buildBridgeConfig` 필드명 태스크 간 일치.
- **회귀 보호**: JSON 하위호환 유지(T4), presentationContext 없으면 systemInstruction 미삽입(T2), 표시 조건부(T6).

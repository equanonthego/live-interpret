# 발표자료 전체보기 + 자막·QR 오버레이 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 발표자가 올린 발표자료(PDF/HTML)를 broadcast 화면에서 전체화면으로 띄우고, 키보드 ←/→로 넘기며, 하단 한국어 자막 2줄과 우하단 QR을 오버레이한다. ESC로 방송 제어 화면 복귀.

**Architecture:** 세션 생성 시 원본 파일을 서버 메모리에 보관하고 `/api/sessions/[id]/presentation`으로 스트림한다. broadcast는 `hasPresentation`이면 "전체보기" 버튼을 띄우고, 클릭 시 PresentationViewer(고정 전체화면 오버레이)가 파일을 받아 PDF는 pdfjs-dist 캔버스로, HTML은 iframe으로 렌더한다.

**Tech Stack:** Next.js(App Router; 이 저장소는 breaking-change 버전 — 자산/워커 처리는 `node_modules/next/dist/docs/` 확인), TypeScript, pdfjs-dist(신규), 기존 SessionQRCode.

## Global Constraints

- 테스트 프레임워크 없음. 검증은 `npx tsc --noEmit` + `npx eslint <file>` + 런타임(E2E).
- 커밋 전 `npx tsc --noEmit` 통과. 미사용 임포트/변수 금지.
- 이 스펙은 **pdfjs-dist 1개** 의존성 추가를 허용한다(그 외 신규 의존성 금지).
- geminiApiKey·용어집·파일 바이트는 세션 정보 GET 응답에 노출하지 않는다. `/presentation`만 바이트를 반환.
- 앱 실행/재시작은 메인 폴더에서 `통역서버.command`(토글). 서버측 변경은 재시작 반영. 워크트리 변경은 메인으로 cp 후 재시작해 런타임 확인.

---

## File Structure

- **Add dep** `pdfjs-dist` + `public/pdf.worker.min.mjs`(워커 복사).
- **Modify** `src/lib/translation-session-manager.ts` — `SessionInfo.presentationFile`, `createSession` 6번째 파라미터.
- **Modify** `src/app/api/sessions/route.ts` — 파일 바이트를 presentationFile로 저장.
- **Modify** `src/app/api/sessions/[sessionId]/route.ts` — GET에 `hasPresentation`, `presentationMime`.
- **Create** `src/app/api/sessions/[sessionId]/presentation/route.ts` — 바이트 스트림.
- **Modify** `src/app/page.tsx` — 세션 생성 시 원본 파일 첨부.
- **Create** `src/app/session/[id]/broadcast/PresentationViewer.tsx` — 전체화면 뷰어.
- **Modify** `src/app/session/[id]/broadcast/page.tsx` — 버튼 + 뷰어 + 자막 전달.

---

## Task 1: pdfjs-dist 설치 + 워커 배치

**Files:** package.json, public/pdf.worker.min.mjs

- [ ] **Step 1: 설치**

Run: `npm install pdfjs-dist`
Expected: package.json dependencies에 pdfjs-dist 추가.

- [ ] **Step 2: 워커를 public으로 복사(버전 일치 보장)**

Run:
```bash
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs
ls -la public/pdf.worker.min.mjs
```
Expected: 파일 존재. (없으면 `node_modules/pdfjs-dist/build/`에서 `pdf.worker.min.js` 등 실제 파일명 확인 후 복사.)

- [ ] **Step 3: 커밋**

```bash
git add package.json package-lock.json public/pdf.worker.min.mjs
git commit -m "chore: pdfjs-dist 추가 + 워커 public 배치"
```

---

## Task 2: 파일 저장·서빙 백엔드

**Files:**
- Modify: `src/lib/translation-session-manager.ts`
- Modify: `src/app/api/sessions/route.ts`
- Modify: `src/app/api/sessions/[sessionId]/route.ts`
- Create: `src/app/api/sessions/[sessionId]/presentation/route.ts`

**Interfaces:**
- Produces:
  - `SessionInfo.presentationFile?: { name: string; mime: string; bytes: Buffer }`
  - `createSession(sessionId, organizerIdentity, allowedLanguages, geminiApiKey, presentationContext?, presentationFile?)`
  - GET `/api/sessions/[id]` 응답에 `hasPresentation: boolean`, `presentationMime: string`
  - GET `/api/sessions/[id]/presentation` → 바이트(Content-Type=mime) 또는 404

- [ ] **Step 1: SessionInfo + createSession**

`translation-session-manager.ts`의 `SessionInfo`에 필드 추가(`presentationContext?` 아래):
```ts
  // 발표자료 원본 파일(전체보기 렌더용). 서버 메모리에만 보관.
  presentationFile?: { name: string; mime: string; bytes: Buffer };
```
`createSession` 시그니처와 info에 추가:
```ts
  createSession(
    sessionId: string,
    organizerIdentity: string,
    allowedLanguages: string[] | undefined,
    geminiApiKey: string,
    presentationContext?: PresentationContext,
    presentationFile?: { name: string; mime: string; bytes: Buffer }
  ): SessionInfo {
    const info: SessionInfo = {
      sessionId,
      organizerIdentity,
      createdAt: new Date(),
      allowedLanguages,
      geminiApiKey,
      presentationContext,
      presentationFile,
      handRaised: [],
    };
```

- [ ] **Step 2: 세션 생성 시 파일 저장**

`api/sessions/route.ts`에서 파일 바이트/이름을 확보해 createSession에 전달. FormData 브랜치의 파일 파싱부에 파일명도 잡는다:
```ts
      const file = form.get("presentation");
      if (file && file instanceof File && file.size > 0) {
        pdfBytes = new Uint8Array(await file.arrayBuffer());
        pdfMime = file.type || "application/pdf";
        pdfName = file.name || "presentation";
      }
```
(상단 변수 선언에 `let pdfName = "";` 추가.)

createSession 호출을 확장:
```ts
    const presentationFile = pdfBytes
      ? { name: pdfName, mime: pdfMime, bytes: Buffer.from(pdfBytes) }
      : undefined;

    manager.createSession(
      sessionId,
      organizerIdentity,
      allowedLanguages,
      geminiApiKey,
      presentationContext,
      presentationFile
    );
```

- [ ] **Step 3: GET 세션 정보에 hasPresentation**

`api/sessions/[sessionId]/route.ts` GET 반환을 확장(민감정보 제외는 유지):
```ts
  const { geminiApiKey: _k, presentationContext, presentationFile, ...safe } =
    session;
  void _k;
  return NextResponse.json({
    ...safe,
    title: presentationContext?.title ?? "",
    presenter: presentationContext?.presenter ?? "",
    hasPresentation: !!presentationFile,
    presentationMime: presentationFile?.mime ?? "",
    translations,
  });
```

- [ ] **Step 4: 발표자료 스트림 라우트 생성**

Create `src/app/api/sessions/[sessionId]/presentation/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";

// GET /api/sessions/:id/presentation — 세션의 발표자료 원본을 반환.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const manager = TranslationSessionManager.getInstance();
  const session = manager.getSession(sessionId);
  const file = session?.presentationFile;
  if (!file) {
    return NextResponse.json({ error: "No presentation" }, { status: 404 });
  }
  const body = new Uint8Array(file.bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": file.mime || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 5: 타입/린트**

Run: `npx tsc --noEmit && npx eslint src/lib/translation-session-manager.ts "src/app/api/sessions/route.ts" "src/app/api/sessions/[sessionId]/route.ts" "src/app/api/sessions/[sessionId]/presentation/route.ts"`
Expected: 에러 0.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/translation-session-manager.ts "src/app/api/sessions/route.ts" "src/app/api/sessions/[sessionId]/route.ts" "src/app/api/sessions/[sessionId]/presentation/route.ts"
git commit -m "feat(presentation): 원본 파일 보관 + hasPresentation + 스트림 라우트"
```

---

## Task 3: 홈 — 세션 생성 시 원본 파일 첨부

**Files:** `src/app/page.tsx`

**Interfaces:** Consumes: `/api/sessions`가 `presentation` 파일 필드를 받아 저장(Task 2).

- [ ] **Step 1: createSession FormData에 파일 추가**

`page.tsx`의 `createSession`에서 presentationContext append 뒤에 원본 파일도 첨부:
```ts
      if (analysis) {
        form.append("presentationContext", JSON.stringify(analysis));
      }
      if (pdfFile) form.append("presentation", pdfFile);
```

- [ ] **Step 2: 타입/린트**

Run: `npx tsc --noEmit && npx eslint src/app/page.tsx`
Expected: 에러 0.

- [ ] **Step 3: 커밋**

```bash
git add src/app/page.tsx
git commit -m "feat(home): 세션 생성 시 발표자료 원본도 업로드"
```

---

## Task 4: PresentationViewer 컴포넌트

**Files:** Create `src/app/session/[id]/broadcast/PresentationViewer.tsx`

**Interfaces:**
- Produces: `export default function PresentationViewer(props: { sessionId: string; mime: string; joinUrl: string; captions: string[]; onClose: () => void })`
- Consumes: `SessionQRCode`(기존 `@/components/SessionQRCode`), `/api/sessions/[id]/presentation`, `pdfjs-dist`.

- [ ] **Step 1: 컴포넌트 작성**

Create the file:
```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import SessionQRCode from "@/components/SessionQRCode";

interface Props {
  sessionId: string;
  mime: string;
  joinUrl: string;
  captions: string[];
  onClose: () => void;
}

export default function PresentationViewer({
  sessionId,
  mime,
  joinUrl,
  captions,
  onClose,
}: Props) {
  const isPdf = mime.includes("pdf");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [blobUrl, setBlobUrl] = useState<string>("");
  const [pdf, setPdf] = useState<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>("");

  // 파일 로드
  useEffect(() => {
    let revoked = "";
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/presentation`);
        if (!res.ok) throw new Error("load failed");
        const buf = await res.arrayBuffer();
        if (isPdf) {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
          if (!cancelled) setPdf(doc as unknown as typeof pdf);
        } else {
          const url = URL.createObjectURL(new Blob([buf], { type: mime || "text/html" }));
          revoked = url;
          if (!cancelled) setBlobUrl(url);
        }
      } catch {
        if (!cancelled) setError("발표자료를 불러오지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [sessionId, isPdf, mime]);

  // PDF 현재 페이지 렌더 (화면에 맞게 스케일)
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = await (pdf as any).getPage(page);
      if (cancelled) return;
      const unscaled = p.getViewport({ scale: 1 });
      const scale = Math.min(
        (window.innerWidth * 0.96) / unscaled.width,
        (window.innerHeight * 0.9) / unscaled.height
      );
      const viewport = p.getViewport({ scale });
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await p.render({ canvasContext: ctx, viewport }).promise;
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  // 키보드: ←/→ 페이지, ESC 닫기
  useEffect(() => {
    const numPages = (pdf as unknown as { numPages?: number })?.numPages ?? 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (isPdf && e.key === "ArrowRight")
        setPage((n) => Math.min(numPages, n + 1));
      else if (isPdf && e.key === "ArrowLeft")
        setPage((n) => Math.max(1, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPdf, pdf, onClose]);

  const lastTwo = captions.slice(-2);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {error ? (
        <div style={{ color: "#fff" }}>{error}</div>
      ) : isPdf ? (
        <canvas ref={canvasRef} style={{ maxWidth: "96vw", maxHeight: "90vh" }} />
      ) : (
        blobUrl && (
          <iframe
            src={blobUrl}
            title="presentation"
            style={{ width: "100vw", height: "100vh", border: "none", background: "#fff" }}
          />
        )
      )}

      {/* 하단 자막 2줄 */}
      {lastTwo.length > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: "18px 24px",
            background: "linear-gradient(transparent, rgba(0,0,0,0.75))",
            color: "#fff",
            fontSize: 26,
            lineHeight: 1.35,
            textAlign: "center",
            textShadow: "0 1px 3px rgba(0,0,0,0.9)",
          }}
        >
          {lastTwo.map((c, i) => (
            <div key={i}>{c}</div>
          ))}
        </div>
      )}

      {/* 우하단 QR */}
      <div
        style={{
          position: "absolute",
          right: 20,
          bottom: 20,
          background: "#fff",
          padding: 8,
          borderRadius: 8,
        }}
      >
        <SessionQRCode url={joinUrl} size={96} />
      </div>

      {/* ESC 안내 */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 20,
          color: "rgba(255,255,255,0.6)",
          fontSize: 12,
        }}
      >
        ESC 나가기 · ←/→ 페이지
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 타입/린트**

Run: `npx tsc --noEmit && npx eslint "src/app/session/[id]/broadcast/PresentationViewer.tsx"`
Expected: 에러 0. (pdfjs 동적 타입은 any 캐스팅 + eslint-disable로 처리했다.)

- [ ] **Step 3: 커밋**

```bash
git add "src/app/session/[id]/broadcast/PresentationViewer.tsx"
git commit -m "feat(presentation): 전체화면 뷰어(PDF pdfjs/HTML iframe + 자막·QR 오버레이)"
```

---

## Task 5: broadcast 버튼 + 뷰어 연결

**Files:** `src/app/session/[id]/broadcast/page.tsx`

**Interfaces:** Consumes: `PresentationViewer`(Task 4), GET 세션의 `hasPresentation`·`presentationMime`(Task 2).

- [ ] **Step 1: import + 상태**

`broadcast/page.tsx` 상단 import 추가:
```ts
import PresentationViewer from "./PresentationViewer";
```
세션 정보 상태에 hasPresentation/mime 추가(제목·발표자 상태 근처):
```ts
  const [hasPresentation, setHasPresentation] = useState(false);
  const [presentationMime, setPresentationMime] = useState("");
  const [showViewer, setShowViewer] = useState(false);
```
세션 정보 fetch의 then에 반영(기존 `setSessionTitle` 옆):
```ts
        setHasPresentation(!!d.hasPresentation);
        setPresentationMime(d.presentationMime || "");
```

- [ ] **Step 2: 버튼 (헤더/제어판 적절한 위치)**

제목·발표자 표시 블록 근처에 버튼 추가:
```tsx
        {hasPresentation && (
          <button
            className="btn btn-outline"
            style={{ marginTop: 12 }}
            onClick={() => setShowViewer(true)}
          >
            발표자료 전체보기
          </button>
        )}
```

- [ ] **Step 3: 뷰어 렌더 (return 최상단)**

`return (` 직후, 컨테이너 안 맨 앞에 조건부 뷰어를 넣는다. captions는 `hostCaptions`의 텍스트 배열:
```tsx
      {showViewer && (
        <PresentationViewer
          sessionId={sessionId}
          mime={presentationMime}
          joinUrl={joinUrl}
          captions={hostCaptions.map((c) => c.text)}
          onClose={() => setShowViewer(false)}
        />
      )}
```
(주의: `hostCaptions` 항목의 텍스트 필드명이 `.text`인지 확인. 다르면 맞춘다.)

- [ ] **Step 4: 타입/린트**

Run: `npx tsc --noEmit && npx eslint "src/app/session/[id]/broadcast/page.tsx"`
Expected: tsc 0. eslint는 이 파일의 기존 에러 수와 동일(신규 0)인지 전후 비교.

- [ ] **Step 5: 커밋**

```bash
git add "src/app/session/[id]/broadcast/page.tsx"
git commit -m "feat(broadcast): 발표자료 전체보기 버튼 + 뷰어 연결"
```

---

## Task 6: E2E 런타임 검증

**Files:** (없음 — 실행/관찰)

- [ ] **Step 1: 메인 배포 + 재시작**

변경/신규 파일 전체(+ public/pdf.worker.min.mjs, node_modules는 메인에서 `npm install`)를 메인에 반영. 메인에서 `npm install`(pdfjs-dist) 후 `통역서버.command`로 재시작.

- [ ] **Step 2: PDF 전체보기**

PDF 올려 세션 생성 → broadcast에 "발표자료 전체보기" 버튼 → 클릭 → 슬라이드 전체화면 → **←/→ 페이지 이동** → 하단 자막 2줄(발화 시)·우하단 QR 확인 → **ESC로 복귀**(방송 유지).

- [ ] **Step 3: HTML 전체보기**

HTML 올려 세션 생성 → 전체보기 iframe 표시 → ESC 복귀.

- [ ] **Step 4: 회귀**

발표자료 없이 세션 생성 → "전체보기" 버튼 없음, broadcast 정상.

- [ ] **Step 5: 보안**

`curl /api/sessions/<id>`에 `presentationFile`·`geminiApiKey`·`presentationContext` 없고 `hasPresentation`만 있는지 확인.

---

## Self-Review 결과

- **스펙 커버리지**: 파일보관·서빙(T2)·홈업로드(T3)·뷰어(T4)·버튼(T5)·E2E(T6), 의존성(T1). 스펙 4.1~4.6·8 전부 태스크 존재.
- **플레이스홀더**: 없음(뷰어 전체 코드 포함).
- **타입 일관성**: `presentationFile{name,mime,bytes}`, `createSession(...presentationFile?)`, GET `hasPresentation/presentationMime`, `PresentationViewer` props가 태스크 간 일치.
- **리스크**: pdfjs 워커 로딩(public 경로로 회피) + `hostCaptions` 텍스트 필드명(T5에서 확인) — 런타임에서 검증.

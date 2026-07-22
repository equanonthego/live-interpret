"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [blobUrl, setBlobUrl] = useState<string>("");
  // pdfjs 문서 객체(동적 로드라 타입은 느슨하게).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pdf, setPdf] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>("");

  // onClose는 부모가 매 렌더(자막 갱신)마다 새로 만드므로 ref로 안정화한다.
  // 그래야 keydown 리스너가 자막 갱신마다 재등록되며 키 입력을 흘리지 않는다.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // 파일 로드
  useEffect(() => {
    let revoked = "";
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let createdDoc: any = null;
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/presentation`);
        if (!res.ok) throw new Error("load failed");
        const buf = await res.arrayBuffer();
        if (isPdf) {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) })
            .promise;
          createdDoc = doc;
          if (!cancelled) setPdf(doc);
        } else {
          const url = URL.createObjectURL(
            new Blob([buf], { type: mime || "text/html" })
          );
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
      // pdfjs 문서 워커/버퍼 해제 (반복 열기 시 누수 방지).
      // destroy가 진행 중 렌더와 겹쳐 던질 수 있으므로 방어한다.
      try {
        createdDoc?.destroy();
      } catch {
        /* 이미 해제됐거나 렌더와 경합 — 무시 */
      }
    };
  }, [sessionId, isPdf, mime]);

  // PDF 현재 페이지 렌더 (화면에 맞게 스케일)
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let task: any = null;
    (async () => {
      try {
        const p = await pdf.getPage(page);
        if (cancelled || !canvasRef.current) return;
        const unscaled = p.getViewport({ scale: 1 });
        // 뷰포트를 꽉 채우도록(가로/세로 중 맞는 쪽 기준, 비율 유지).
        const scale = Math.min(
          window.innerWidth / unscaled.width,
          window.innerHeight / unscaled.height
        );
        const viewport = p.getViewport({ scale });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d")!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        task = p.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch {
        // 페이지 전환·닫기로 렌더가 취소되거나(RenderingCancelledException),
        // 문서가 destroy된 뒤 getPage가 reject되는 경우 등 — 모두 무시.
        // (여기서 잡지 않으면 unhandled rejection으로 에러가 표출된다.)
      }
    })();
    return () => {
      cancelled = true;
      // 같은 캔버스에 중복 render()가 겹치지 않도록 이전 렌더를 취소한다.
      try {
        task?.cancel();
      } catch {
        /* 이미 끝났거나 취소된 렌더 — 무시 */
      }
    };
  }, [pdf, page]);

  // 키보드: ←/→ 페이지, ESC 닫기
  useEffect(() => {
    const numPages: number = pdf?.numPages ?? 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      else if (isPdf && e.key === "ArrowRight")
        setPage((n) => Math.min(numPages, n + 1));
      else if (isPdf && e.key === "ArrowLeft")
        setPage((n) => Math.max(1, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPdf, pdf]);

  // 최근 자막 몇 개를 한 덩어리로 합쳐 화면 하단에 표시하되,
  // 실제 노출은 CSS line-clamp로 최대 3줄까지만 자른다.
  const captionText = captions.slice(-3).join(" ").trim();

  // 포털로 document.body에 렌더해야 broadcast의 .container(max-width) +
  // .enter(transform 잔존)에 갇히지 않고 진짜 전체화면이 된다.
  if (typeof document === "undefined") return null;

  const overlay = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {error ? (
        <div style={{ color: "#fff" }}>{error}</div>
      ) : isPdf ? (
        <canvas
          ref={canvasRef}
          style={{ maxWidth: "100vw", maxHeight: "100vh" }}
        />
      ) : (
        blobUrl && (
          <iframe
            ref={iframeRef}
            src={blobUrl}
            title="presentation"
            onLoad={() => {
              // HTML 발표자료는 별도 브라우징 컨텍스트(iframe)라, 부모 window의
              // keydown 리스너에 ESC가 도달하지 않는다. blob URL은 same-origin
              // 이므로 iframe 문서에도 ESC 리스너를 직접 달아 닫힘을 보장한다.
              try {
                const doc = iframeRef.current?.contentDocument;
                doc?.addEventListener("keydown", (e: KeyboardEvent) => {
                  if (e.key === "Escape") onCloseRef.current();
                });
              } catch {
                // 혹시 cross-origin이면 접근 불가 — 보이는 닫기 버튼으로 대체된다.
              }
            }}
            style={{
              width: "100vw",
              height: "100vh",
              border: "none",
              background: "#fff",
            }}
          />
        )
      )}

      {/* 하단 자막 — 중앙 ~50% 폭, 최대 3줄 */}
      {captionText.length > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 24,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              maxWidth: "50vw",
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              fontSize: 24,
              lineHeight: 1.3,
              padding: "10px 18px",
              borderRadius: 10,
              textAlign: "center",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 3,
              overflow: "hidden",
            }}
          >
            {captionText}
          </div>
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

      {/* 닫기 버튼 — iframe(HTML)에서 ESC가 포커스 문제로 안 먹거나, 터치/모바일
          처럼 키보드가 없는 상황에서도 항상 빠져나갈 수 있게 항상 보이는 버튼. */}
      <button
        onClick={() => onCloseRef.current()}
        aria-label="닫기"
        style={{
          position: "absolute",
          top: 16,
          right: 20,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.35)",
          borderRadius: 8,
          padding: "8px 14px",
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        ✕ 닫기
      </button>

      {/* 좌상단 뒤로가기 — ESC와 동일하게 컨트롤 화면으로 복귀. 항상 노출되어
          키보드가 없거나 ESC가 안 먹는 상황에서도 확실히 빠져나갈 수 있다. */}
      <button
        onClick={() => onCloseRef.current()}
        aria-label="뒤로"
        style={{
          position: "absolute",
          top: 16,
          left: 20,
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.35)",
          borderRadius: 8,
          padding: "8px 16px",
          fontSize: 16,
          cursor: "pointer",
        }}
      >
        <svg
          width="26"
          height="14"
          viewBox="0 0 26 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M25 7H1M1 7l6-6M1 7l6 6" />
        </svg>
        뒤로
      </button>

      {/* 키보드 안내 (PDF일 때만 페이지 이동 안내 포함) */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 22,
          color: "rgba(255,255,255,0.6)",
          fontSize: 12,
        }}
      >
        {isPdf ? "ESC 나가기 · ←/→ 페이지" : "ESC 또는 뒤로 로 나가기"}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

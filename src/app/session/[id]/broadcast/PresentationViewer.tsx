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
  // pdfjs 문서 객체(동적 로드라 타입은 느슨하게).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pdf, setPdf] = useState<any>(null);
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
          const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) })
            .promise;
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
    };
  }, [sessionId, isPdf, mime]);

  // PDF 현재 페이지 렌더 (화면에 맞게 스케일)
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      const p = await pdf.getPage(page);
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
    const numPages: number = pdf?.numPages ?? 1;
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
        <canvas
          ref={canvasRef}
          style={{ maxWidth: "96vw", maxHeight: "90vh" }}
        />
      ) : (
        blobUrl && (
          <iframe
            src={blobUrl}
            title="presentation"
            style={{
              width: "100vw",
              height: "100vh",
              border: "none",
              background: "#fff",
            }}
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

      {/* 안내 */}
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

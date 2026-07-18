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

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_INTERPRET_LANGUAGES } from "@/lib/interpret-config";
import type { PresentationContext } from "@/lib/glossary-extractor";

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  // 발표자료 분석 상태: 업로드 즉시 /api/extract로 분석한다.
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<PresentationContext | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // 페이지가 뜰 때 API 키 입력창은 항상 비어 있는 상태로 시작한다.
  // (이전에는 localStorage에 저장된 키를 자동으로 채워 넣었다.)
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [keyError, setKeyError] = useState<string | null>(null);

  const onKeyChange = (v: string) => {
    setGeminiApiKey(v);
    if (keyStatus !== "idle") {
      setKeyStatus("idle");
      setKeyError(null);
    }
  };

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
        // 키 입력 전에 파일을 넣었다면 지금 분석한다.
        if (pdfFile && !analysis && !analyzing) analyzePdf(pdfFile);
      } else {
        setKeyStatus("fail");
        setKeyError(data.error || "키 검증에 실패했습니다.");
      }
    } catch {
      setKeyStatus("fail");
      setKeyError("네트워크 오류로 검증하지 못했습니다.");
    }
  };

  // 발표자료(PDF)를 업로드 즉시 분석한다. 키가 있어야 분석 가능.
  const analyzePdf = async (file: File) => {
    const key = geminiApiKey.trim();
    setAnalysis(null);
    setAnalysisError(null);
    if (!key) {
      setAnalysisError("먼저 Google API Key를 입력하세요.");
      return;
    }
    setAnalyzing(true);
    try {
      const form = new FormData();
      form.append("presentation", file);
      form.append("geminiApiKey", key);
      const res = await fetch("/api/extract", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "발표자료 분석에 실패했습니다.");
      }
      setAnalysis(data as PresentationContext);
    } catch (e) {
      setAnalysisError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  // 지원 형식: PDF, HTML. (PPT·Keynote는 PDF로 내보내 올리도록 안내)
  const isSupportedDoc = (f: File) =>
    f.type === "application/pdf" ||
    f.type === "text/html" ||
    /\.(html?|pdf)$/i.test(f.name);

  const onPdfPicked = (file: File | null) => {
    setPdfFile(file);
    setAnalysis(null);
    setAnalysisError(null);
    if (file) analyzePdf(file);
  };

  async function createSession() {
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("organizerName", "host");
      form.append(
        "allowedLanguages",
        JSON.stringify(DEFAULT_INTERPRET_LANGUAGES)
      );
      form.append("geminiApiKey", geminiApiKey.trim());
      // 이미 분석한 컨텍스트가 있으면 그대로 넘겨 재분석을 피한다.
      if (analysis) {
        form.append("presentationContext", JSON.stringify(analysis));
      }
      // 원본 파일도 함께 올려 전체보기 렌더에 쓴다.
      if (pdfFile) form.append("presentation", pdfFile);

      // FormData 사용 시 Content-Type을 직접 지정하지 않는다(브라우저가
      // multipart boundary를 포함해 자동 설정).
      const res = await fetch("/api/sessions", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create session");
      }
      router.push(`/session/${data.sessionId}/broadcast`);
    } catch (err) {
      console.error("Failed to create session:", err);
      setError((err as Error).message);
      setLoading(false);
    }
  }

  const statusDotLabel =
    keyStatus === "ok"
      ? "연결됨"
      : keyStatus === "fail"
      ? "연결 실패"
      : keyStatus === "testing"
      ? "확인 중"
      : "연결 안 됨";
  const statusDotColor =
    keyStatus === "ok" ? "var(--accent)" : keyStatus === "fail" ? "var(--error)" : "var(--fg)";

  return (
    <div className="page">
      <div className="container" style={{ textAlign: "center" }}>
        {/* Title */}
        <h1 className="display display-xl enter" style={{ marginBottom: 24 }}>
          <em>Live</em> Translate
        </h1>

        {/* Subtitle */}
        <p
          className="body enter-d1"
          style={{ maxWidth: 480, margin: "0 auto 48px" }}
        >
          당신의 목소리를 송출하세요.
          <br />
          청중은 각자 언어를 고르고, 번역은 필요할 때 실시간으로 시작됩니다.
        </p>

        {/* Inputs */}
        <div
          className="enter-d2"
          style={{
            maxWidth: 340,
            margin: "0 auto 20px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="password"
                className="input-field"
                placeholder="Google API Key"
                value={geminiApiKey}
                onChange={(e) => onKeyChange(e.target.value)}
                style={{ textAlign: "left", flex: 1, minWidth: 0 }}
                disabled={loading}
              />
              <button
                type="button"
                className="btn btn-outline"
                onClick={testGeminiKey}
                disabled={!geminiApiKey.trim() || keyStatus === "testing"}
                style={{
                  padding: "6px 14px",
                  fontSize: 13,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                {keyStatus === "testing" ? "확인 중…" : "연결 테스트"}
                <span
                  aria-label={statusDotLabel}
                  title={statusDotLabel}
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: statusDotColor,
                    flexShrink: 0,
                  }}
                />
              </button>
            </div>
            {keyStatus === "fail" && (
              <p style={{ color: "var(--error)", fontSize: 13, marginTop: 8 }}>{keyError}</p>
            )}
          </div>

          {/* 발표자료 드롭존 — 이벤트 ID 대신. 클릭/드래그&드롭으로 PDF 업로드 */}
          <div
            onClick={() => !loading && !analyzing && fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!loading && !analyzing) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (loading || analyzing) return;
              const f = e.dataTransfer.files?.[0];
              if (f && isSupportedDoc(f)) onPdfPicked(f);
            }}
            style={{
              border: `1.5px dashed ${dragOver ? "#7fb3ec" : "#c9def5"}`,
              borderRadius: 12,
              padding: "26px 16px",
              textAlign: "center",
              cursor: loading || analyzing ? "default" : "pointer",
              background: dragOver ? "#f0f7ff" : "transparent",
              transition: "border-color 0.15s, background 0.15s",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            {analyzing ? (
              <span
                className="body-sm"
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                <span className="spinner" /> 분석 중…
              </span>
            ) : pdfFile ? (
              <span className="body-sm">📄 {pdfFile.name}</span>
            ) : (
              <>
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#7fb3ec"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
                <span style={{ fontWeight: 600 }}>발표자료 (선택사항)</span>
                <span
                  className="mono"
                  style={{ color: "var(--fg-secondary)", fontSize: 12 }}
                >
                  PDF · HTML
                </span>
                <span
                  className="mono"
                  style={{ color: "var(--fg-secondary)", fontSize: 11 }}
                >
                  drag and drop / click
                </span>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,text/html,.pdf,.html,.htm"
            onChange={(e) => onPdfPicked(e.target.files?.[0] ?? null)}
            disabled={loading}
            style={{ display: "none" }}
          />

          <p
            className="body-sm"
            style={{ color: "var(--fg-secondary)", marginTop: -2 }}
          >
            통역이 더 정확해집니다
          </p>

          {analysisError && (
            <p style={{ color: "var(--error)", fontSize: 13 }}>{analysisError}</p>
          )}

          {analysis && (
            <div
              style={{
                textAlign: "left",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {analysis.title && (
                <div style={{ fontWeight: 600 }}>{analysis.title}</div>
              )}
              {analysis.presenter && (
                <div className="body-sm" style={{ color: "var(--fg-secondary)" }}>
                  발표자: {analysis.presenter}
                </div>
              )}
              {analysis.domainSummary && (
                <p
                  className="body-sm"
                  style={{ color: "var(--fg-secondary)", marginTop: 4 }}
                >
                  {analysis.domainSummary}
                </p>
              )}
              {analysis.glossary?.length > 0 && (
                <div className="body-sm" style={{ color: "var(--fg-secondary)" }}>
                  용어 {analysis.glossary.length}개 인식됨
                </div>
              )}
            </div>
          )}

        </div>

        {/* Error message */}
        {error && (
          <p className="body-sm enter-d2" style={{ color: "var(--error)", marginBottom: 20 }}>
            {error}
          </p>
        )}

        {/* CTA */}
        <div className="enter-d2">
          <button
            className="btn btn-dark"
            onClick={createSession}
            disabled={loading || keyStatus !== "ok"}
            id="create-session-btn"
          >
            {loading ? (
              <>
                <span className="spinner" /> 생성 중…
              </>
            ) : (
              "세션 만들기"
            )}
          </button>
        </div>

        {/* Steps */}
        <div
          className="enter-d3"
          style={{
            marginTop: 80,
            display: "flex",
            flexDirection: "column",
            gap: 0,
            textAlign: "left",
          }}
        >
          <hr className="rule" />
          {[
            "마이크에 말하면 음성이 실시간으로 송출됩니다",
            "QR 코드를 청중에게 공유하세요",
            "청중이 고른 언어마다 Gemini 세션이 하나씩 시작됩니다",
          ].map((text, i) => (
            <div key={i}>
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  padding: "18px 0",
                  alignItems: "baseline",
                }}
              >
                <span className="mono" style={{ flexShrink: 0 }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="body-sm" style={{ color: "var(--fg-secondary)" }}>
                  {text}
                </p>
              </div>
              <hr className="rule" />
            </div>
          ))}
        </div>

        {/* Footer */}
        <p className="mono enter-d4" style={{ marginTop: 48 }}>
          Powered by Gemini Live API + LiveKit
        </p>
      </div>
    </div>
  );
}

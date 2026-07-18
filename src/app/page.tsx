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

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_INTERPRET_LANGUAGES } from "@/lib/interpret-config";

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [eventId, setEventId] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      } else {
        setKeyStatus("fail");
        setKeyError(data.error || "키 검증에 실패했습니다.");
      }
    } catch {
      setKeyStatus("fail");
      setKeyError("네트워크 오류로 검증하지 못했습니다.");
    }
  };

  async function createSession() {
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("organizerName", "host");
      form.append("eventId", eventId);
      form.append(
        "allowedLanguages",
        JSON.stringify(DEFAULT_INTERPRET_LANGUAGES)
      );
      form.append("geminiApiKey", geminiApiKey.trim());
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

          <input
            type="text"
            className="input-field"
            placeholder="이벤트 ID (선택, 예: weekly-sync)"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            style={{ textAlign: "center" }}
            disabled={loading}
          />

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

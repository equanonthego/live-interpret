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

import { useState, useCallback, useEffect, useRef } from "react";
import { SUPPORTED_LANGUAGES, getLanguageByCode } from "@/lib/languages";
import LanguageWheel from "./LanguageWheel";

interface LanguageSelectorProps {
  sessionId: string;
  currentLanguage: string;
  onLanguageChange: (
    languageCode: string,
    translatorIdentity: string | null
  ) => void;
  disabled?: boolean;
  allowedLanguages?: string[];
  maxLanguages?: number;
  openLanguages?: string[];
  onCapUpdate?: (openLanguages: string[]) => void;
}

export default function LanguageSelector({
  sessionId,
  currentLanguage,
  onLanguageChange,
  disabled = false,
  allowedLanguages,
  maxLanguages = 8,
  openLanguages,
  onCapUpdate,
}: LanguageSelectorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wheelOpen, setWheelOpen] = useState(false);
  const activeLanguageRef = useRef(currentLanguage);

  // Keep ref in sync with current language
  useEffect(() => {
    activeLanguageRef.current = currentLanguage;
  }, [currentLanguage]);

  // Unsubscribe on unmount (attendee disconnects)
  useEffect(() => {
    return () => {
      const lang = activeLanguageRef.current;
      if (lang && lang !== "original") {
        const payload = JSON.stringify({ sessionId, targetLanguage: lang });
        const blob = new Blob([payload], { type: "application/json" });
        // sendBeacon is reliable during page unload
        const sent = navigator.sendBeacon?.("/api/translate/unsubscribe", blob);
        if (!sent) {
          fetch("/api/translate/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
          }).catch(() => { });
        }
      }
    };
  }, [sessionId]);

  const applyLanguage = useCallback(
    async (langCode: string) => {
      const previousLanguage = activeLanguageRef.current;
      setError(null);

      if (langCode === "original") {
        // Unsubscribe from the current translation
        if (previousLanguage && previousLanguage !== "original") {
          fetch("/api/translate", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, targetLanguage: previousLanguage }),
          }).catch(() => { });
        }
        onLanguageChange("original", null);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            targetLanguage: langCode,
            previousLanguage:
              previousLanguage !== "original" ? previousLanguage : undefined,
          }),
        });

        const data = await res.json();

        if (res.status === 409 && data.code === "LANGUAGE_CAP_REACHED") {
          // 정원 마감: 열린 언어 목록을 즉시 반영하고 안내(폴링을 안 기다림).
          setError("정원이 찼습니다 — 열려 있는 언어 중에서 선택하세요.");
          if (Array.isArray(data.openLanguages)) {
            onCapUpdate?.(data.openLanguages);
          }
          return;
        }

        if (!res.ok) {
          throw new Error(data.error || "Translation request failed");
        }

        onLanguageChange(langCode, data.translatorIdentity);
      } catch (err) {
        setError((err as Error).message);
        console.error("Translation request error:", err);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, onLanguageChange, onCapUpdate]
  );

  const currentLang = getLanguageByCode(currentLanguage);

  const visibleLanguages = allowedLanguages
    ? SUPPORTED_LANGUAGES.filter((lang) => allowedLanguages.includes(lang.code))
    : SUPPORTED_LANGUAGES;

  const open = openLanguages ?? [];
  const capReached = maxLanguages <= open.length;

  return (
    <div style={{ width: "100%" }}>
      <label htmlFor="language-select" className="label" style={{ display: "block", marginBottom: 10 }}>
        Language
      </label>

      <div style={{ position: "relative" }}>
        {/* 표시용 트리거: 누르면 휠이 열린다 */}
        <button
          type="button"
          className="select-field"
          onClick={() => setWheelOpen(true)}
          disabled={loading || disabled}
          style={{
            width: "100%",
            textAlign: "left",
            opacity: loading || disabled ? 0.5 : 1,
            cursor: loading || disabled ? "not-allowed" : "pointer",
          }}
        >
          {currentLanguage === "original"
            ? "원본 오디오"
            : currentLang
            ? `${currentLang.name} ${currentLang.flag}`
            : currentLanguage}
        </button>

        {/* 접근성: 키보드·스크린리더용 네이티브 select(시각적으로만 숨김) */}
        <select
          id="language-select"
          aria-label="Language"
          value={currentLanguage}
          onChange={(e) => applyLanguage(e.target.value)}
          disabled={loading || disabled}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          <option value="original">원본 오디오</option>
          {visibleLanguages.map((lang) => (
            <option
              key={lang.code}
              value={lang.code}
              disabled={capReached && !open.includes(lang.code)}
            >
              {lang.name} {lang.flag}
            </option>
          ))}
        </select>

        {loading && (
          <div style={{ position: "absolute", right: 40, top: "50%", transform: "translateY(-50%)" }}>
            <span className="spinner" />
          </div>
        )}
      </div>

      <LanguageWheel
        open={wheelOpen}
        languages={visibleLanguages}
        openLanguages={open}
        capReached={capReached}
        value={currentLanguage}
        onSelect={applyLanguage}
        onClose={() => setWheelOpen(false)}
      />

      {/* State feedback */}
      <div style={{ marginTop: 10, minHeight: 20 }}>
        {currentLanguage !== "original" && currentLang && !loading && (
          <span className="status status--active">
            <span className="status-dot pulse" />
            Translating to {currentLang.name}
          </span>
        )}

        {loading && (
          <span className="status status--waiting">
            <span className="status-dot pulse" />
            Starting translation…
          </span>
        )}

        {error && (
          <span className="status status--error">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

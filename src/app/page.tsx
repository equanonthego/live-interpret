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

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";
import { DEFAULT_INTERPRET_LANGUAGES } from "@/lib/interpret-config";

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [eventId, setEventId] = useState("");
  const [error, setError] = useState<string | null>(null);
  
  const [restrictLanguages, setRestrictLanguages] = useState(true);
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(DEFAULT_INTERPRET_LANGUAGES);
  const [langSearch, setLangSearch] = useState("");

  const filteredLanguages = SUPPORTED_LANGUAGES.filter(lang => 
    lang.name.toLowerCase().includes(langSearch.toLowerCase()) ||
    lang.code.toLowerCase().includes(langSearch.toLowerCase())
  );

  useEffect(() => {
    async function checkAuthStatus() {
      try {
        const res = await fetch("/api/auth/status");
        const data = await res.json();
        setPasswordRequired(data.passwordRequired);
      } catch (err) {
        console.error("Failed to check auth status:", err);
      }
    }
    checkAuthStatus();
  }, []);

  async function createSession() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          organizerName: "host", 
          password, 
          eventId,
          allowedLanguages: restrictLanguages ? selectedLanguages : undefined
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create session");
      }
      if (passwordRequired) {
        sessionStorage.setItem("broadcast_password", password);
      }
      router.push(`/session/${data.sessionId}/broadcast`);
    } catch (err) {
      console.error("Failed to create session:", err);
      setError((err as Error).message);
      setLoading(false);
    }
  }

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
          style={{ maxWidth: 340, margin: "0 auto 48px" }}
        >
          Broadcast your voice. Attendees choose their language.
          Translation spins up on demand.
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
          {passwordRequired && (
            <input
              type="password"
              className="input-field"
              placeholder="Enter broadcast password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ textAlign: "center" }}
              disabled={loading}
            />
          )}
          <input
            type="text"
            className="input-field"
            placeholder="Event ID (optional, e.g. weekly-sync)"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            style={{ textAlign: "center" }}
            disabled={loading}
          />

          {/* Allowlisting control */}
          <div style={{ textAlign: "left", marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", color: "var(--fg-secondary)" }}>
              <input
                type="checkbox"
                checked={restrictLanguages}
                onChange={(e) => {
                  setRestrictLanguages(e.target.checked);
                }}
                style={{ accentColor: "var(--fg)", cursor: "pointer" }}
              />
              Restrict attendee languages
            </label>

            {restrictLanguages && (
              <div className="enter" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Chip container to show selected languages at a glance */}
                {selectedLanguages.length > 0 && (
                  <div style={{ 
                    display: "flex", 
                    flexWrap: "wrap", 
                    gap: "6px", 
                    marginBottom: "4px",
                    padding: "8px",
                    border: "1px dashed var(--border)",
                    background: "var(--bg-elevated)" 
                  }}>
                    {selectedLanguages.map((code) => {
                      const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
                      if (!lang) return null;
                      return (
                        <div
                          key={code}
                          onClick={() => setSelectedLanguages((prev) => prev.filter((c) => c !== code))}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            background: "var(--bg)",
                            border: "1px solid var(--border)",
                            padding: "3px 6px",
                            fontSize: "11px",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                          title="Click to remove"
                        >
                          <span>{lang.flag}</span>
                          <span style={{ color: "var(--fg-secondary)" }}>{lang.name}</span>
                          <span style={{ marginLeft: "2px", opacity: 0.5, fontWeight: "bold" }}>×</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <input
                  type="text"
                  placeholder="Search languages..."
                  className="input-field"
                  value={langSearch}
                  onChange={(e) => setLangSearch(e.target.value)}
                  style={{ padding: "8px 12px", fontSize: "13px" }}
                />
                
                <div style={{ 
                  maxHeight: "130px", 
                  overflowY: "auto", 
                  border: "1px solid var(--border)", 
                  padding: "8px", 
                  background: "var(--bg-elevated)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6
                }}>
                  {filteredLanguages.length === 0 ? (
                    <span style={{ fontSize: "12px", color: "var(--fg-tertiary)" }}>No languages found</span>
                  ) : (
                    filteredLanguages.map(lang => {
                      const isChecked = selectedLanguages.includes(lang.code);
                      return (
                        <label key={lang.code} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px" }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              setSelectedLanguages(prev => 
                                isChecked ? prev.filter(c => c !== lang.code) : [...prev, lang.code]
                              );
                            }}
                            style={{ accentColor: "var(--fg)" }}
                          />
                          <span>{lang.flag} {lang.name}</span>
                        </label>
                      );
                    })
                  )}
                </div>
                
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--fg-tertiary)" }}>
                  <span>{selectedLanguages.length} selected</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button 
                      type="button" 
                      onClick={() => setSelectedLanguages(SUPPORTED_LANGUAGES.map(l => l.code))}
                      style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", textDecoration: "underline" }}
                    >
                      Select all
                    </button>
                    <button 
                      type="button" 
                      onClick={() => setSelectedLanguages([])}
                      style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", textDecoration: "underline" }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
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
            disabled={loading}
            id="create-session-btn"
          >
            {loading ? (
              <>
                <span className="spinner" /> Creating…
              </>
            ) : (
              "Create session"
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
            "Speak into your microphone — your audio goes live",
            "Share the QR code with your audience",
            "Each language picked spins up one Gemini session",
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

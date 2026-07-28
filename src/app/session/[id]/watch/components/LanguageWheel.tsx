"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SUPPORTED_LANGUAGES,
  resolveDeviceLanguage,
  type Language,
} from "@/lib/languages";

interface LanguageWheelProps {
  open: boolean;
  languages?: Language[];
  openLanguages: string[];
  capReached: boolean;
  value: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}

// 정원이 찼고 아직 안 열린 언어는 선택 불가(A-2). 이미 열린 언어와 원본은 항상 가능.
function isDisabled(code: string, openLanguages: string[], capReached: boolean): boolean {
  if (code === "original") return false;
  if (!capReached) return false;
  return !openLanguages.includes(code);
}

export default function LanguageWheel({
  open,
  languages = SUPPORTED_LANGUAGES,
  openLanguages,
  capReached,
  value,
  onSelect,
  onClose,
}: LanguageWheelProps) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // 닫을 때 검색을 비워 다음 오픈이 빈 상태로 시작하게 한다. effect 안에서
  // setState를 부르면 cascading render가 되므로 이벤트 핸들러에서 처리한다.
  const handleClose = () => {
    setQuery("");
    onClose();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return languages;
    return languages.filter(
      (l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)
    );
  }, [languages, query]);

  // 열릴 때: 기기 언어(또는 현재 선택) 위치로 스크롤.
  useEffect(() => {
    if (!open) return;
    const target =
      (value !== "original" && value) ||
      resolveDeviceLanguage(typeof navigator !== "undefined" ? navigator.language : "") ||
      "";
    if (!target) return;
    // 렌더 후 DOM에서 해당 항목을 찾아 가운데로.
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-code="${target}"]`);
      el?.scrollIntoView({ block: "center" });
    });
  }, [open, value]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="언어 선택"
      onClick={handleClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg, #fff)",
          width: "100%",
          maxHeight: "70vh",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          display: "flex",
          flexDirection: "column",
          padding: "16px 16px 24px",
        }}
      >
        <input
          className="input-field"
          placeholder="언어 검색 / search language"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          style={{ marginBottom: 12 }}
        />

        {/* 원본 오디오 — 번역 언어가 아니라 모드이므로 휠 위 고정 항목 */}
        <button
          type="button"
          onClick={() => {
            onSelect("original");
            handleClose();
          }}
          className="btn btn-outline"
          style={{
            justifyContent: "flex-start",
            fontWeight: value === "original" ? 700 : 400,
            marginBottom: 8,
          }}
        >
          원본 오디오 {value === "original" ? "✓" : ""}
        </button>

        <div
          ref={listRef}
          style={{
            overflowY: "auto",
            scrollSnapType: "y proximity",
            borderTop: "1px solid var(--border)",
          }}
        >
          {filtered.map((lang) => {
            const disabled = isDisabled(lang.code, openLanguages, capReached);
            const selected = value === lang.code;
            return (
              <button
                key={lang.code}
                data-code={lang.code}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onSelect(lang.code);
                  handleClose();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "12px 8px",
                  scrollSnapAlign: "center",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  textAlign: "left",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.4 : 1,
                  fontWeight: selected ? 700 : 400,
                }}
              >
                <span>{lang.flag}</span>
                <span style={{ flex: 1 }}>{lang.name}</span>
                {selected && <span>✓</span>}
                {disabled && (
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--fg-secondary)" }}
                  >
                    정원 마감
                  </span>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="body-sm" style={{ padding: "16px 8px", color: "var(--fg-secondary)" }}>
              일치하는 언어가 없습니다.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

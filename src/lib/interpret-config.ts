// 청자에게 기본 제공할 언어 코드. src/lib/languages.ts의 code와 일치해야 한다.
// 여기만 수정하면 강의자 랜딩의 기본 선택 언어가 바뀐다.
export const DEFAULT_INTERPRET_LANGUAGES = ["en", "zh-Hans", "ja", "vi"];

// 발화(소스) 언어 — 강의 시나리오 기본값.
export const SOURCE_LANGUAGE = "ko";

// Gemini Live 모델명 — 브릿지와 /api/verify-key가 반드시 동일 값을 써야
// 하므로 여기 한 곳에서만 정의한다.
export const GEMINI_LIVE_MODEL = "gemini-3.5-live-translate-preview";

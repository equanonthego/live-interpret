// 세션당 동시에 열 수 있는 청자 언어(=Gemini Live 브릿지) 최대 개수.
// 청자는 79개 전부에서 고를 수 있으나, 동시 개설은 이 수로 제한해 비용 상한을
// 유지한다. 상한에 닿으면 이후 청자는 이미 열린 언어 중에서만 고를 수 있다.
export const MAX_CONCURRENT_LANGUAGES = 8;

// 발화(소스) 언어 — 강의 시나리오 기본값.
export const SOURCE_LANGUAGE = "ko";

// Gemini Live 모델명 — 브릿지와 /api/verify-key가 반드시 동일 값을 써야
// 하므로 여기 한 곳에서만 정의한다.
export const GEMINI_LIVE_MODEL = "gemini-3.5-live-translate-preview";

// 발표자료(PDF)에서 제목·발표자·용어집을 추출하는 모델. Live 모델과 별개.
export const GEMINI_EXTRACT_MODEL = "gemini-3.5-flash";

// 통역 출력 음성을 한 목소리로 고정하는 프리빌트 음성 이름. 미설정 시 모델이
// 발화마다 남/여를 오간다. (Gemini 프리빌트: Kore, Puck, Charon, Aoede 등)
export const GEMINI_VOICE = "Kore";

// 발표자료 업로드 최대 크기(바이트). 과도한 업로드로 서버 메모리가 급증하는
// 것을 막는다.
export const MAX_PRESENTATION_BYTES = 20 * 1024 * 1024; // 20MB

// 사용량 계량을 통화로 환산할 때 쓰는 100만 토큰당 USD 단가. gemini-3.5-live-
// translate-preview는 프리뷰라 공개 단가를 확정할 수 없으므로 env로만 받는다.
// 미설정(null)이면 금액을 표시하지 않고 토큰 수만 노출한다(틀린 금액 방지).
export const GEMINI_LIVE_USD_PER_1M_TOKENS: number | null =
  process.env.GEMINI_LIVE_USD_PER_1M_TOKENS &&
  !Number.isNaN(Number(process.env.GEMINI_LIVE_USD_PER_1M_TOKENS))
    ? Number(process.env.GEMINI_LIVE_USD_PER_1M_TOKENS)
    : null;

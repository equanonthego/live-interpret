import { GEMINI_EXTRACT_MODEL } from "./interpret-config";

export interface GlossaryTerm {
  term: string; // 소스(한국어) 용어
  note: string; // 의미 + 번역 처리 지침 (언어 중립)
}

export interface PresentationContext {
  title: string; // 없으면 ""
  presenter: string; // 없으면 ""
  domainSummary: string;
  glossary: GlossaryTerm[];
}

const EXTRACT_PROMPT = `You are analyzing a lecture's slide deck / handout to help a live interpreter.
Return JSON with these fields:
- "title": the presentation title exactly as written, or "" if none is found.
- "presenter": the speaker/author/presenter name exactly as written, or "" if none.
- "domainSummary": 2-4 sentences summarizing the subject domain, WRITTEN IN KOREAN, for translation context and for showing to the Korean-speaking presenter.
- "glossary": array of the key terms whose consistent translation matters. For each: "term" (the term in its original language) and "note" (its meaning and handling guidance, WRITTEN IN KOREAN — do NOT hardcode a specific target language).
Keep "title" and "presenter" exactly as they appear (do not translate them). Only output the JSON object.`;

// Gemini Flash(REST generateContent)로 발표자료를 분석해 PresentationContext 반환.
// PDF는 inlineData로, HTML은 텍스트로 넘긴다(Gemini가 PDF·텍스트만 직접 읽음).
// 어떤 이유로든(잘못된 파일, API 오류, JSON 파싱 실패, 타임아웃) 실패하면 null.
export async function extractPresentationContext(
  fileBytes: Uint8Array,
  mime: string,
  geminiApiKey: string
): Promise<PresentationContext | null> {
  try {
    // HTML은 텍스트로 읽어 넘긴다(태그 포함, 과도한 길이는 컷). 그 외(PDF 등)는
    // inlineData로 원본 바이트를 넘긴다.
    const isHtml = mime.includes("html");
    const filePart = isHtml
      ? {
          text: `Presentation source (HTML):\n${Buffer.from(fileBytes)
            .toString("utf-8")
            .slice(0, 200000)}`,
        }
      : {
          inlineData: {
            mimeType: mime || "application/pdf",
            data: Buffer.from(fileBytes).toString("base64"),
          },
        };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EXTRACT_MODEL}:generateContent?key=${encodeURIComponent(
      geminiApiKey
    )}`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [filePart, { text: EXTRACT_PROMPT }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            presenter: { type: "STRING" },
            domainSummary: { type: "STRING" },
            glossary: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  term: { type: "STRING" },
                  note: { type: "STRING" },
                },
                required: ["term", "note"],
              },
            },
          },
          required: ["title", "presenter", "domainSummary", "glossary"],
        },
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      console.error(
        `[glossary-extractor] Flash HTTP ${res.status} (model ${GEMINI_EXTRACT_MODEL})`
      );
      return null;
    }

    const data = await res.json();
    const text: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("[glossary-extractor] Empty Flash response");
      return null;
    }

    const parsed = JSON.parse(text);
    const glossary: GlossaryTerm[] = Array.isArray(parsed.glossary)
      ? parsed.glossary
          .filter(
            (g: unknown): g is GlossaryTerm =>
              !!g &&
              typeof (g as GlossaryTerm).term === "string" &&
              typeof (g as GlossaryTerm).note === "string"
          )
          .map((g: GlossaryTerm) => ({ term: g.term, note: g.note }))
      : [];

    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      presenter: typeof parsed.presenter === "string" ? parsed.presenter : "",
      domainSummary:
        typeof parsed.domainSummary === "string" ? parsed.domainSummary : "",
      glossary,
    };
  } catch (err) {
    // 에러 메시지에 요청 URL(키 포함)이 섞일 수 있으므로 키를 마스킹해 로깅한다.
    const raw = err instanceof Error ? err.message : String(err);
    const safe = geminiApiKey ? raw.split(geminiApiKey).join("***") : raw;
    console.error("[glossary-extractor] extraction failed:", safe);
    return null;
  }
}

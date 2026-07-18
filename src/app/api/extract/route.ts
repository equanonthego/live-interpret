import { NextRequest, NextResponse } from "next/server";
import { extractPresentationContext } from "@/lib/glossary-extractor";

// POST /api/extract — 발표자료(PDF)를 분석해 제목·발표자·요약·용어집을 반환.
// 홈 화면에서 파일 업로드 시 호출한다(세션 생성 전에 결과를 보여주기 위함).
// 멀티파트 FormData: presentation(File), geminiApiKey(string).
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "multipart/form-data required" },
        { status: 400 }
      );
    }

    const form = await req.formData();
    const geminiApiKey = ((form.get("geminiApiKey") as string) || "").trim();
    if (!geminiApiKey) {
      return NextResponse.json({ error: "Missing geminiApiKey" }, { status: 400 });
    }

    const file = form.get("presentation");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "Missing presentation file" }, { status: 400 });
    }

    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || "application/pdf";

    const context = await extractPresentationContext(pdfBytes, mime, geminiApiKey);
    if (!context) {
      return NextResponse.json(
        { error: "발표자료 분석에 실패했습니다." },
        { status: 502 }
      );
    }

    return NextResponse.json(context);
  } catch (error) {
    console.error("Error extracting presentation:", error);
    return NextResponse.json({ error: "분석 중 오류가 발생했습니다." }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";

// GET /api/sessions/:id/presentation — 세션의 발표자료 원본을 반환.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const manager = TranslationSessionManager.getInstance();
  const session = manager.getSession(sessionId);
  const file = session?.presentationFile;
  if (!file) {
    return NextResponse.json({ error: "No presentation" }, { status: 404 });
  }
  const body = new Uint8Array(file.bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": file.mime || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
    },
  });
}

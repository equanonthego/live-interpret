import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";

// GET /api/floor?sessionId= — 현재 발언자·손든 청자 대기열 조회
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const manager = TranslationSessionManager.getInstance();
  const session = manager.getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(manager.getFloorState(sessionId));
}

// POST /api/floor — 강의자가 발언권을 승인(grant)/회수(revoke)
export async function POST(req: NextRequest) {
  try {
    const { sessionId, action, identity } = await req.json();

    if (!sessionId || !action || !identity) {
      return NextResponse.json(
        { error: "Missing sessionId, action or identity" },
        { status: 400 }
      );
    }
    if (action !== "grant" && action !== "revoke") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const manager = TranslationSessionManager.getInstance();
    const session = manager.getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (action === "grant") {
      manager.setSpeaker(sessionId, identity);
      manager.lowerHand(sessionId, identity);
      await manager.startQuestionBridge(sessionId, identity);
    } else {
      await manager.stopQuestionBridge(sessionId);
      manager.setSpeaker(sessionId, null);
    }

    return NextResponse.json(manager.getFloorState(sessionId));
  } catch (error) {
    console.error("Error updating floor:", error);
    return NextResponse.json(
      { error: "Failed to update floor: " + (error as Error).message },
      { status: 500 }
    );
  }
}

// PUT /api/floor — 청자가 손들기(raise)/손내리기(lower)
export async function PUT(req: NextRequest) {
  try {
    const { sessionId, action, identity, name, language } = await req.json();

    if (!sessionId || !action || !identity) {
      return NextResponse.json(
        { error: "Missing sessionId, action or identity" },
        { status: 400 }
      );
    }
    if (action !== "raise" && action !== "lower") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const manager = TranslationSessionManager.getInstance();
    const session = manager.getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (action === "raise") {
      if (!language) {
        return NextResponse.json({ error: "Missing language" }, { status: 400 });
      }
      manager.raiseHand(sessionId, { identity, name, language });
    } else {
      manager.lowerHand(sessionId, identity);
    }

    return NextResponse.json(manager.getFloorState(sessionId));
  } catch (error) {
    console.error("Error updating hand raise:", error);
    return NextResponse.json(
      { error: "Failed to update hand raise: " + (error as Error).message },
      { status: 500 }
    );
  }
}

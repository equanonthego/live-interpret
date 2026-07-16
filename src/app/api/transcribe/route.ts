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

import { NextRequest, NextResponse } from "next/server";
import TranslationSessionManager from "@/lib/translation-session-manager";

// POST /api/transcribe — Start the host-caption (source-language) bridge so the
// organizer can see a live transcription of their own speech.
export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json();

    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
    }

    const manager = TranslationSessionManager.getInstance();
    if (!manager.getSession(sessionId)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const bridge = await manager.getOrCreateHostTranscription(sessionId);

    return NextResponse.json({
      transcriberIdentity: bridge.identity,
      language: bridge.targetLanguage,
      status: bridge.status,
    });
  } catch (error) {
    console.error("Error starting host transcription:", error);
    return NextResponse.json(
      { error: "Failed to start host transcription: " + (error as Error).message },
      { status: 500 }
    );
  }
}

// DELETE /api/transcribe — Stop the host-caption bridge (e.g. on broadcast end).
export async function DELETE(req: NextRequest) {
  try {
    const { sessionId } = await req.json();

    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
    }

    const manager = TranslationSessionManager.getInstance();
    await manager.stopHostTranscription(sessionId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error stopping host transcription:", error);
    return NextResponse.json(
      { error: "Failed to stop host transcription" },
      { status: 500 }
    );
  }
}

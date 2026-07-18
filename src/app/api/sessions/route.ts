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
import { v4 as uuidv4 } from "uuid";
import TranslationSessionManager from "@/lib/translation-session-manager";
import {
  extractPresentationContext,
  type PresentationContext,
} from "@/lib/glossary-extractor";
import { MAX_PRESENTATION_BYTES } from "@/lib/interpret-config";

// POST /api/sessions — Create a new broadcast session
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    let organizerName = "organizer";
    let eventId: string | undefined;
    let allowedLanguages: string[] | undefined = undefined;
    let geminiApiKey = "";
    let pdfBytes: Uint8Array | null = null;
    let pdfMime = "";
    let pdfName = "";
    // 홈에서 이미 /api/extract로 분석해 넘겨준 컨텍스트(있으면 재분석 안 함).
    let providedContext: PresentationContext | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      organizerName = (form.get("organizerName") as string) || "organizer";
      eventId = (form.get("eventId") as string) || undefined;
      geminiApiKey = ((form.get("geminiApiKey") as string) || "").trim();
      const langsRaw = form.get("allowedLanguages");
      if (typeof langsRaw === "string" && langsRaw.length > 0) {
        try {
          const arr = JSON.parse(langsRaw);
          if (Array.isArray(arr)) {
            allowedLanguages = arr.filter((l) => typeof l === "string");
          }
        } catch {
          /* ignore malformed */
        }
      }
      const ctxRaw = form.get("presentationContext");
      if (typeof ctxRaw === "string" && ctxRaw.length > 0) {
        try {
          providedContext = JSON.parse(ctxRaw) as PresentationContext;
        } catch {
          /* ignore malformed */
        }
      }
      const file = form.get("presentation");
      // 너무 큰 파일은 무시한다(발표자료는 선택이므로 세션 생성은 계속).
      if (
        file &&
        file instanceof File &&
        file.size > 0 &&
        file.size <= MAX_PRESENTATION_BYTES
      ) {
        pdfBytes = new Uint8Array(await file.arrayBuffer());
        pdfMime = file.type || "application/pdf";
        pdfName = file.name || "presentation";
      }
    } else {
      const body = await req.json().catch(() => ({}));
      organizerName = body.organizerName || "organizer";
      eventId = body.eventId;
      if (Array.isArray(body.allowedLanguages)) {
        allowedLanguages = body.allowedLanguages.filter(
          (l: unknown) => typeof l === "string"
        );
      }
      geminiApiKey =
        typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";
    }

    if (!geminiApiKey) {
      return NextResponse.json(
        { error: "Missing geminiApiKey" },
        { status: 400 }
      );
    }

    let sessionId: string;
    if (eventId && typeof eventId === "string" && eventId.trim().length > 0) {
      // Sanitize: lowercase, replace spaces/special chars with hyphens, allow alphanumeric, -, _
      sessionId = eventId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "");

      if (sessionId.length === 0) {
        sessionId = uuidv4().slice(0, 8);
      }
    } else {
      sessionId = uuidv4().slice(0, 8); // Short, readable ID
    }

    const organizerIdentity = `organizer-${organizerName}`;

    const manager = TranslationSessionManager.getInstance();
    
    // Clean up any stale translations/livekit rooms or translator bots from previous sessions under the same ID
    if (manager.getSession(sessionId)) {
      console.log(`[SessionsAPI] Overwriting existing session ${sessionId}. Tearing down previous bridges...`);
      await manager.removeAllTranslations(sessionId);
    }

    // 이미 분석된 컨텍스트가 오면 그대로 쓰고(재분석 방지), 아니면 PDF가
    // 있을 때만 서버에서 추출한다.
    let presentationContext: PresentationContext | undefined = providedContext;
    if (!presentationContext && pdfBytes) {
      presentationContext =
        (await extractPresentationContext(pdfBytes, pdfMime, geminiApiKey)) ??
        undefined;
    }

    const presentationFile = pdfBytes
      ? { name: pdfName, mime: pdfMime, bytes: Buffer.from(pdfBytes) }
      : undefined;

    manager.createSession(
      sessionId,
      organizerIdentity,
      allowedLanguages,
      geminiApiKey,
      presentationContext,
      presentationFile
    );

    // Build the attendee join URL
    const protocol = req.headers.get("x-forwarded-proto") || "http";
    const host = req.headers.get("host") || "localhost:3000";
    const joinUrl = `${protocol}://${host}/session/${sessionId}/watch`;

    return NextResponse.json({
      sessionId,
      organizerIdentity,
      joinUrl,
      broadcastUrl: `${protocol}://${host}/session/${sessionId}/broadcast`,
      title: presentationContext?.title ?? "",
      presenter: presentationContext?.presenter ?? "",
    });
  } catch (error) {
    console.error("Error creating session:", error);
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}

// GET /api/sessions — List all active sessions
export async function GET() {
  const manager = TranslationSessionManager.getInstance();
  const sessions = manager.getAllSessions();
  return NextResponse.json({ sessions });
}

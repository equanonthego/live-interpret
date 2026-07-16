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
import WebSocket from "ws";
import { GEMINI_LIVE_MODEL } from "@/lib/interpret-config";

// POST /api/verify-key — 방송자가 붙여넣은 Gemini 키가 실제로 Live 모델에
// 접속 가능한지(유료 티어 포함) 짧은 핸드셰이크로 확인한다. 키는 body로만
// 받고, 로그·응답 어디에도 키나 WS URL을 노출하지 않는다.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : "";

  if (!geminiApiKey) {
    return NextResponse.json({ error: "Missing geminiApiKey" }, { status: 400 });
  }

  const result = await verifyGeminiKey(geminiApiKey);
  return NextResponse.json(result);
}

function verifyGeminiKey(
  apiKey: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    // 주의: 이 URL은 ?key=<키>를 포함하므로 절대 로그로 출력하지 않는다.
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    let settled = false;
    const ws = new WebSocket(wsUrl);

    const done = (r: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // ignore
      }
      resolve(r);
    };

    const timer = setTimeout(
      () => done({ ok: false, error: "시간 초과 — 키 또는 네트워크를 확인하세요." }),
      10000
    );

    ws.on("open", () => {
      const setup = {
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: {
              targetLanguageCode: "en",
              echoTargetLanguage: true,
            },
          },
        },
      };
      ws.send(JSON.stringify(setup));
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.setupComplete) {
          done({ ok: true });
        }
      } catch {
        // 비-JSON 메시지는 무시하고 계속 대기
      }
    });

    ws.on("error", () => {
      done({ ok: false, error: "키 검증에 실패했습니다. 키가 올바른지 확인하세요." });
    });

    ws.on("close", () => {
      done({ ok: false, error: "키 검증에 실패했습니다 (연결이 종료됨)." });
    });
  });
}

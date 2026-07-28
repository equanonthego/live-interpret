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
import { MAX_CONCURRENT_LANGUAGES, GEMINI_LIVE_USD_PER_1M_TOKENS } from "@/lib/interpret-config";
import { estimateUsd } from "@/lib/usage-meter";

// GET /api/translate/status — List active translations for a session
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json(
      { error: "Missing sessionId parameter" },
      { status: 400 }
    );
  }

  const manager = TranslationSessionManager.getInstance();
  // 이 엔드포인트는 발표자 페이지만 주기 폴링한다(청자는 쓰지 않음). 폴링을
  // 발표자 심장박동으로 삼아, 폴링이 끊기면(절전/닫힘/전원차단) 리퍼가 세션을
  // 자동 종료해 Gemini·LiveKit·서버 비용을 끊는다.
  manager.touchHeartbeat(sessionId);
  const translations = manager.getActiveTranslations(sessionId);
  const usage = manager.getSessionUsage(sessionId);
  const estimatedUsd = estimateUsd(usage, GEMINI_LIVE_USD_PER_1M_TOKENS);

  return NextResponse.json({
    translations,
    usage,
    maxLanguages: MAX_CONCURRENT_LANGUAGES,
    estimatedUsd,
  });
}

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
import { AccessToken } from "livekit-server-sdk";
import TranslationSessionManager from "@/lib/translation-session-manager";
import { getLanIPv4 } from "@/lib/lan-address";

// GET /api/token — Generate a LiveKit access token
export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room");
  const identity = req.nextUrl.searchParams.get("identity");
  const role = req.nextUrl.searchParams.get("role") || "attendee";

  if (!room || !identity) {
    return NextResponse.json(
      { error: "Missing room or identity parameter" },
      { status: 400 }
    );
  }

  const isOrganizer = role === "organizer";

  // Check if session exists in the manager for attendees
  if (!isOrganizer) {
    const manager = TranslationSessionManager.getInstance();
    const session = manager.getSession(room);
    console.log(`[TokenAPI] Checking session for room "${room}". Found session:`, session);
    if (!session) {
      return NextResponse.json(
        { error: "Broadcast session has not started yet or has ended" },
        { status: 404 }
      );
    }
  }

  const expectedPassword = process.env.BROADCAST_PASSWORD;
  if (isOrganizer && expectedPassword) {
    const password = req.nextUrl.searchParams.get("password");
    if (password !== expectedPassword) {
      return NextResponse.json(
        { error: "Incorrect password" },
        { status: 401 }
      );
    }
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "LiveKit credentials not configured" },
      { status: 500 }
    );
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: identity,
    ttl: "4h",
  });

  at.addGrant({
    roomJoin: true,
    room,
    // 청자도 canPublish=true로 발급한다. 실제 마이크 발행은 발언권(floor
    // grant) 신호를 받은 청자만 클라이언트 UI에서 수행하도록 게이트한다
    // (서버 강제 권한은 범위 밖 — docs/specs/2026-07-15-floor-passing-qa-design.md).
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });

  const token = await at.toJwt();
  const serverUrl = resolveClientLivekitUrl(
    process.env.LIVEKIT_URL || "ws://localhost:7880"
  );

  return NextResponse.json({ token, serverUrl });
}

// 클라이언트(발표자 브라우저 + 청자 폰)가 접속할 LiveKit URL을 결정한다.
// LiveKit을 이 Mac에서 자체호스팅하면 LIVEKIT_URL이 localhost를 가리키는데,
// 청자 폰에서 localhost는 자기 자신이라 접속이 안 된다. 그래서 호스트가
// localhost/127.0.0.1이면 서버의 실제 LAN IP로 바꿔서 돌려준다. 브릿지는
// 서버(같은 Mac)에서 도므로 LIVEKIT_URL(localhost)을 그대로 쓰고, 이 치환은
// 클라이언트에 넘기는 값에만 적용한다. LiveKit Cloud(wss://…)면 그대로 둔다.
function resolveClientLivekitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const isLocal =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!isLocal) return url;
    const lanIp = getLanIPv4();
    if (!lanIp) return url;
    parsed.hostname = lanIp;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

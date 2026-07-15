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

import type { NextConfig } from "next";
import { networkInterfaces } from "os";

// 로컬 개발 시 강의자·청자가 LAN IP로 dev 서버에 접속하면 Next가 dev 리소스에
// 대한 cross-origin 요청을 기본 차단한다. 이 머신의 외부 IPv4 주소를 등록해
// LAN 접속 시 하이드레이션이 깨지지 않게 한다. (프로덕션 빌드에는 무영향)
function localIPv4Origins(): string[] {
  const origins: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) origins.push(net.address);
    }
  }
  return origins;
}

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@livekit/rtc-node", "ws"],
  // LAN IP + cloudflared 터널 도메인(개발용 HTTPS 테스트)에서의 dev 접근 허용.
  allowedDevOrigins: [...localIPv4Origins(), "*.trycloudflare.com"],
};

export default nextConfig;

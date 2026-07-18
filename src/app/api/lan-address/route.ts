import { NextRequest, NextResponse } from "next/server";
import { getLanIPv4 } from "@/lib/lan-address";

// GET /api/lan-address — 이 서버가 붙어 있는 사설망(LAN) IP로 만든 origin을
// 돌려준다. 발표자는 마이크(getUserMedia) 보안 컨텍스트 때문에 localhost로
// 페이지를 열어야 하는데, 그러면 window.location.origin이 localhost가 되어
// QR에 localhost가 박힌다(청자 폰에서는 자기 자신을 가리켜 접속 불가).
// 이 라우트가 서버의 실제 LAN IP를 알려주면, 브로드캐스트 페이지가 그걸로
// 청자용 QR을 만든다.
//
// 포트/프로토콜은 요청의 Host 헤더에서 그대로 가져오고 호스트명만 LAN IP로
// 바꾼다. LAN IP를 못 찾으면 null을 돌려주고, 클라이언트가
// window.location.origin으로 폴백한다.
export async function GET(req: NextRequest) {
  const ip = getLanIPv4();
  if (!ip) {
    return NextResponse.json({ origin: null });
  }

  // 요청 Host에서 포트만 추출(예: "localhost:3000" → "3000").
  const host = req.headers.get("host") || "";
  const portMatch = host.match(/:(\d+)$/);
  const port = portMatch ? portMatch[1] : "";

  const origin = port ? `http://${ip}:${port}` : `http://${ip}`;
  return NextResponse.json({ origin });
}

import os from "os";

// 이 서버가 붙어 있는 사설망(LAN) IPv4를 돌려준다. 못 찾으면 null.
// en0(주로 Wi-Fi/이더넷), en1을 우선 확인하고, 없으면 나머지 인터페이스에서
// 내부(loopback)가 아닌 IPv4를 찾는다. 같은 네트워크의 다른 기기(청자 폰,
// 자체호스팅 LiveKit 클라이언트)가 이 Mac에 접속할 때 쓰는 주소다.
export function getLanIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  const preferredOrder = ["en0", "en1"];
  const names = [
    ...preferredOrder.filter((n) => ifaces[n]),
    ...Object.keys(ifaces).filter((n) => !preferredOrder.includes(n)),
  ];
  for (const name of names) {
    for (const info of ifaces[name] || []) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return null;
}

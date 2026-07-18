#!/bin/bash
# 통역서버.command — 로컬 통역 서버 토글 런처 (같은 공간/네트워크 청자 전용)
# 더블클릭하면 켜지고, 같은 파일을 다시 더블클릭하면 꺼진다.
# 외부(다른 네트워크) 접속은 지원하지 않는다 — 강의실처럼 같은 네트워크에
# 있는 청자에게 이 Mac의 LAN 주소를 공유하는 용도.

set -u

# --- 경로/상수 ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PORT=3000
SERVER_LOG="$SCRIPT_DIR/.server.log"

# --- 유틸 ---
port_pids()   { lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null; }

# 상태 판단은 3000 포트 점유 여부로 한다. pidfile 기반 판단은 재부팅/비정상
# 종료 후 PID가 무관한 프로세스에 재사용될 수 있어(예: 껐다 켠 뒤 PID가
# 시스템 프로세스로 재할당) "실행 중"으로 오판해 stop_all()이 엉뚱한
# 프로세스를 죽일 위험이 있다. 포트 점유 여부는 그런 위험이 없다.
is_running() { [ -n "$(port_pids)" ]; }

# Next dev 서버가 로그에 남기는 "- Network: http://<ip>:<port>" 줄에서
# 같은 네트워크의 다른 기기가 접속할 IP를 가져온다. 이게 없으면(포맷이
# 바뀌었거나 네트워크 인터페이스가 안 잡힌 경우) ipconfig로 직접 찾는다.
get_lan_ip() {
  local ip
  ip="$(grep -oE 'Network:[[:space:]]+http://[0-9.]+' "$SERVER_LOG" 2>/dev/null \
        | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  if [ -z "$ip" ]; then
    ip="$(ipconfig getifaddr en0 2>/dev/null)"
  fi
  if [ -z "$ip" ]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null)"
  fi
  echo "$ip"
}

print_panel_on() {
  local remote="$1"
  echo ""
  echo "  🟢  서버 ON"
  echo "  ────────────────────────────────────────────"
  echo "   청자 접속 주소 (같은 네트워크):  $remote"
  echo "   내 로컬:                          http://localhost:$PORT"
  echo "  ────────────────────────────────────────────"
  echo "   이 파일을 다시 더블클릭하면 종료됩니다."
  echo ""
}

stop_all() {
  echo ""
  echo "  통역 서버를 종료합니다…"

  # Next 서버 종료: pidfile이 아니라 포트를 점유한 실제 프로세스를 직접
  # 종료한다 (npm의 PID를 죽여도 next dev 자식까지 죽는다는 보장이 없다).
  local pids
  pids="$(port_pids)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill 2>/dev/null; fi

  # 실제로 종료될 때까지 대기 (최대 10초). kill은 비동기라 곧바로 "OFF"라고
  # 알리면, 뒤이어 바로 재시작할 때 아직 죽지 않은 프로세스 때문에
  # "포트 사용 중" 오류가 뜰 수 있다. 시간 내 안 죽으면 강제 종료.
  local i
  for i in $(seq 1 10); do
    [ -z "$(port_pids)" ] && break
    sleep 1
  done
  pids="$(port_pids)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill -9 2>/dev/null; fi

  echo ""
  echo "  ⚫  서버 OFF"
  echo ""
}

start_all() {
  # 전제조건
  if ! command -v npm >/dev/null 2>&1; then
    echo "  ✗ npm(Node.js)이 없습니다. https://nodejs.org 에서 설치하세요."
    return 1
  fi
  # 3000 포트를 다른 앱이 이미 쓰는지
  local existing; existing="$(port_pids)"
  if [ -n "$existing" ]; then
    echo "  ✗ 3000 포트를 다른 프로세스가 사용 중입니다 (PID: $existing)."
    echo "    해당 프로그램을 끄거나 확인한 뒤 다시 시도하세요."
    return 1
  fi

  echo ""
  echo "  통역 서버를 시작합니다…"

  # Next dev 서버 (상태 판단은 포트 점유 여부로 하므로 PID는 따로 기록하지
  # 않는다)
  : > "$SERVER_LOG"
  nohup npm run dev >"$SERVER_LOG" 2>&1 &
  disown 2>/dev/null || true

  # 포트 열릴 때까지 대기 (최대 60초)
  echo -n "  · 서버 부팅 대기"
  local i
  for i in $(seq 1 60); do
    [ -n "$(port_pids)" ] && break
    sleep 1; echo -n "."
  done
  echo ""
  if [ -z "$(port_pids)" ]; then
    echo "  ✗ 서버가 시간 내에 뜨지 않았습니다. 최근 로그:"
    tail -n 15 "$SERVER_LOG" | sed 's/^/      /'
    stop_all >/dev/null 2>&1
    return 1
  fi

  # Next 로그에 Network 주소가 찍힐 때까지 잠깐 대기 후 LAN IP 파싱
  local lan_ip=""
  for i in $(seq 1 5); do
    lan_ip="$(get_lan_ip)"
    [ -n "$lan_ip" ] && break
    sleep 1
  done

  open "http://localhost:$PORT"
  if [ -n "$lan_ip" ]; then
    print_panel_on "http://$lan_ip:$PORT"
  else
    echo "  ⚠ 같은 네트워크 IP를 찾지 못했습니다. Wi-Fi 연결 상태를 확인하세요."
    print_panel_on "(확인 실패 — http://localhost:$PORT 는 이 Mac에서만 열림)"
  fi
}

# --- 토글 ---
if is_running; then
  stop_all
else
  start_all || true
fi

echo "  (이 창은 닫으셔도 됩니다.)"

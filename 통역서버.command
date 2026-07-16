#!/bin/bash
# 통역서버.command — 로컬 통역 서버 + Cloudflare 터널 토글 런처
# 더블클릭하면 켜지고, 같은 파일을 다시 더블클릭하면 꺼진다.

set -u

# --- 경로/상수 ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PORT=3000
SERVER_LOG="$SCRIPT_DIR/.server.log"
TUNNEL_LOG="$SCRIPT_DIR/.tunnel.log"
TUNNEL_PID="$SCRIPT_DIR/.tunnel.pid"
TUNNEL_CMD_PATTERN="cloudflared tunnel --url http://localhost:$PORT"

# --- 유틸 ---
pid_alive()   { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_pid()    { [ -f "$1" ] && cat "$1" 2>/dev/null; }
port_pids()   { lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null; }
# cloudflared는 로컬 포트를 열지 않으므로(외부로만 연결) lsof로 잡을 수 없다.
# 우리가 띄운 터널만 찾도록 실행 명령 패턴으로 pgrep한다.
tunnel_pids() { pgrep -f "$TUNNEL_CMD_PATTERN" 2>/dev/null; }

# 상태 판단은 3000 포트 점유 여부로 한다. pidfile 기반 판단은 재부팅/비정상
# 종료 후 PID가 무관한 프로세스에 재사용될 수 있어(예: 껐다 켠 뒤 PID가
# 시스템 프로세스로 재할당) "실행 중"으로 오판해 stop_all()이 엉뚱한
# 프로세스를 죽일 위험이 있다. 포트 점유 여부는 그런 위험이 없다.
is_running() { [ -n "$(port_pids)" ]; }

print_panel_on() {
  local remote="$1"
  echo ""
  echo "  🟢  서버 ON"
  echo "  ────────────────────────────────────────────"
  echo "   원격 청자:  $remote"
  echo "   내 로컬:    http://localhost:$PORT"
  echo "  ────────────────────────────────────────────"
  echo "   이 파일을 다시 더블클릭하면 종료됩니다."
  echo ""
}

stop_all() {
  echo ""
  echo "  통역 서버를 종료합니다…"

  # 1) cloudflared 종료: pidfile + pgrep 둘 다로 찾는다. pidfile만 쓰면
  #    (겹쳐 더블클릭했거나 기록 직후 강제종료된 경우) 파일이 없거나 낡아도
  #    실제 프로세스는 계속 살아 인터넷에 로컬 서버를 계속 노출시킬 수 있다.
  local tp
  tp="$(read_pid "$TUNNEL_PID")"
  if pid_alive "$tp"; then kill "$tp" 2>/dev/null; fi
  local tunnel_leftover
  tunnel_leftover="$(tunnel_pids)"
  if [ -n "$tunnel_leftover" ]; then echo "$tunnel_leftover" | xargs kill 2>/dev/null; fi

  # 2) Next 서버 종료: pidfile이 아니라 포트를 점유한 실제 프로세스를
  #    직접 종료한다 (npm의 PID를 죽여도 next dev 자식까지 죽는다는
  #    보장이 없다).
  local pids
  pids="$(port_pids)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill 2>/dev/null; fi

  # 3) 실제로 종료될 때까지 대기 (최대 10초). kill은 비동기라 곧바로
  #    "OFF"라고 알리면, 뒤이어 바로 재시작할 때 아직 죽지 않은 프로세스
  #    때문에 "포트 사용 중" 오류가 뜰 수 있다. 시간 내 안 죽으면 강제 종료.
  local i
  for i in $(seq 1 10); do
    [ -z "$(port_pids)" ] && [ -z "$(tunnel_pids)" ] && break
    sleep 1
  done
  pids="$(port_pids)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill -9 2>/dev/null; fi
  tunnel_leftover="$(tunnel_pids)"
  if [ -n "$tunnel_leftover" ]; then echo "$tunnel_leftover" | xargs kill -9 2>/dev/null; fi

  rm -f "$TUNNEL_PID"
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
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "  ✗ cloudflared 가 없습니다. 아래 명령으로 설치 후 다시 시도하세요:"
    echo "      brew install cloudflared"
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

  # 1) Next dev 서버 (상태 판단은 포트 점유 여부로 하므로 PID는 따로
  #    기록하지 않는다)
  : > "$SERVER_LOG"
  nohup npm run dev >"$SERVER_LOG" 2>&1 &
  disown 2>/dev/null || true

  # 2) 포트 열릴 때까지 대기 (최대 60초)
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

  # 3) Cloudflare Quick Tunnel
  : > "$TUNNEL_LOG"
  nohup cloudflared tunnel --url "http://localhost:$PORT" >"$TUNNEL_LOG" 2>&1 &
  echo $! > "$TUNNEL_PID"
  disown 2>/dev/null || true

  # 4) 터널 URL 파싱 (최대 30초)
  echo -n "  · 터널 연결 대기"
  local url=""
  for i in $(seq 1 30); do
    url="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1)"
    [ -n "$url" ] && break
    sleep 1; echo -n "."
  done
  echo ""

  # 5) 브라우저 + 상태판
  if [ -n "$url" ]; then
    open "$url"
    print_panel_on "$url"
  else
    echo "  ⚠ 터널 주소를 확인하지 못했습니다. 최근 터널 로그:"
    tail -n 10 "$TUNNEL_LOG" | sed 's/^/      /'
    echo "    로컬 접속만 사용할 수 있습니다."
    open "http://localhost:$PORT"
    print_panel_on "http://localhost:$PORT"
  fi
}

# --- 토글 ---
if is_running; then
  stop_all
else
  start_all || true
fi

echo "  (이 창은 닫으셔도 됩니다.)"

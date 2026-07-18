#!/bin/bash
# 통역서버.command — 로컬 통역 서버 토글 런처 (같은 공간/네트워크 청자 전용)
# 더블클릭하면 켜지고, 같은 파일을 다시 더블클릭하면 꺼진다.
# 외부(다른 네트워크) 접속은 지원하지 않는다 — 강의실처럼 같은 네트워크에
# 있는 청자에게 이 Mac의 LAN 주소를 공유하는 용도.
#
# LiveKit(오디오 전송)을 이 Mac에서 자체호스팅하면(.env.local의 LIVEKIT_URL이
# ws://localhost…) 클라우드 왕복이 사라져 지연이 크게 줄어든다. 이 경우 런처가
# livekit-server를 함께 켜고 끈다. LIVEKIT_URL이 클라우드(wss://…)면 그 부분은
# 건너뛴다(전환은 .env.local만 바꾸면 됨).

set -u

# --- 경로/상수 ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PORT=3000
LIVEKIT_PORT=7880
SERVER_LOG="$SCRIPT_DIR/.server.log"
LIVEKIT_LOG="$SCRIPT_DIR/.livekit.log"
ENV_FILE="$SCRIPT_DIR/.env.local"

# --- 유틸 ---
port_pids()    { lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null; }
livekit_pids() { lsof -ti tcp:"$LIVEKIT_PORT" -sTCP:LISTEN 2>/dev/null; }

# .env.local에서 값 하나를 읽는다(따옴표 없이 그대로). 없으면 빈 문자열.
env_val() {
  [ -f "$ENV_FILE" ] || { echo ""; return; }
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-
}

# ipconfig로 같은 네트워크 IP를 직접 찾는다(서버 로그가 생기기 전에도 필요).
lan_ip_direct() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null
}

# LIVEKIT_URL이 로컬(자체호스팅)인지 판단.
is_local_livekit() {
  case "$(env_val LIVEKIT_URL)" in
    ws://localhost*|ws://127.0.0.1*) return 0 ;;
    *) return 1 ;;
  esac
}

# 상태 판단은 3000 포트 점유 여부로 한다. pidfile 기반 판단은 재부팅/비정상
# 종료 후 PID가 무관한 프로세스에 재사용될 수 있어 "실행 중"으로 오판해
# stop_all()이 엉뚱한 프로세스를 죽일 위험이 있다. 포트 점유는 그런 위험이 없다.
is_running() { [ -n "$(port_pids)" ]; }

# Next dev 로그의 "- Network: http://<ip>:<port>" 줄에서 청자 접속 IP를 가져온다.
# 없으면 ipconfig로 직접 찾는다.
get_lan_ip() {
  local ip
  ip="$(grep -oE 'Network:[[:space:]]+http://[0-9.]+' "$SERVER_LOG" 2>/dev/null \
        | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  [ -z "$ip" ] && ip="$(lan_ip_direct)"
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

  # Next 서버 종료: 포트를 점유한 실제 프로세스를 직접 종료한다.
  local pids
  pids="$(port_pids)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill 2>/dev/null; fi

  # 우리가 띄운 livekit-server 종료(실행 명령 패턴으로 우리 것만 골라 종료).
  pkill -f "livekit-server --bind 0.0.0.0" 2>/dev/null || true

  # 실제로 종료될 때까지 대기(최대 10초). 시간 내 안 죽으면 강제 종료.
  local i
  for i in $(seq 1 10); do
    [ -z "$(port_pids)" ] && [ -z "$(livekit_pids)" ] && break
    sleep 1
  done
  pids="$(port_pids)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill -9 2>/dev/null; fi
  pkill -9 -f "livekit-server --bind 0.0.0.0" 2>/dev/null || true

  echo ""
  echo "  ⚫  서버 OFF"
  echo ""
}

# 자체호스팅 LiveKit 서버를 띄운다(LIVEKIT_URL이 로컬일 때만 호출됨).
start_livekit() {
  if ! command -v livekit-server >/dev/null 2>&1; then
    echo "  ✗ livekit-server가 없습니다. 아래로 설치 후 다시 시도하세요:"
    echo "      brew install livekit"
    return 1
  fi

  local key secret
  key="$(env_val LIVEKIT_API_KEY)"
  secret="$(env_val LIVEKIT_API_SECRET)"
  if [ -z "$key" ] || [ -z "$secret" ]; then
    echo "  ✗ .env.local에 LIVEKIT_API_KEY/SECRET가 없습니다."
    return 1
  fi

  # node-ip는 청자 폰이 미디어를 받을 주소(이 Mac의 LAN IP). 못 찾으면
  # livekit이 자동 감지하도록 플래그를 뺀다.
  local lan; lan="$(lan_ip_direct)"
  local nodeip_arg=()
  [ -n "$lan" ] && nodeip_arg=(--node-ip "$lan")

  : > "$LIVEKIT_LOG"
  nohup livekit-server --bind 0.0.0.0 "${nodeip_arg[@]}" \
    --keys "$key: $secret" --udp-port 7882 >"$LIVEKIT_LOG" 2>&1 &
  disown 2>/dev/null || true

  echo -n "  · LiveKit 서버 대기"
  local i
  for i in $(seq 1 15); do
    [ -n "$(livekit_pids)" ] && break
    sleep 1; echo -n "."
  done
  echo ""
  if [ -z "$(livekit_pids)" ]; then
    echo "  ✗ LiveKit 서버가 시간 내에 뜨지 않았습니다. 최근 로그:"
    tail -n 10 "$LIVEKIT_LOG" | sed 's/^/      /'
    return 1
  fi
}

start_all() {
  # 전제조건
  if ! command -v npm >/dev/null 2>&1; then
    echo "  ✗ npm(Node.js)이 없습니다. https://nodejs.org 에서 설치하세요."
    return 1
  fi
  local existing; existing="$(port_pids)"
  if [ -n "$existing" ]; then
    echo "  ✗ 3000 포트를 다른 프로세스가 사용 중입니다 (PID: $existing)."
    echo "    해당 프로그램을 끄거나 확인한 뒤 다시 시도하세요."
    return 1
  fi

  echo ""
  echo "  통역 서버를 시작합니다…"

  # 1) 자체호스팅 LiveKit (LIVEKIT_URL이 로컬일 때만)
  if is_local_livekit; then
    if [ -n "$(livekit_pids)" ]; then
      echo "  · LiveKit 서버가 이미 실행 중입니다 ($LIVEKIT_PORT)."
    else
      start_livekit || { stop_all >/dev/null 2>&1; return 1; }
    fi
  fi

  # 2) Next dev 서버
  : > "$SERVER_LOG"
  nohup npm run dev >"$SERVER_LOG" 2>&1 &
  disown 2>/dev/null || true

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

  # 3) LAN IP 파싱
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

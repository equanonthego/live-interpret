#!/usr/bin/env bash
# deploy.sh — Cloud Run(서울, asia-northeast3) 배포 스크립트
#
# 이 앱은 언어마다 Gemini·LiveKit로 WebSocket을 상주 연결하고 @livekit/rtc-node
# 네이티브 모듈로 오디오를 처리하는 "오래 사는 Node 서버"다. 서버리스 엣지
# (Cloudflare Workers 등)에는 올라가지 않으므로 컨테이너 호스트(Cloud Run)를 쓴다.
#
# 서버가 실제로 읽는 env는 LiveKit 3개뿐이다(코드 확인). GEMINI_API_KEY는 서버에서
# 쓰지 않는다 — BYOK: 발표자가 세션 생성 시 자기 Gemini 키를 입력해 브릿지로 전달된다.
#
# ── 최초 1회 준비 (직접 실행: 브라우저 인증/결제는 자동화 불가) ──
#   brew install --cask google-cloud-sdk
#   gcloud auth login
#   gcloud config set project <your-project-id>
#   gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
#   그리고 아래 create-secrets 를 한 번 실행해 LiveKit 시크릿을 만든다.
#
# ── 사용 ──
#   ./deploy.sh create-secrets   # 최초 1회: .env.local 값으로 시크릿 생성
#   ./deploy.sh                  # 배포 (코드 변경 시마다)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 설정 (필요시 여기만 바꾸면 됨) ──
SERVICE="live-translate"
REGION="asia-northeast3"          # 서울. 발표자/청자가 국내면 지연 최소.
CPU="2"                           # 대형 행사(15+ 언어)면 4
MEMORY="2Gi"                      # 대형 행사면 4Gi (기본 512Mi는 OOM)
ENV_FILE="$SCRIPT_DIR/.env.local"

# .env.local 에서 값 하나 읽기 (따옴표 없이).
env_val() {
  [ -f "$ENV_FILE" ] || { echo ""; return; }
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-
}

require_gcloud() {
  command -v gcloud >/dev/null 2>&1 || {
    echo "✗ gcloud 가 없습니다. 먼저: brew install --cask google-cloud-sdk" >&2
    exit 1
  }
}

# 최초 1회: LiveKit 키/시크릿을 Secret Manager 에 만든다(이미 있으면 새 버전 추가).
create_secrets() {
  require_gcloud
  local key secret
  key="$(env_val LIVEKIT_API_KEY)"
  secret="$(env_val LIVEKIT_API_SECRET)"
  [ -n "$key" ] && [ -n "$secret" ] || {
    echo "✗ .env.local 에 LIVEKIT_API_KEY / LIVEKIT_API_SECRET 가 없습니다." >&2
    exit 1
  }
  _put() { # name value
    if gcloud secrets describe "$1" >/dev/null 2>&1; then
      printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=-
    else
      printf '%s' "$2" | gcloud secrets create "$1" --data-file=-
    fi
  }
  _put livekit-api-key    "$key"
  _put livekit-api-secret "$secret"
  echo "✓ 시크릿 준비 완료 (livekit-api-key, livekit-api-secret)"
}

deploy() {
  require_gcloud
  local url
  url="$(env_val LIVEKIT_URL)"
  [ -n "$url" ] || { echo "✗ .env.local 에 LIVEKIT_URL 이 없습니다." >&2; exit 1; }

  echo "▶ 배포: $SERVICE → $REGION (cpu=$CPU mem=$MEMORY, LIVEKIT_URL=$url)"
  gcloud run deploy "$SERVICE" \
    --source . \
    --region "$REGION" \
    --allow-unauthenticated \
    --min-instances 0 --max-instances 1 \
    --cpu "$CPU" --memory "$MEMORY" \
    --no-cpu-throttling \
    --timeout 3600 \
    --set-secrets "LIVEKIT_API_KEY=livekit-api-key:latest,LIVEKIT_API_SECRET=livekit-api-secret:latest" \
    --set-env-vars "LIVEKIT_URL=${url}"
}
# 주의 (README 스케일링 노트 참고):
#  --max-instances 1      : TranslationSessionManager 가 인메모리 싱글턴 → 2대 이상이면 봇 중복 입장
#  --no-cpu-throttling    : 빠지면 요청 사이 CPU 정지 → 오디오 프레임 밀려 지연 누적
#  --min-instances 0      : 유휴 시 0으로 축소(비용 0). 방송 중에는 status 폴링이 컨테이너를 깨워둠

case "${1:-deploy}" in
  create-secrets) create_secrets ;;
  deploy|"")      deploy ;;
  *) echo "사용법: ./deploy.sh [create-secrets|deploy]" >&2; exit 1 ;;
esac

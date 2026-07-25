# 인수인계 배포 가이드 (학교/기관용)

이 앱을 **당신 기관의 계정으로 직접 배포**하기 위한 문서다. 이렇게 하면 세 가지
비용(서버·오디오·통역)이 전부 **기관 계정으로 직접 청구**되고, 원 배포자에게는
아무 비용도 가지 않는다.

> **비용 원칙:** 각 제공자에게 각자 낸다.
> - **Google Cloud (Cloud Run)** — 기관 GCP 프로젝트로 청구 (서버 실행)
> - **LiveKit Cloud** — 기관 LiveKit 계정으로 청구 (오디오 전송)
> - **Gemini API** — 강사가 입력한 키의 소유자에게 청구 (통역)
>
> 유휴 시에는 서버가 0으로 축소되어 과금되지 않는다. 실제 비용은 대부분
> "말한 시간"에 비례하는 Gemini 사용량이다.

---

## 0. 미리 준비할 계정 3개

1. **Google Cloud 계정** — 결제(신용카드)가 연결된 프로젝트. Cloud Run 배포에 필요.
2. **LiveKit Cloud 계정** — https://cloud.livekit.io 무료 가입. 프로젝트를 만들면
   `LIVEKIT_URL` / `API Key` / `API Secret`을 받는다.
   - **리전을 서울/도쿄로** 선택하면 국내 사용자 지연이 최소가 된다.
   - 무료 티어는 월 50 참가자-시간. 대규모/장시간이면 유료 플랜 필요.
3. **Gemini API 키 (유료 티어)** — https://aistudio.google.com/apikey
   - Live 통역 모델은 **유료 티어 필수**(무료 티어는 동시 WebSocket 제한으로 실패).
   - 이 키는 배포에 넣지 않는다. **강사가 방송을 열 때 화면에서 입력**한다(BYOK).

---

## 1. 코드 받기 + 로컬 설정

```bash
git clone <이 저장소 URL>
cd live-interpret
npm install
cp .env.example .env.local
```

`.env.local`을 열어 **LiveKit 값 3개**를 채운다. (`GEMINI_API_KEY`는 서버에서 쓰지
않으므로 비워둬도 된다 — BYOK.)

```env
LIVEKIT_URL=wss://<your-project>.livekit.cloud
LIVEKIT_API_KEY=<your-key>
LIVEKIT_API_SECRET=<your-secret>

# 강사만 방송을 열게 하는 비밀번호(권장). 아래 3번에서 시크릿으로도 등록한다.
BROADCAST_PASSWORD=<정할 비밀번호>
```

---

## 2. gcloud 준비 (최초 1회)

```bash
brew install --cask google-cloud-sdk     # macOS. (Windows/Linux는 공식 설치 문서 참고)
gcloud auth login                         # 브라우저 로그인
gcloud config set project <기관-프로젝트-ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
```

### ⚠️ 권한 2개 미리 부여 (안 하면 첫 배포가 실패한다)

새 프로젝트는 기본 서비스 계정에 배포 권한이 없어 아래 두 에러가 순서대로 난다.
미리 부여해두면 한 번에 배포된다. `<PROJECT_ID>`와 `<PROJECT_NUMBER>`는 본인 값으로
바꾼다(프로젝트 번호는 `gcloud projects describe <PROJECT_ID> --format='value(projectNumber)'`).

```bash
# (a) Cloud Build 가 소스를 빌드/업로드할 수 있게
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member=serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
  --role=roles/cloudbuild.builds.builder

# (b) 런타임이 Secret Manager 의 LiveKit 시크릿을 읽을 수 있게
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member=serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

> 이미 배포하다 `PERMISSION_DENIED`를 만났다면, 위 두 명령을 실행하고 ~1분 기다린
> 뒤 다시 `./deploy.sh` 하면 된다.

---

## 3. 시크릿 등록 + 배포

`deploy.sh`가 서울 리전(`asia-northeast3`)과 오디오용 플래그를 담고 있다.

```bash
# LiveKit 시크릿 2개 생성 (.env.local 값에서 읽음). 최초 1회.
./deploy.sh create-secrets

# 방송 비밀번호도 시크릿으로 등록 (선택이지만 공용 배포는 권장)
printf '%s' "$(grep '^BROADCAST_PASSWORD=' .env.local | cut -d= -f2-)" \
  | gcloud secrets create broadcast-password --data-file=-

# 배포
./deploy.sh
```

`BROADCAST_PASSWORD`까지 쓰려면 배포 서비스에 시크릿을 연결한다(최초 1회):

```bash
gcloud run services update live-translate --region asia-northeast3 \
  --update-secrets "BROADCAST_PASSWORD=broadcast-password:latest"
```

배포가 끝나면 `Service URL: https://live-translate-....run.app`이 출력된다. 이게
어느 기기·망에서든 열리는 최종 주소다.

---

## 4. 사용법

- **강사**: 위 URL 접속 → (설정했다면) 방송 비밀번호 입력 → 본인 Gemini 키 입력 →
  **Create session** → 마이크 켜고 발표. 화면의 QR/링크를 학생에게 공유.
- **학생**: 공유받은 링크만 열고 언어 선택 → 통역 청취. **비밀번호·로그인 불필요.**

방송 비밀번호는 강사(세션 생성)만 막고, 학생 시청은 열려 있다. 이렇게 해서
아무나 기관의 LiveKit·서버 자원으로 방송을 여는 것을 방지한다.

---

## 5. 비용 관리 (권장)

- 예상치 못한 청구를 막으려면 GCP **예산 알림**을 건다(예: 월 $10 초과 시 메일).
  Console → Billing → Budgets & alerts.
- Cloud Run은 `--min-instances 0`이라 유휴 시 0원. 방송 중에만 과금된다.
- 언어를 3개 이하로만 쓰면 `deploy.sh`의 `CPU=1 MEMORY=1Gi`로 낮춰 비용을 더 줄일
  수 있다(대규모 행사면 반대로 4/4Gi로 올린다).

---

## 6. 문제 해결

세션 생성이 안 되거나 자막/PDF가 깨지는 등의 증상은 [diagnostics.md](diagnostics.md)에
정리돼 있다. 특히 배포 직후 흔한 것:

| 증상 | 원인 | 해결 |
|---|---|---|
| 배포 시 `PERMISSION_DENIED` (build) | 기본 SA에 빌드 권한 없음 | 2번 (a) |
| 배포 시 `Permission denied on secret` | 런타임 SA에 시크릿 접근 권한 없음 | 2번 (b) |
| 세션 생성 401 | 방송 비밀번호 불일치 | 강사에게 올바른 비밀번호 공유 |
| 통역이 안 뜸 | Gemini 무료 티어 키 | 유료 티어 키 사용 |

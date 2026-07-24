# Troubleshooting & API Diagnostics

If your session creation or connection gets stuck (e.g. infinite spinner or errors), follow this guide to inspect and verify that all API routes and credentials are functioning correctly.

---

## 1. Browser-based Diagnostics (Recommended)

The easiest way to see exactly what is failing is to use your browser's Developer Tools.

1. Open your web browser and navigate to your deployed Cloud Run URL.
2. Open **Developer Tools** (Press `F12` or `Cmd + Option + I` on macOS).
3. Switch to the **Network** tab and select **Fetch/XHR** to filter out static assets.
4. Click **Create session** on the home page.
5. You should see two critical API requests occur:

### Request 1: `POST /api/sessions`
- **Purpose**: Creates the session ID in the in-memory manager.
- **Status**: Should be `200 OK`.
- **Payload**: Should return a JSON body like:
  ```json
  {
    "sessionId": "c62f85dd",
    "organizerIdentity": "organizer-host",
    "joinUrl": "https://...",
    "broadcastUrl": "https://..."
  }
  ```

### Request 2: `GET /api/token?room=...&identity=...&role=organizer`
- **Purpose**: Generates the LiveKit JWT token using your secret key.
- **Status**: Should be `200 OK`.
- **Payload**: Should return a JSON body containing your JWT token:
  ```json
  {
    "token": "eyJhbGciOi..."
  }
  ```

> **Common browser failures**:
> - If either request returns a **500 Internal Server Error**, check the response body in the DevTools "Response" tab. It will often contain a helpful error message (e.g. `"LiveKit credentials not configured"`).
> - If a request is blocked or shows a **CORS error**, check if the request was intercepted or redirected (e.g. by IAP session expiration).

---

## 2. Local CLI Diagnostics

If you want to verify that the Next.js API logic works independently of Cloud Run, you can run the server locally.

1. Ensure your local `.env.local` contains all credentials:
   ```env
   GEMINI_API_KEY=your-gemini-key
   LIVEKIT_API_KEY=your-livekit-key
   LIVEKIT_API_SECRET=your-livekit-secret
   LIVEKIT_URL=wss://your-livekit.cloud
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open a new terminal and test the routes directly using `curl`:

   **Test 1: Create Session**
   ```bash
   curl -X POST http://localhost:3000/api/sessions \
     -H "Content-Type: application/json" \
     -d '{"organizerName":"host"}'
   ```
   *Expected output: A JSON object containing a 8-character `sessionId`.*

   **Test 2: Generate Token**
   *(Replace `<SESSION_ID>` with the ID returned by Test 1)*
   ```bash
   curl "http://localhost:3000/api/token?room=<SESSION_ID>&identity=organizer-host&role=organizer"
   ```
   *Expected output: A JSON object containing the `token` JWT string.*

---

## 3. Verifying Cloud Run Credentials & Settings

If the local tests pass but the Cloud Run tests fail, verify the Cloud Run configuration using `gcloud`:

### Check environment mapping
Verify that the environment variables and Secret Manager mappings are correctly assigned:
```bash
gcloud run services describe live-translate \
  --region us-central1 \
  --format="json(spec.template.spec.containers[0].env)"
```

### Verify secrets are accessible
Cloud Run uses its default Compute Engine service account to access Secret Manager. Make sure it has the **Secret Manager Secret Accessor** role (`roles/secretmanager.secretAccessor`) on each secret:
```bash
# Get your project number
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format="value(projectNumber)")

# Grant secret accessor permission to the default Cloud Run service account
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding livekit-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding livekit-api-secret \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 발표자료(PDF)와 자막 관련 알려진 함정

실제 장애를 조사하며 확인한 내용이다. 같은 증상이 보이면 여기부터 확인할 것.

### 한글 PDF 본문이 전부 깨지거나 빈 화면으로 보인다

한글·CJK 발표자료(특히 Keynote/PowerPoint에서 내보낸 PDF)는 `CIDFontType0` +
`/CIDSystemInfo /Ordering (Korea1)` 형태의 CID 폰트를 쓴다. pdf.js는 CID→글리프
매핑을 만들 때 Adobe-Korea1 CMap 파일이 필요하며, `getDocument()`에 `cMapUrl`이
없으면 폰트 로딩 자체가 실패한다. 이때 서버/브라우저 콘솔에 다음이 찍힌다.

```
Warning: loadFont - translateFont failed:
"UnknownErrorException: Ensure that the `cMapUrl` API parameter is provided."
```

렌더는 예외 없이 "성공"하지만 글자만 사라지므로, 오류 없이 백지가 보이면 이
경고부터 찾을 것. CMap·표준폰트 자산은 `public/pdf/`에 두고 `PresentationViewer`
에서 `cMapUrl` / `cMapPacked` / `standardFontDataUrl`로 넘긴다.

> **pdfjs-dist를 업그레이드하면 반드시 `npm run sync:pdfjs`를 실행할 것.**
> `public/pdf.worker.min.mjs`와 `public/pdf/`는 `node_modules/pdfjs-dist`에서
> 복사한 것이라 버전이 어긋나면 조용히 깨진다.

### 자막이 한 줄에서 멈춘 채 갱신되지 않는다

`gemini-3.5-live-translate-preview`(번역 전용 모델)는 **`turnComplete`를 전혀
보내지 않는다.** 실측 결과 `serverContent` 메시지 126건 중 `turnComplete`는 0건,
`outputTranscription` 8건, `inputTranscription` 9건이었다.

클라이언트 자막 UI는 `segmentId`가 같으면 기존 자막에 텍스트를 **이어붙이도록**
되어 있다. 따라서 `turnComplete`에만 기대어 세그먼트를 넘기면 `segmentId`가 0에
고정되고 자막 한 줄이 강의 내내 길어져, 화면에서는 자막이 멈춘 것처럼 보인다.

지금은 `src/lib/caption-segmenter.ts`가 발화 사이의 무음(기본 1200ms)을 문장
경계로 삼아 세그먼트를 마감한다. 자막이 너무 잘게 끊기거나 반대로 한 줄이 너무
길면 그 파일의 `DEFAULT_SEGMENT_IDLE_MS` 한 곳만 조정하면 된다.

**진단법**: 서버 로그에서 아래 줄이 주기적으로 찍히는지 본다. 오디오는 계속
전송되는데(`Sent audio chunk #...`) 이 줄이 전혀 없으면 세그먼트가 넘어가지 않는
것이다.

```
[TranslationBridge:ko] Final Transcription (segment 3): ...
```

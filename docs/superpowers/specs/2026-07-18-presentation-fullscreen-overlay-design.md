# 발표자료 전체보기 + 자막·QR 오버레이 (스펙 2)

- 날짜: 2026-07-18
- 상태: 설계 승인 대기
- 선행: 스펙 1(발표자료 업로드·추출). 이 스펙은 업로드한 원본 파일을 화면에 띄운다.

## 1. 목적

강의자가 발표자료(PDF/HTML)를 빔프로젝터 화면에 전체화면으로 띄우고, 그 위에 실시간 한국어 자막과 청자 접속용 QR을 오버레이한다. 청자는 QR로 폰에 접속해 각자 언어로 번역을 듣는다.

성공 기준:
- 발표자료를 올린 세션의 broadcast 화면에 **"발표자료 전체보기" 버튼**이 있다.
- 버튼을 누르면 발표자료가 화면을 가득 채운다. 키보드 **←/→로 페이지 이동**.
- 하단에 **한국어 자막 최근 2줄**, 우하단에 **QR**이 오버레이된다.
- **ESC로 방송 제어 화면으로 복귀**(방송은 계속 유지).
- 발표자료를 안 올렸으면 버튼이 없고 기존 흐름 그대로.

## 2. 걸림돌과 해결: 원본 파일 전달

스펙 1은 홈에서 `/api/extract`로 분석만 하고 세션 생성 땐 컨텍스트(JSON)만 넘겨, **원본 파일이 broadcast에 없다.** 해결:
- 세션 생성 시 원본 파일도 함께 업로드(FormData `presentation`)한다(홈 상태에 파일이 남아 있으므로 재선택 불필요).
- 서버가 세션 메모리에 파일 바이트를 보관한다.
- broadcast가 `GET /api/sessions/[id]/presentation`으로 받아 렌더한다.

## 3. 아키텍처

```
홈: 세션 만들기 → FormData(presentationContext JSON + presentation 파일)
        ▼
POST /api/sessions
  · presentationContext 저장(스펙1) + presentationFile{name,mime,bytes} 저장(신규)
        ▼
GET /api/sessions/[id]        → hasPresentation, presentationMime 추가
GET /api/sessions/[id]/presentation → 원본 바이트 스트림
        ▼
broadcast: "발표자료 전체보기" 버튼 → 전체화면 오버레이(PresentationViewer)
  · PDF: pdfjs-dist로 페이지 캔버스 렌더, ←/→ 넘김
  · HTML: 전체화면 iframe
  · 하단 자막 2줄(host caption 재사용) + 우하단 QR(joinUrl 재사용)
  · ESC → 오버레이 닫기(방송 유지)
```

## 4. 컴포넌트

### 4.1 저장 (`translation-session-manager.ts`)
- `SessionInfo`에 추가: `presentationFile?: { name: string; mime: string; bytes: Buffer }`.
- `createSession(..., presentationContext?, presentationFile?)` — 6번째 선택 파라미터.

### 4.2 세션 생성 API (`api/sessions/route.ts`)
- 이미 FormData에서 `presentation` 파일을 읽어 `pdfBytes/pdfMime` 확보(스펙1). 이제 파일이 있으면 `presentationFile`로도 저장하도록 createSession에 전달(파일명 포함).

### 4.3 세션 정보 API (`api/sessions/[sessionId]/route.ts`)
- GET 응답에 추가: `hasPresentation: boolean`, `presentationMime: string`(없으면 "").
- 바이트·용어집·키는 계속 미노출.

### 4.4 발표자료 스트림 API (신규 `api/sessions/[sessionId]/presentation/route.ts`)
- `GET` → 세션의 `presentationFile`이 있으면 `bytes`를 해당 `mime`으로 반환(`Content-Type`, `Content-Disposition: inline`). 없으면 404.

### 4.5 전체보기 뷰어 (신규 `src/app/session/[id]/broadcast/PresentationViewer.tsx`)
- props: `sessionId`, `joinUrl`, `captions: string[]`(한국어 자막 라인들), `onClose()`.
- 마운트 시 `GET /api/sessions/[id]/presentation`을 blob으로 가져와 형식(mime) 판별.
- **PDF**: `pdfjs-dist`로 문서 로드, `page`(1-base) 상태, 현재 페이지를 `<canvas>`에 렌더. `keydown`에서 `ArrowRight/ArrowLeft`로 page±1(범위 클램프), `Escape`로 `onClose()`.
- **HTML**: `<iframe>`로 blob URL 표시(페이지 개념 없음; ←/→ 무시, ESC만).
- 레이아웃: `position: fixed; inset: 0; background:#000` 위에 슬라이드 중앙, 하단 자막 바(최근 2줄), 우하단 QR(`SessionQRCode` 재사용).
- pdfjs worker: 번들된 워커를 사용(`pdfjs-dist/build/pdf.worker.min.mjs`를 `new URL(...imports.meta.url)` 또는 public 복사). AGENTS.md 지침대로 Next 자산 처리 방식을 확인해 설정.

### 4.6 버튼 연결 (`broadcast/page.tsx`)
- 세션 정보(`hasPresentation`)를 이미 fetch 중(제목·발표자). `hasPresentation`이면 **"발표자료 전체보기"** 버튼 표시.
- 버튼 클릭 → `showViewer` 상태 true → `<PresentationViewer .../>` 렌더. `captions`는 기존 `hostCaptions`에서 최근 2줄의 텍스트를 뽑아 전달.

## 5. 데이터 흐름

1. 홈에서 세션 생성: presentationContext + 원본 파일 업로드.
2. 서버: 컨텍스트·파일 세션 저장.
3. broadcast: 세션 정보로 `hasPresentation` 확인 → 버튼 노출.
4. 버튼 클릭 → 뷰어가 `/presentation`에서 파일 받아 렌더 + 자막/QR 오버레이.
5. ←/→ 페이지 이동, ESC 닫기.

## 6. 에러 처리 / 그레이스풀

- 파일 없음(GET 404): 뷰어를 열지 않음(버튼 자체가 `hasPresentation`일 때만 보임).
- PDF 로드 실패: 오버레이에 "발표자료를 불러오지 못했습니다" 표시 + ESC로 닫기.
- 메모리: 원본 파일을 세션 메모리에 보관(단일 로컬 서버 전제). 세션 종료 시 함께 정리(기존 removeAllTranslations 경로에서 세션 삭제 시 자연 해제).

## 7. 범위 밖

- 청자(watch) 화면에 슬라이드 밀어주기.
- PPT/Keynote 직접 렌더(PDF로 내보내 사용).
- 발표자료 주석/포인터 등 편집 기능.
- 자막 위치·폰트 커스터마이즈(고정 스타일로 시작).

## 8. 테스트

> 테스트 프레임워크 없음 → `tsc --noEmit` + `eslint` + 런타임(E2E).

- **타입/린트**: 변경·신규 파일 통과.
- **런타임(PDF)**: PDF 세션 → 버튼 노출 → 전체보기 → ←/→ 페이지 이동 → 하단 자막 2줄·우하단 QR 확인 → ESC 복귀.
- **런타임(HTML)**: HTML 세션 → 전체보기 iframe 표시 → ESC 복귀.
- **회귀**: 발표자료 없는 세션 → 버튼 없음, 기존 broadcast 정상.
- **보안**: `/presentation`은 파일만, 세션 정보 GET엔 여전히 키·용어집·바이트 미노출.

## 9. 결정 기록

- 전체보기는 발표자(빔프로젝터) 화면만. 청자엔 안 띄움.
- PDF는 `pdfjs-dist`로 렌더(키보드 ←/→ 넘김, 캔버스 오버레이). HTML은 iframe.
- ESC → 방송 제어 화면 복귀(방송 유지, 세션 종료 아님).
- 원본 파일은 세션 생성 시 함께 업로드해 서버 메모리에 보관.

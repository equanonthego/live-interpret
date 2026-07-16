# movie Kick 스타일 리디자인 설계

- 날짜: 2026-07-15
- 범위: live-interpret 웹앱 전체 UI 리스타일 (홈 / 강의자 방송 / 청중 시청 3페이지)
- 접근: **A안 — 디자인 토큰 + 컴포넌트 클래스 재정의** (마크업 구조는 유지, `globals.css`의 토큰/클래스 정의를 교체)

## 목표

Google 예제(Instrument Serif + DM Sans, 크림색 배경, radius 0의 미니멀 에디토리얼 톤)를
자매 서비스 **movie Kick**의 밝고 둥근 SaaS 스타일로 통일한다.

- 폰트: **Pretendard** 로 전면 통일 (세리프/DM 계열 제거)
- 워드마크: "Live Translate" 유지, 첫 단어 "Live"를 파란색 포인트로
- UI 문구: 홈·방송 페이지는 **한국어**, 청중 시청 페이지는 **영어 유지**
- 새 라이브러리 도입 없음 (Tailwind 등 X)

## 확정 결정 사항

| 항목 | 결정 |
|---|---|
| 범위 | 홈 + 방송 + 시청 3페이지 전체 |
| 홈/방송 언어 | 한국어 |
| 시청(watch) 언어 | 영어 유지 (외국인 청중 대상) |
| 앱 이름 | "Live Translate" 유지 + "Live" 파랑 포인트 |
| 폰트 | Pretendard Variable (jsDelivr CDN `@import`) |
| 구현 방식 | A안: 토큰/클래스 재정의 중심 |

## 디자인 토큰 (`:root`)

**폰트**
- `--font-display` / `--font-body`: `'Pretendard Variable', Pretendard, -apple-system, system-ui, sans-serif`
- `--font-mono`: 시스템 모노 (`'SF Mono', ui-monospace, monospace`) — 세션 ID/상태 표기용
- 디스플레이는 Pretendard 700~800, 자간 -0.02em

**컬러 (movie Kick 라이트 팔레트)**
| 토큰 | 값 |
|---|---|
| `--bg` | `#FFFFFF` |
| `--bg-elevated` | `#F5F7FA` |
| `--bg-inset` | `#EEF1F6` |
| `--fg` | `#111827` |
| `--fg-secondary` | `#6B7280` |
| `--fg-tertiary` | `#9CA3AF` |
| `--fg-ghost` | `#CBD5E1` |
| `--accent` | `#2B7FFF` |
| `--accent-soft` | `rgba(43, 127, 255, 0.08)` |
| `--accent-strong` | `#1D6FF2` (hover) |
| `--border` | `#E5E7EB` |
| `--border-light` | `#F1F3F5` |
| `--success` | `#16A34A` / soft `rgba(22,163,74,0.08)` |
| `--warning` | `#D97706` / soft |
| `--error` | `#DC2626` / soft |
| `--radius` | 카드 16px · 버튼/입력 10px |
| `--shadow-card` | `0 1px 2px rgba(16,24,40,0.04)` (hover `0 4px 16px rgba(16,24,40,0.08)`) |

## 클래스 재정의 (마크업 유지)

- `.display*` : 세리프 → Pretendard 볼드. italic 제거.
- `.italic` / `<em>` : 이탤릭 세리프 강조 → **파랑 색상 포인트**(`color: var(--accent)`, `font-style: normal`). 워드마크 "Live" 강조에 사용.
- `.btn-dark` : 검정 → **파랑 솔리드**(`--accent`), radius 10px, hover `--accent-strong`. (클래스명 유지로 diff 최소화)
- `.btn-outline` / `.btn-ghost` / `.btn-danger` : radius 10px, 새 팔레트.
- `.btn` (기본) : 파랑 아웃라인/솔리드 톤으로 정리.
- `.card` / `.input-field` / `.select-field` : radius 적용, 포커스 시 파랑 링(`box-shadow: 0 0 0 3px var(--accent-soft)`).
- `.status--active/waiting/error`, `.waveform`, `.spinner`, `.lang-row` : 새 팔레트 반영(파랑/그린/앰버). 기능 동작은 불변.
- 방송/시청 페이지 인라인 스타일 중 `border-radius: 4px`, 하드코딩 `var(--fg)` 버튼 배경 등은 새 토큰·radius로 조정.

## 페이지별 변경

### 홈 (`src/app/page.tsx`) — 한국어화
- 타이틀 `Live Translate`("Live" 파랑), 서브카피 한글화.
- 입력 placeholder: "방송 비밀번호 입력", "이벤트 ID (선택, 예: weekly-sync)".
- "Restrict attendee languages" → "청중 언어 제한", "Search languages…" → "언어 검색…", "Select all/Clear" → "전체 선택/해제", "N selected" → "N개 선택".
- CTA "Create session" → "세션 만들기" / "생성 중…".
- 하단 3단계 안내 한글화, 푸터 "Powered by Gemini Live API + LiveKit" 유지.

### 방송 (`broadcast/page.tsx`) — 한국어화
- "Broadcasting" → "방송 중", 상태 "Muted/Live (Mic/Tab)" → "음소거/송출 중(마이크/탭)".
- "Microphone" → "마이크", "Browser Tab Audio" → "브라우저 탭 오디오", Enable/Disable/Share Tab/Stop Sharing 한글화.
- "N listeners" → "청취자 N명", "Screen Awake" → "화면 켜짐 유지".
- "Share with attendees" → "청중에게 공유", "Translations · N" → "번역 · N개", 빈 상태/에러 문구 한글화.
- "End broadcast" → "방송 종료". 비밀번호 게이트/에러 화면 한글화.

### 시청 (`watch/page.tsx`, `LanguageSelector.tsx`) — 영어 유지
- 문구 변경 없음. 디자인 토큰/클래스 변경만 자동 반영.
- `<em>Listening</em>`, `<em>Ready</em>` 강조가 파랑 포인트로 표시됨(세리프 이탤릭 → 파랑).

### 레이아웃 (`layout.tsx`)
- `<html lang="en">` → `lang="ko"`.
- Pretendard는 `globals.css` `@import`로 로드(현행 폰트 로딩 방식과 동일).

## 비범위 (YAGNI)
- 다크 모드 추가 안 함(현재 없음).
- 로직/상태/LiveKit·Gemini 연동 변경 없음 — 순수 프레젠테이션.
- movie Kick의 사이드바 내비/요금 다이어그램 등 신규 화면 추가 안 함(현 앱엔 해당 IA 없음).

## 검증 기준
- `npm run build` 통과, 타입/린트 경고 0.
- 미사용 import/변수 0.
- 브라우저에서 홈/방송(비번 게이트)/시청 3화면 스크린샷으로 시각 확인.
- 시크릿 노출 0 (프레젠테이션 변경만).

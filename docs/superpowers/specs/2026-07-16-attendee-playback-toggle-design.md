# 청자 재생 토글 (하단 고정 On/Off) 설계

- 날짜: 2026-07-16
- 범위: 청자(watch) 화면의 번역 오디오 재생을 켜고 끌 수 있는 **항상 보이는 하단 고정(스티키) 토글** 추가.
- 별도 스펙: Gemini BYOK는 [2026-07-16-gemini-byok-design.md](2026-07-16-gemini-byok-design.md)에서 다룬다.

## 배경 / 문제

- 현재 [watch/page.tsx](../../../src/app/session/[id]/watch/page.tsx)는 LiveKit의 `StartAudio` 컴포넌트를 쓴다. 이 버튼은 **브라우저가 자동재생을 막고 있을 때만** 나타나고, 한 번 탭해서 오디오가 풀리면 **사라진다**.
- 그 결과 핸드폰에서 청자가 소리를 **잠시 껐다가 다시 켤** 방법이 없다. 오디오를 멈추려면 탭을 떠나거나 기기 볼륨을 만져야 한다.
- 요구: 자막이 아래로 쌓여 스크롤돼도 **항상 화면 하단에 고정되어 보이는** 재생 시작/중지 토글.

## 접근 (승인됨: Approach A — `muted` prop)

LiveKit이 그대로 쓸 수 있는 API를 제공한다:

- `RoomAudioRenderer`의 `muted?: boolean` prop — `true`면 렌더러가 재생하는 모든 오디오 트랙을 음소거하고, 서버가 해당 트랙 데이터 전송을 중단한다(모바일 데이터/배터리 절약).
- `useAudioPlayback(room)` → `{ canPlayAudio, startAudio }` — `canPlayAudio`는 현재 컨텍스트에서 자동재생이 허용되는지, `startAudio()`는 사용자 제스처로 재생을 잠금 해제.

### 동작

- `AttendeeView`에 `playbackEnabled: boolean` 상태 추가 (초기값 `false` — 청자가 명시적으로 켜기 전엔 소리 없음, 모바일 자동재생 정책과도 일치).
- `<RoomAudioRenderer muted={!playbackEnabled} />`로 바인딩.
- 기존 `<StartAudio ... />`는 **제거**한다 (토글이 자동재생 잠금 해제 역할까지 흡수).
- 하단 고정 토글 버튼 `onClick`:
  - **켜는 방향**(`playbackEnabled === false` → true): `canPlayAudio`가 false면 먼저 `await startAudio()`로 잠금 해제한 뒤 `setPlaybackEnabled(true)`.
  - **끄는 방향**(true → false): `setPlaybackEnabled(false)` (음소거).
- 라벨: OFF일 때 `🔊 소리 켜기`, ON일 때 `⏸ 소리 끄기`.

### 위치 / 스타일

- 버튼은 `position: fixed`(또는 sticky) 하단 중앙, `z-index`로 자막 위에 뜬다. 좌우 여백/최대폭은 컨테이너와 맞춘다.
- 자막 스크롤 영역(`maxHeight: 320`)과 겹치지 않도록, 페이지 하단에 버튼 높이만큼의 여백(패딩)을 확보한다.
- 기존 `isReceivingAudio` 웨이브폼 표시는 그대로 둔다(수신 여부 표시는 재생 토글과 별개).

## 범위 밖 (YAGNI)

- 볼륨 슬라이더(0~100)는 추가하지 않는다. 온/오프면 충분.
- 재생 상태의 localStorage 지속은 하지 않는다(세션마다 명시적으로 켠다).
- 구독(언어 선택) 로직은 변경하지 않는다 — 재생 계층만 제어한다.

## 검증 기준

- `npx tsc --noEmit` / `npm run build` 통과, 신규 lint 에러 0.
- 데스크톱: 페이지 진입 후 토글을 켜면 소리 재생, 끄면 즉시 음소거, 다시 켜면 재생.
- 모바일(자동재생 차단 환경): 첫 "소리 켜기" 탭에서 `startAudio()`가 호출되어 재생 잠금 해제 → 이후 껐다 켜기 반복 동작.
- 자막을 아래로 스크롤해도 토글이 화면 하단에 계속 보인다.

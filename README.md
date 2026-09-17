# HR 논문 한 편

매일 HR 논문 한 편을 **한글·영문 요약**으로 읽고, 그 논문에서 나온 영어 단어를 그대로 외우는 모바일 웹.
영어 공부와 HR 전문성을 한 번에 쌓는 것이 목적이다.

아이폰 사파리에서 열고 **공유 → 홈 화면에 추가**하면 앱처럼 쓸 수 있다.

## 현재 상태

**목업(mockup) 단계.** 정적 HTML 한 파일이고 논문 데이터는 하드코딩되어 있다.
화면 구성과 사용 흐름을 확인하기 위한 것으로, 백엔드·DB·자동 수집은 아직 없다.

## 화면

| 탭 | 내용 |
|---|---|
| **오늘** | 논문 카드 — 학회지·저자·요약·핵심 수치. `한글 ⇄ ENG` 토글. `상세 보기`로 연구방법 / 주요 결과 / HR 시사점 / 한계 펼침 |
| **단어장** | 그날 논문에서 뽑은 단어. 한글 뜻 + 영영 정의 + 논문 원문 예문. `외웠어요` 체크 |
| **서재** | 지난 논문 목록 |

### 설계 의도

상세 본문의 **점선 단어**를 누르면 단어장 탭으로 넘어가며 해당 카드가 자동으로 펼쳐진다.
단어장을 따로 만들면 안 외우게 되므로, 읽다가 막힌 단어가 곧바로 학습 대상이 되도록 묶었다.

## 실행

정적 파일이라 빌드가 없다.

```sh
cd docs && python3 -m http.server 8000
# http://localhost:8000
```

GitHub Pages는 `Settings → Pages → Source: main / docs` 로 켠다.

## 구조

```
docs/
  index.html            전체 목업 (HTML + CSS + JS 단일 파일)
  manifest.webmanifest  홈 화면 추가용
  icon-180.png          아이폰 홈 화면 아이콘
  icon-512.png
  .nojekyll             Jekyll 처리 비활성화
```

상태는 `localStorage`에 저장된다 (`hrp.lang`, `hrp.known`). 기기 밖으로 나가지 않는다.

## 샘플 데이터에 관하여

오늘의 논문으로 실린 Yang et al. (2022), *Nature Human Behaviour*,
"The effects of remote work on collaboration among information workers" 는 실재하는 논문이다.
다만 **요약문·단어 정의·예문·서재 목록은 화면 확인용으로 작성한 샘플**이며 원문 인용이 아니다.

## 다음 단계

- [ ] 논문 자동 수집 — Crossref / 저널 RSS
- [ ] 요약·번역·단어 추출 자동화 — Claude API
- [ ] 논문·요약·단어·학습기록 DB 스키마
- [ ] 단어 복습 주기 (간격 반복)
- [ ] Next.js 이전

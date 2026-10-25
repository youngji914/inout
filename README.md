# 칼로리 노트

두 사람(영지·신혁)이 함께 쓰는 다이어트용 칼로리 기록 앱입니다.
식사 사진을 찍으면 Claude가 음식과 칼로리를 추정해 기록 초안을 만들고, 하루 목표 대비 결과를 공유 달력에 색으로 보여줍니다.

- 화면: GitHub Pages (`site/`) — https://youngji914.github.io/inout/
- 서버: Supabase Edge Function `api` (`supabase/functions/api/`)
- 데이터: Supabase Postgres + Storage(비공개 `photos` 버킷)

```
브라우저(GitHub Pages) ──► Supabase Edge Function "api" ──► Postgres / Storage
                                         └──────────────► Claude API (사진 분석)
```

Claude API 키와 비밀번호는 Supabase 서버 쪽 비밀값으로만 존재하고, 브라우저에는 전달되지 않습니다.
DB는 RLS로 막혀 있어 서버 함수 외에는 직접 읽고 쓸 수 없습니다.

## 기능

| 요건 | 구현 |
|---|---|
| F-01~06 사진 기록 | 촬영/갤러리 선택 → Claude가 사진 속 음식을 **항목별로** 식별하고 각각의 칼로리를 추정 → EXIF 촬영 시각(없으면 업로드 시각)으로 날짜·시간·끼니를 채운 초안 → 항목을 고치거나 추가·삭제한 뒤 저장. 추정값에는 "AI 추정" 표시 |
| 직접 입력 | 오늘 날짜·지금 시각으로 바로 시작. 날짜·시간은 "변경"을 눌렀을 때만 펼쳐짐. 음식 이름만 쓰면 AI가 일반적인 1인분 칼로리·탄단지를 채움("라면 반 개"처럼 양을 적으면 그 양 기준). 직접 쓴 칼로리는 덮어쓰지 않음 |
| 안 먹은 끼니 | 직접 입력 창의 "이 끼니는 안 먹었어요" 체크나 하루 화면의 "안 먹음" 버튼으로 아침·점심·저녁을 거른 것을 기록. 칼로리·달력 색에는 영향 없고 피드백에 반영. 그 끼니에 식사를 기록하면 자동으로 지워짐 |
| 영양 피드백 | 하루 화면의 운동 카드 아래에 탄단지 비율과 피드백 문구 표시 (아래 기준) |
| F-07~08 신체 정보·BMR | 성별·나이·키·몸무게 입력, Mifflin-St Jeor 공식으로 기초대사량 계산 |
| F-09~10 목표 | 활동 수준을 고르면 **권장섭취량**(한국인 영양소 섭취기준의 성인 에너지 필요추정량)을 계산해 그대로 하루 목표로 설정. 필요하면 −300 / −500 등으로 조정 |
| F-11~12 일일 현황 | 섭취 / 목표 / 남음·초과, 끼니별 사진·음식명·칼로리 |
| F-13~15 달력 | 월 달력, 날짜 칸마다 두 사람의 이름과 상태 점(초록·주황·빨강) |
| F-18~22 운동 | 날짜별 운동 체크, 운동 사진 여러 장(촬영 시각 날짜로 자동 기록), 달력에서 운동한 사람의 이름을 초록 칩으로 표시 |
| F-23~25 사용자 | 각자 간편 비밀번호로 로그인. 기록 입력·수정은 본인 것만, 조회는 두 사람 모두 |
| 비기능 | 모든 칼로리 수정 가능, 분석 실패 시 직접 입력, 30초마다·앱 복귀 시 자동 새로고침(준실시간 동기화) |

### 확인 필요 사항에 대해 정한 기본값

| 질문 | 기본값 | 바꾸는 곳 |
|---|---|---|
| 1. 색상 구간 | 섭취량이 목표의 110% 이하 초록, 125% 이하 주황, 초과 빨강. 기록 없는 날은 표시 없음 | `logic.ts`의 `GREEN_MAX_RATIO`, `ORANGE_MAX_RATIO` |
| 2. BMR 입력 | 성별·나이·활동 수준도 받음 | |
| 3. 간식·야식 | "간식"을 네 번째 끼니로 직접 선택 가능. 자동 분류는 04~10시 아침, 11~15시 점심, 그 외 저녁 | `app.js`의 `guessMealType` |
| 4. 사용자 구분 | 사용자별 간편 비밀번호 로그인(30일 유지). 15분에 10번 틀리면 15분간 잠김 | |
| 5. 플랫폼 | 모바일 웹앱 | |
| 6. 음식 인식 | Claude 비전 API (`claude-opus-5-5`) | `CLAUDE_MODEL` 비밀값 |
| 7. 사진 보관 | 기록을 지울 때까지 보관. 기록 삭제 시 사진도 삭제 | |
| 8. 운동 칼로리 | 목표에 반영하지 않고 표시만 | |
| 9. 운동 입력 | 체크 + 사진만 | |

권장섭취량 공식 (성인, 키는 m):
- 남성: 662 − 9.53 × 나이 + 활동계수 × (15.91 × 몸무게 + 539.6 × 키), 활동계수 1.0 / 1.11 / 1.25 / 1.48
- 여성: 354 − 6.91 × 나이 + 활동계수 × (9.36 × 몸무게 + 726 × 키), 활동계수 1.0 / 1.12 / 1.27 / 1.45

영양 피드백 기준 (`logic.ts`의 `dayFeedback`):
- 탄수화물 65% 초과 → 많음, 45% 미만 → 적음 / 단백질 15% 미만 → 부족 / 지방 30% 초과 → 많음 (한국인 영양소 섭취기준 에너지 적정비율 기반, 단백질 하한만 다이어트용으로 15%)
- 목표의 110% 초과 → 초과 안내, 지난 날짜에 목표의 70% 미만 → 너무 적게 먹음 안내
- 탄단지는 AI가 추정한 음식만 계산에 들어갑니다. 칼로리를 직접 고치면 탄단지도 같은 비율로 조정됩니다.

목표 칼로리는 바꾼 날짜부터 적용됩니다. 지난 날짜의 달력 색은 그때의 목표로 계산합니다.

## 설정 방법

처음 한 번만 하면 됩니다. 이후에는 push하면 자동 배포됩니다.

### 1. Supabase 프로젝트 만들기

1. https://supabase.com 가입 → **New project**
2. 이름은 자유, **Database Password**는 꼭 따로 적어 두세요 (아래 `SUPABASE_DB_PASSWORD`).
   Region은 **Northeast Asia (Seoul)** 추천.
3. 프로젝트가 만들어지면 주소창의 `https://supabase.com/dashboard/project/<여기>` 부분이
   **Project ref**입니다 (Project Settings → General → Project ID에도 있음).

### 2. Supabase Access Token 만들기

https://supabase.com/dashboard/account/tokens → **Generate new token** → 복사해 둡니다.
GitHub Actions가 DB 구조와 서버 함수를 배포할 때 씁니다.

### 3. GitHub에 배포용 값 넣기

저장소 **Settings → Secrets and variables → Actions**

| 탭 | 이름 | 값 |
|---|---|---|
| Secrets | `SUPABASE_ACCESS_TOKEN` | 2단계의 토큰 |
| Secrets | `SUPABASE_DB_PASSWORD` | 1단계의 DB 비밀번호 |
| Variables | `SUPABASE_PROJECT_REF` | 1단계의 Project ref |

### 4. Supabase에 앱 비밀값(환경변수) 넣기

Supabase 대시보드 → **Edge Functions → Secrets** 에서 추가합니다.

| 이름 | 값 | 필수 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API 키 (`sk-ant-...`, https://platform.claude.com/settings/keys 에서 발급) | ✅ |
| `USER1_PASSWORD` | 영지의 비밀번호 | ✅ |
| `USER2_PASSWORD` | 신혁의 비밀번호 | ✅ |
| `SESSION_SECRET` | 로그인 토큰 서명용 긴 무작위 문자열 (예: `openssl rand -hex 32` 결과). 바꾸면 모두 로그아웃됩니다 | ✅ |
| `USER1_NAME` / `USER2_NAME` | 화면에 보일 이름 (기본값 영지 / 신혁) | |
| `CLAUDE_MODEL` | 분석에 쓸 모델 (기본값 `claude-opus-5-5`) | |
| `APP_TIMEZONE` | "오늘" 기준 시간대 (기본값 `Asia/Seoul`) | |

`SUPABASE_URL`과 Supabase secret key는 Supabase가 자동으로 넣어 주므로 따로 넣지 않습니다.
비밀값은 바꾸면 재배포 없이 바로 적용됩니다.

CLI를 쓴다면 같은 내용을 이렇게 넣을 수도 있습니다.

```bash
supabase secrets set --project-ref <Project ref> \
  ANTHROPIC_API_KEY=sk-ant-... USER1_PASSWORD=... USER2_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32)
```

### 5. 배포 실행

저장소 **Actions** 탭에서

1. **Supabase** → **Run workflow** — 테이블·사진 버킷을 만들고 서버 함수를 배포합니다.
2. **Deploy to GitHub Pages** → **Run workflow** — 서버 주소를 넣어 화면을 다시 배포합니다.

끝나면 https://youngji914.github.io/inout/ 에서 로그인합니다.
처음 로그인하면 "내 정보"에서 신체 정보와 목표를 먼저 입력하세요.

## 개발

서버 함수 테스트 (Deno 2 필요, Supabase 없이 메모리 저장소로 실행):

```bash
cd supabase/functions/api
deno task check   # 타입·린트·포맷
deno task test
```

### API

모든 요청은 `https://<Project ref>.supabase.co/functions/v1/api` 아래이고,
로그인 이후 요청은 `x-app-token` 헤더에 로그인 토큰을 보냅니다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/users` | 사용자 이름 (로그인 불필요) |
| POST | `/login` | `{user_key, password}` → 토큰 |
| GET | `/me` | 내 정보·두 사람 프로필 |
| PUT | `/profile` | 신체 정보·목표 저장 (BMR·목표 계산) |
| POST | `/analyze` | 사진(`photo`) → 음식별 칼로리·탄단지 추정 |
| POST | `/estimate` | `{names: [...]}` → 음식 이름별 일반적인 칼로리·탄단지 |
| GET | `/day?date=YYYY-MM-DD` | 그날 두 사람의 식사·운동·합계·상태·탄단지·피드백 |
| GET | `/calendar?month=YYYY-MM` | 달력용 날짜별 상태·운동 여부 |
| POST | `/meals` | 식사 저장 (multipart: `items`=[{name, calories_kcal}] JSON, 사진 선택) |
| PATCH / DELETE | `/meals/:id` | 식사 수정·삭제 (본인 것만) |
| PUT / DELETE | `/workouts/:date` | 운동 체크 켜기·끄기 |
| PUT / DELETE | `/skips/:date/:meal_type` | 끼니 안 먹음 표시·취소 (breakfast·lunch·dinner) |
| POST | `/workout-photos` | 운동 사진 추가 (해당 날짜 운동 자동 체크) |
| DELETE | `/workout-photos/:id` | 운동 사진 삭제 |

### 구조

```
site/                       GitHub Pages 화면 (빌드 없음)
  index.html, style.css, app.js
  config.js                 서버 주소 (배포 시 SUPABASE_PROJECT_REF로 생성)
supabase/
  config.toml
  migrations/               DB 스키마 (profiles, target_history, meals, workouts, workout_photos, login_failures)
  functions/api/
    index.ts                진입점
    handler.ts              라우팅·인증·검증
    logic.ts                BMR·목표·달력 색·토큰
    analyze.ts              Claude 사진 분석
    store.ts                Supabase DB·Storage 접근
    memory_store.ts         테스트용 메모리 저장소
    handler_test.ts
.github/workflows/
  supabase.yml              테스트 → DB 마이그레이션·함수 배포
  pages.yml                 화면 배포
```

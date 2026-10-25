# 음식 사진 분류 서비스

사진을 업로드하면 Claude 비전 모델이 음식의 종류를 판별해 주는 웹 서비스입니다.

판별 결과:

- 음식 이름 (한국어 / 영어)
- 요리 국적 (한식, 중식, 일식, 양식 등)과 음식 분류 (밥류, 면류, 국/찌개 등)
- 확신도, 다른 후보 음식(최대 3개)
- 주요 재료, 1인분 기준 추정 칼로리, 판단 근거
- 음식이 아닌 사진이면 `is_food: false`

## 실행

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
uvicorn app.main:app --reload
```

브라우저에서 http://localhost:8000 을 열고 사진을 올리면 됩니다.

사용 모델은 기본값 `claude-opus-5-5`이며, `FOOD_CLASSIFIER_MODEL` 환경변수로 바꿀 수 있습니다.

## GitHub Pages 버전

https://youngji914.github.io/inout/

GitHub Pages는 서버를 실행할 수 없어서 `site/index.html`은 별도의 정적 버전입니다.
방문자가 자기 Claude API 키를 입력하면 브라우저에서 Anthropic API를 직접 호출합니다.
키는 이 사이트로 전송되지 않고, "기억하기"를 켠 경우에만 그 브라우저의 localStorage에 저장됩니다.

`site/`가 바뀌어 기본 브랜치에 push되면 `.github/workflows/pages.yml`이 자동으로 배포합니다
(저장소 Settings → Pages → Source가 **GitHub Actions**여야 합니다).

## API

`POST /api/classify` — `multipart/form-data`의 `image` 필드로 JPEG/PNG/GIF/WEBP 이미지(5MB 이하)를 보냅니다.

```bash
curl -F "image=@bibimbap.jpg" http://localhost:8000/api/classify
```

```json
{
  "is_food": true,
  "name_ko": "비빔밥",
  "name_en": "Bibimbap",
  "cuisine": "한식",
  "category": "밥류",
  "confidence": 0.93,
  "ingredients": ["밥", "고추장", "계란", "나물"],
  "estimated_calories_kcal": 600,
  "description": "그릇에 담긴 밥 위에 여러 나물과 계란 프라이가 얹혀 있습니다.",
  "alternatives": [{"name": "돌솥비빔밥", "confidence": 0.4}]
}
```

| 상태 코드 | 의미 |
|---|---|
| 400 | 빈 파일, 또는 처리할 수 없는 이미지 |
| 413 | 5MB 초과 |
| 415 | 지원하지 않는 형식 |
| 422 | 모델이 결과를 돌려주지 못함 (거절 등) |
| 429 | API 요청 한도 초과 |
| 502 / 503 | Claude API 오류 / 연결 실패 |

## 구조

```
app/
  classifier.py   # Claude API 호출 (구조화된 JSON 출력)
  main.py         # FastAPI 서버
  static/index.html  # 업로드 화면
tests/test_app.py  # 가짜 클라이언트로 돌리는 테스트
```

## 테스트

```bash
pytest
```

테스트는 Claude API를 실제로 호출하지 않습니다.

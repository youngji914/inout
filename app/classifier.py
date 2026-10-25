"""Claude 비전 모델로 음식 사진을 분석해 음식 종류를 판별한다."""

from __future__ import annotations

import base64
import os

import anthropic
from pydantic import BaseModel, Field

MODEL = os.environ.get("FOOD_CLASSIFIER_MODEL", "claude-opus-5-5")

SUPPORTED_MEDIA_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Claude API 이미지 1장 제한(5MB)

SYSTEM_PROMPT = """당신은 음식 사진을 분류하는 전문가입니다.
사진 속 대표 음식을 하나 골라 이름, 요리 국적, 음식 분류, 주요 재료, 1인분 기준 추정 칼로리를 판단하세요.
- 음식 이름은 한국에서 통용되는 이름(한국어)과 영어 이름을 함께 제시합니다.
- 확신(confidence)은 0~1 사이 값으로, 사진만으로 판단하기 애매하면 낮게 잡으세요.
- 헷갈릴 만한 다른 후보가 있으면 alternatives에 최대 3개까지 넣습니다.
- 사진에 음식이 없으면 is_food를 false로 하고, 이름 필드는 빈 문자열, 목록은 빈 배열, 칼로리는 null로 둡니다.
- description에는 판단 근거를 한두 문장으로 한국어로 적습니다."""


class Alternative(BaseModel):
    name: str
    confidence: float


class FoodClassification(BaseModel):
    is_food: bool
    name_ko: str
    name_en: str
    cuisine: str = Field(description="한식, 중식, 일식, 양식, 동남아식, 기타 등")
    category: str = Field(description="밥류, 면류, 국/찌개, 육류, 해산물, 디저트, 음료 등")
    confidence: float
    ingredients: list[str]
    estimated_calories_kcal: int | None
    description: str
    alternatives: list[Alternative]


_ALTERNATIVE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["name", "confidence"],
    "additionalProperties": False,
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "is_food": {"type": "boolean"},
        "name_ko": {"type": "string"},
        "name_en": {"type": "string"},
        "cuisine": {"type": "string"},
        "category": {"type": "string"},
        "confidence": {"type": "number"},
        "ingredients": {"type": "array", "items": {"type": "string"}},
        "estimated_calories_kcal": {"type": ["integer", "null"]},
        "description": {"type": "string"},
        "alternatives": {"type": "array", "items": _ALTERNATIVE_SCHEMA},
    },
    "required": list(FoodClassification.model_fields),
    "additionalProperties": False,
}


class ClassificationError(Exception):
    """모델이 결과를 돌려주지 못했을 때 발생한다."""


class FoodClassifier:
    def __init__(self, client: anthropic.Anthropic | None = None, model: str = MODEL):
        self._client = client or anthropic.Anthropic()
        self._model = model

    def classify(self, image: bytes, media_type: str) -> FoodClassification:
        if media_type not in SUPPORTED_MEDIA_TYPES:
            raise ValueError(f"지원하지 않는 이미지 형식입니다: {media_type}")
        if len(image) > MAX_IMAGE_BYTES:
            raise ValueError("이미지는 5MB 이하만 업로드할 수 있습니다.")

        response = self._client.beta.messages.create(
            model=self._model,
            max_tokens=4096,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            thinking={"type": "adaptive"},
            output_config={
                "effort": "low",
                "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA},
            },
            system=SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": base64.standard_b64encode(image).decode("ascii"),
                            },
                        },
                        {"type": "text", "text": "이 사진의 음식을 분류해 주세요."},
                    ],
                }
            ],
        )

        if response.stop_reason == "refusal":
            raise ClassificationError("모델이 이 이미지의 분석을 거절했습니다.")
        if response.stop_reason == "max_tokens":
            raise ClassificationError("응답이 너무 길어 중간에 끊겼습니다.")

        text = "".join(block.text for block in response.content if block.type == "text")
        if not text:
            raise ClassificationError("모델 응답이 비어 있습니다.")
        return FoodClassification.model_validate_json(text)

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.classifier import OUTPUT_SCHEMA, FoodClassification, FoodClassifier
from app.main import app, get_classifier

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

BIBIMBAP = {
    "is_food": True,
    "name_ko": "비빔밥",
    "name_en": "Bibimbap",
    "cuisine": "한식",
    "category": "밥류",
    "confidence": 0.93,
    "ingredients": ["밥", "고추장", "계란", "나물"],
    "estimated_calories_kcal": 600,
    "description": "그릇에 담긴 밥 위에 나물과 계란이 얹혀 있습니다.",
    "alternatives": [{"name": "돌솥비빔밥", "confidence": 0.4}],
}


class FakeMessages:
    def __init__(self, text, stop_reason="end_turn"):
        self.text, self.stop_reason, self.calls = text, stop_reason, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="text", text=self.text)],
        )


def make_classifier(text=json.dumps(BIBIMBAP), stop_reason="end_turn"):
    messages = FakeMessages(text, stop_reason)
    client = SimpleNamespace(beta=SimpleNamespace(messages=messages))
    return FoodClassifier(client=client), messages


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_schema_requires_every_field():
    assert set(OUTPUT_SCHEMA["required"]) == set(FoodClassification.model_fields)


def test_classify_sends_image_and_parses_result():
    classifier, messages = make_classifier()
    result = classifier.classify(PNG, "image/png")

    assert result.name_ko == "비빔밥"
    image_block = messages.calls[0]["messages"][0]["content"][0]
    assert image_block["source"]["media_type"] == "image/png"
    assert messages.calls[0]["output_config"]["format"]["schema"] is OUTPUT_SCHEMA


def test_api_classify(client):
    classifier, _ = make_classifier()
    app.dependency_overrides[get_classifier] = lambda: classifier

    res = client.post("/api/classify", files={"image": ("a.png", PNG, "image/png")})

    assert res.status_code == 200
    assert res.json()["name_en"] == "Bibimbap"


def test_api_rejects_non_image(client):
    classifier, messages = make_classifier()
    app.dependency_overrides[get_classifier] = lambda: classifier

    res = client.post("/api/classify", files={"image": ("a.txt", b"hello", "text/plain")})

    assert res.status_code == 415
    assert messages.calls == []


def test_api_rejects_large_image(client):
    classifier, _ = make_classifier()
    app.dependency_overrides[get_classifier] = lambda: classifier

    big = PNG + b"\x00" * (5 * 1024 * 1024)
    res = client.post("/api/classify", files={"image": ("a.png", big, "image/png")})

    assert res.status_code == 413


def test_api_refusal(client):
    classifier, _ = make_classifier(text="", stop_reason="refusal")
    app.dependency_overrides[get_classifier] = lambda: classifier

    res = client.post("/api/classify", files={"image": ("a.png", PNG, "image/png")})

    assert res.status_code == 422


def test_index_page(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "음식 사진 분류" in res.text

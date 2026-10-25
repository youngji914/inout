"""음식 사진 분류 웹 서비스."""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

import anthropic
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from .classifier import (
    MAX_IMAGE_BYTES,
    SUPPORTED_MEDIA_TYPES,
    ClassificationError,
    FoodClassification,
    FoodClassifier,
)

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="음식 사진 분류 서비스")


@lru_cache
def get_classifier() -> FoodClassifier:
    return FoodClassifier()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/classify", response_model=FoodClassification)
async def classify(
    image: UploadFile = File(...),
    classifier: FoodClassifier = Depends(get_classifier),
) -> FoodClassification:
    if image.content_type not in SUPPORTED_MEDIA_TYPES:
        raise HTTPException(415, "JPEG, PNG, GIF, WEBP 이미지만 지원합니다.")

    data = await image.read(MAX_IMAGE_BYTES + 1)
    if not data:
        raise HTTPException(400, "빈 파일입니다.")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "이미지는 5MB 이하만 업로드할 수 있습니다.")

    try:
        return await run_in_threadpool(classifier.classify, data, image.content_type)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except ClassificationError as e:
        raise HTTPException(422, str(e)) from e
    except anthropic.BadRequestError as e:
        logger.warning("Claude API bad request: %s", e)
        raise HTTPException(400, "이미지를 처리할 수 없습니다. 다른 사진으로 시도해 주세요.") from e
    except anthropic.AuthenticationError as e:
        logger.error("Claude API authentication failed: %s", e)
        raise HTTPException(500, "서버의 API 키 설정을 확인해 주세요.") from e
    except anthropic.RateLimitError as e:
        raise HTTPException(429, "요청이 많습니다. 잠시 후 다시 시도해 주세요.") from e
    except anthropic.APIStatusError as e:
        logger.error("Claude API error %s: %s", e.status_code, e)
        raise HTTPException(502, "분석 서버에 문제가 발생했습니다.") from e
    except anthropic.APIConnectionError as e:
        logger.error("Claude API connection error: %s", e)
        raise HTTPException(503, "분석 서버에 연결할 수 없습니다.") from e

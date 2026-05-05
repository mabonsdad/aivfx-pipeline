from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.models.schemas import ApiReferenceVideoGenerateRequest, SegmentGenerateRequest


def test_segment_generate_rejects_invalid_model() -> None:
    with pytest.raises(ValidationError):
        SegmentGenerateRequest(lumaModel="not-a-model", mode="flex_1")


def test_segment_generate_rejects_invalid_mode() -> None:
    with pytest.raises(ValidationError):
        SegmentGenerateRequest(lumaModel="ray-2", mode="not-a-mode")


def test_segment_generate_accepts_valid_contract_values() -> None:
    req = SegmentGenerateRequest(lumaModel="ray-2", mode="flex_1", preserveFrames=True)
    assert req.lumaModel == "ray-2"
    assert req.mode == "flex_1"


def test_api_reference_video_generate_validates_model_and_mode() -> None:
    with pytest.raises(ValidationError):
        ApiReferenceVideoGenerateRequest(
            model="ray-2",
            mode="bad-mode",
            firstFrameAssetKey="users/u/api_uploads/a/incoming.png",
        )

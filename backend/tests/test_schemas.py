from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.models.schemas import ApiReferenceVideoGenerateRequest, ExportTopazUpscaleRequest, FullEditRequest, SegmentGenerateRequest


def test_segment_generate_rejects_invalid_model() -> None:
    with pytest.raises(ValidationError):
        SegmentGenerateRequest(lumaModel="not-a-model", mode="flex_1")


def test_segment_generate_rejects_invalid_mode() -> None:
    with pytest.raises(ValidationError):
        SegmentGenerateRequest(lumaModel="ray-3.2-720p", mode="not-a-mode")


def test_segment_generate_accepts_valid_contract_values() -> None:
    req = SegmentGenerateRequest(lumaModel="ray-3.2-720p", mode="flex_1", preserveFrames=True)
    assert req.lumaModel == "ray-3.2-720p"
    assert req.mode == "flex_1"


def test_api_reference_video_generate_validates_model_and_mode() -> None:
    with pytest.raises(ValidationError):
        ApiReferenceVideoGenerateRequest(
            model="ray-3.2-720p",
            mode="bad-mode",
            firstFrameAssetKey="users/u/api_uploads/a/incoming.png",
        )


def test_export_topaz_upscale_request_validates_model_and_preset() -> None:
    req = ExportTopazUpscaleRequest(model="Proteus", preset="balanced", upscaleFactor=1.0)
    assert req.model == "Proteus"
    assert req.preset == "balanced"

    with pytest.raises(ValidationError):
        ExportTopazUpscaleRequest(model="NotAModel", preset="balanced", upscaleFactor=2.0)

    with pytest.raises(ValidationError):
        ExportTopazUpscaleRequest(model="Proteus", preset="invalid", upscaleFactor=2.0)


@pytest.mark.parametrize("model", ["luma_uni_1", "luma_uni_1_max"])
def test_full_edit_request_accepts_luma_uni_models(model: str) -> None:
    req = FullEditRequest(
        model=model,
        prompt="Replace the background with a misty forest at dawn",
    )
    assert req.model == model
    assert req.lumaUniModel is None


def test_full_edit_request_accepts_legacy_luma_uni_options() -> None:
    req = FullEditRequest(
        model="luma_uni_1_1",
        prompt="Replace the background with a misty forest at dawn",
        lumaUniModel="uni-1-max",
        lumaUniStyle="manga",
        lumaUniOutputFormat="jpeg",
    )
    assert req.model == "luma_uni_1_1"
    assert req.lumaUniModel == "uni-1-max"
    assert req.lumaUniStyle == "manga"
    assert req.lumaUniOutputFormat == "jpeg"

    with pytest.raises(ValidationError):
        FullEditRequest(model="luma_uni_1_1", prompt="x", lumaUniModel="bad-model")

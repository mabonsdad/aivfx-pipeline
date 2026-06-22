from __future__ import annotations

import pytest

from src.contracts.video import VIDEO_MODEL_IDS
from src.generation.capabilities import (
    get_video_model_capability,
    resolve_video_model_provider_fps,
    validate_video_model_mode,
    validate_video_model_prompt,
)


def test_all_video_models_are_resolvable() -> None:
    for model in VIDEO_MODEL_IDS:
        capability = get_video_model_capability(model)
        assert capability.model == model


def test_validate_video_mode_rejects_invalid_mode() -> None:
    with pytest.raises(ValueError):
        validate_video_model_mode("ray-3.2-720p", "runway_i2v")


def test_validate_video_prompt_requires_markers() -> None:
    with pytest.raises(ValueError):
        validate_video_model_prompt("seedance-2.0-reference-to-video", "animate this")


def test_validate_video_prompt_requires_luma_prompt() -> None:
    with pytest.raises(ValueError):
        validate_video_model_prompt("ray-3.2-720p", None)


def test_provider_fps_uses_cap_when_not_preserving_frames() -> None:
    fps, reason = resolve_video_model_provider_fps(
        model="wan2.7-videoedit",
        source_fps=30,
        preserve_frames=False,
    )
    assert float(fps) == 24.0
    assert reason == "resample_to_model_fps"

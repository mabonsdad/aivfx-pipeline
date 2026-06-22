from __future__ import annotations

import importlib
import sys
import types


def _import_luma_module():
    if "tenacity" not in sys.modules:
        tenacity = types.ModuleType("tenacity")

        def retry(*_args, **_kwargs):
            def decorator(fn):
                return fn

            return decorator

        tenacity.retry = retry
        tenacity.stop_after_attempt = lambda *_args, **_kwargs: None
        tenacity.wait_exponential = lambda *_args, **_kwargs: None
        sys.modules["tenacity"] = tenacity

    sys.modules.pop("src.integrations.luma", None)
    return importlib.import_module("src.integrations.luma")


def test_create_video_edit_generation_sends_start_frame(monkeypatch) -> None:
    luma = _import_luma_module()
    captured: dict[str, object] = {}

    def fake_request(method: str, url: str, *, token: str, payload: dict[str, object] | None = None) -> dict[str, object]:
        captured["method"] = method
        captured["url"] = url
        captured["token"] = token
        captured["payload"] = payload or {}
        return {"id": "gen_123"}

    monkeypatch.setattr(luma, "_request", fake_request)

    result = luma.create_video_edit_generation(
        api_key="luma-api-test",
        media_url="https://example.com/source.mp4",
        resolution="720p",
        strength="flex_1",
        prompt="Make it cinematic",
        start_frame_url="https://example.com/guide.jpg",
    )

    assert result["id"] == "gen_123"
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["type"] == "video_edit"
    assert payload["prompt"] == "Make it cinematic"
    video = payload["video"]
    assert isinstance(video, dict)
    assert video["start_frame"] == {"url": "https://example.com/guide.jpg"}

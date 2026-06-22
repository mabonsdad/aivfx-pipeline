from __future__ import annotations

import importlib
import sys
import types


def _import_runway_module():
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

    sys.modules.pop("src.integrations.runway", None)
    return importlib.import_module("src.integrations.runway")


def test_create_video_to_video_sends_aleph2_keyframes(monkeypatch) -> None:
    runway = _import_runway_module()
    captured: dict[str, object] = {}

    def fake_request(method: str, url: str, *, token: str, payload: dict[str, object] | None = None) -> dict[str, object]:
        captured["method"] = method
        captured["url"] = url
        captured["token"] = token
        captured["payload"] = payload or {}
        return {"id": "task_123"}

    monkeypatch.setattr(runway, "_request", fake_request)

    result = runway.create_video_to_video(
        api_key="runway-key",
        video_uri="runway://video-token",
        prompt_text="Restyle the scene",
        first_frame_uri="runway://image-token",
        model="aleph2",
    )

    assert result["id"] == "task_123"
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["model"] == "aleph2"
    assert payload["videoUri"] == "runway://video-token"
    assert payload["promptText"] == "Restyle the scene"
    assert payload["keyframes"] == [{"uri": "runway://image-token", "at": 0.0}]
    assert "references" not in payload
    assert "ratio" not in payload

from __future__ import annotations

import json
from types import SimpleNamespace

from src import api_handler


def _event(method: str, path: str, body: dict | None = None) -> dict:
    event: dict = {
        "rawPath": path,
        "requestContext": {
            "http": {"method": method},
            "requestId": "req-1",
        },
        "headers": {},
    }
    if body is not None:
        event["body"] = json.dumps(body)
    return event


def test_health_route_is_public() -> None:
    result = api_handler._route(_event("GET", "/health"))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["ok"] is True


def test_me_requires_auth() -> None:
    result = api_handler._route(_event("GET", "/me"))
    assert result["statusCode"] == 401


def test_unknown_route_returns_404_when_authorized(monkeypatch) -> None:
    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: object())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())

    result = api_handler._route(_event("GET", "/unknown"))
    assert result["statusCode"] == 404


def test_admin_prompt_wizard_route_requires_owner_or_pin(monkeypatch) -> None:
    class _Store:
        def get_json(self, _key: str):
            return None

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "other@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())

    result = api_handler._route(_event("GET", "/admin/prompt-wizard-config"))
    assert result["statusCode"] == 403


def test_admin_prompt_wizard_route_returns_config_for_owner(monkeypatch) -> None:
    class _Store:
        def get_json(self, _key: str):
            return {
                "schemaVersion": 1,
                "systemPrompt": "Owner prompt",
                "models": [],
                "updatedAt": "2026-05-10T00:00:00Z",
                "updatedBy": "owner",
            }

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "robin.moore@shwsh.co.uk"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())

    result = api_handler._route(_event("GET", "/admin/prompt-wizard-config"))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["config"]["systemPrompt"] == "Owner prompt"
    assert payload["access"]["isOwner"] is True


def test_admin_prompt_wizard_route_updates_config_with_pin(monkeypatch) -> None:
    saved_payload: dict | None = None

    class _Store:
        def get_json(self, _key: str):
            return None

        def put_json(self, _key: str, payload: dict):
            nonlocal saved_payload
            saved_payload = payload

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "other@example.com", "sub": "user-1"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "now_iso", lambda: "2026-05-10T12:00:00Z")

    event = _event(
        "PUT",
        "/admin/prompt-wizard-config",
        {
            "schemaVersion": 1,
            "systemPrompt": "Updated prompt",
            "models": [
                {
                    "selected_model": "ray-2",
                    "dropdown_name": "Luma Ray 2",
                    "mode": "start_video",
                    "provider": "Luma",
                    "provider_model": "ray-2",
                    "endpoint_used": "POST https://api.lumalabs.ai/dream-machine/v1/generations/video/modify",
                    "required_markers": [],
                    "supports_negative_prompt": False,
                    "prompt_strategy": "luma_descriptive_change",
                }
            ],
        },
    )
    event["headers"] = {"x-admin-pin": "246810"}
    result = api_handler._route(event)
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["config"]["systemPrompt"] == "Updated prompt"
    assert payload["access"]["viaPin"] is True
    assert saved_payload is not None
    assert saved_payload["updatedAt"] == "2026-05-10T12:00:00Z"


def test_jobs_route_returns_job_when_authorized(monkeypatch) -> None:
    class _Store:
        def load_job(self, user_id: str, job_id: str):
            if user_id == "user-1" and job_id == "job_123":
                return {"jobId": "job_123", "status": "queued"}
            return None

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())

    result = api_handler._route(_event("GET", "/jobs/job_123"))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_123"


def test_jobs_cancel_route_marks_queued_generation_job_failed_and_cleans_generation(monkeypatch) -> None:
    class _Store:
        def __init__(self) -> None:
            self.job = {
                "jobId": "job_123",
                "userId": "user-1",
                "taskId": "task_1",
                "type": "segment_generate",
                "status": "queued",
                "progress": 0,
                "payload": {"genId": "gen_1", "segmentId": "seg_1"},
                "createdAt": "2026-05-07T10:00:00Z",
                "updatedAt": "2026-05-07T10:00:00Z",
            }
            self.task = {
                "taskId": "task_1",
                "userId": "user-1",
                "segmentGenerations": {
                    "gen_1": {
                        "genId": "gen_1",
                        "segmentId": "seg_1",
                        "status": "queued",
                        "jobId": "job_123",
                    }
                },
                "segments": [],
                "history": [],
            }

        def load_job(self, user_id: str, job_id: str):
            if user_id == "user-1" and job_id == "job_123":
                return self.job
            return None

        def save_job(self, job: dict):
            self.job = job
            return job

        def load_task(self, user_id: str, task_id: str):
            if user_id == "user-1" and task_id == "task_1":
                return self.task
            return None

        def save_task(self, task_payload: dict, **_kwargs):
            self.task = task_payload
            return task_payload

    store = _Store()
    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: store)
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())

    result = api_handler._route(_event("POST", "/jobs/job_123/cancel", {"reason": "user requested stop"}))
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["ok"] is True
    assert payload["jobId"] == "job_123"

    assert store.job["status"] == "failed"
    assert store.job.get("cancelRequestedAt")
    assert "Cancelled by user" in str(store.job.get("error"))
    generation = store.task["segmentGenerations"]["gen_1"]
    assert generation["status"] == "failed"
    assert "Cancelled by user" in str(generation.get("error"))


def test_jobs_cancel_route_returns_terminal_marker_for_completed_job(monkeypatch) -> None:
    class _Store:
        def __init__(self) -> None:
            self.job = {
                "jobId": "job_done",
                "userId": "user-1",
                "taskId": "task_1",
                "type": "segment_generate",
                "status": "complete",
                "progress": 100,
            }

        def load_job(self, user_id: str, job_id: str):
            if user_id == "user-1" and job_id == "job_done":
                return self.job
            return None

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())

    result = api_handler._route(_event("POST", "/jobs/job_done/cancel", {"reason": "late click"}))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["ok"] is True
    assert payload["alreadyTerminal"] is True


def test_api_requests_list_route_returns_empty_list(monkeypatch) -> None:
    class _Store:
        def list_api_requests(self, user_id: str):
            assert user_id == "user-1"
            return []

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())

    result = api_handler._route(_event("GET", "/api/v1/requests"))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["requests"] == []


def test_create_task_route_persists_and_returns_task_id(monkeypatch) -> None:
    saved: list[dict] = []

    class _Store:
        def list_tasks(self, _user_id: str):
            return []

        def save_task(self, task: dict):
            saved.append(task.copy())
            return task

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "new_id", lambda prefix: f"{prefix}_abc")

    result = api_handler._route(_event("POST", "/tasks", {"name": "Demo Task"}))
    assert result["statusCode"] == 201
    payload = json.loads(result["body"])
    assert payload["taskId"] == "task_abc"
    assert saved and saved[0]["taskId"] == "task_abc"


def test_delete_task_route_marks_task_deleted(monkeypatch) -> None:
    task = {"taskId": "task_1", "status": "ready"}
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict):
            saved.append(task_payload.copy())
            return task_payload

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: object())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(_event("DELETE", "/tasks/task_1"))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["ok"] is True
    assert saved and saved[0]["status"] == "error"
    assert "deletedAt" in saved[0]


def test_get_task_detail_route_returns_task_payload(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "status": "created",
        "video": {},
        "frames": {},
        "segments": [],
        "qualityMatchAnalyses": {},
        "videoCleanupTracks": [],
        "segmentGenerations": {},
        "chunkedGenerationRuns": [],
        "externalQcPairs": [],
        "exports": [],
    }

    class _Store:
        def save_task(self, task_payload: dict):
            return task_payload

    class _AssetStore:
        def presign_get(self, key: str, expires: int = 0):
            return f"https://example.invalid/{key}?e={expires}"

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(_event("GET", "/tasks/task_1"))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["taskId"] == "task_1"


def test_task_upload_video_route_sets_original_upload(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "video": {},
        "status": "ready",
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        def presign_put(self, key: str, expires: int = 0, content_type: str | None = None):
            return f"https://upload.example/{key}?e={expires}&ct={content_type}"

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/uploads/video",
            {"filename": "input.mp4", "contentType": "video/mp4", "sizeBytes": 1234},
        )
    )
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["s3Key"].startswith("users/user-1/tasks/task_1/")
    assert "/original/" in payload["s3Key"]
    assert saved
    assert saved[-1]["video"]["original"]["s3Key"] == payload["s3Key"]
    assert saved[-1]["status"] == "created"


def test_task_delete_upload_asset_route_removes_original(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "video": {"original": {"s3Key": "users/user-1/tasks/task_1/uploads/original/input.mp4"}},
        "status": "ready",
    }
    saved: list[dict] = []
    deleted_keys: list[str] = []

    class _Store:
        def save_task(self, task_payload: dict):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        def delete_object(self, key: str):
            deleted_keys.append(key)

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(_event("DELETE", "/tasks/task_1/assets", {"assetType": "upload"}))
    assert result["statusCode"] == 200
    assert deleted_keys == ["users/user-1/tasks/task_1/uploads/original/input.mp4"]
    assert saved
    assert "original" not in saved[-1]["video"]
    assert saved[-1]["status"] == "created"


def test_get_task_report_route_returns_report_payload(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "customReports": [{"reportId": "report_1", "name": "Report 1"}],
    }

    class _Store:
        pass

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(_event("GET", "/tasks/task_1/reports/report_1"))
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["report"]["reportId"] == "report_1"


def test_cleanup_sam_assist_route_returns_job_id(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "filePrefix": "",
        "videoCleanupTracks": [
            {
                "trackId": "trk_1",
                "status": "created",
                "source": {"frameCount": 12},
            }
        ],
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "_queue_job", lambda **_kwargs: "job_1")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/cleanup-tracks/trk_1/sam-assist",
            {"frameIndexLocal": 2},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_1"
    assert "genId" not in payload
    assert saved and saved[-1]["videoCleanupTracks"][0]["status"] == "tracking"


def test_cleanup_preview_route_returns_job_id(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "videoCleanupTracks": [
            {
                "trackId": "trk_1",
                "status": "created",
                "source": {"frameCount": 12},
                "settings": {},
            }
        ],
    }

    class _Store:
        pass

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "_queue_job", lambda **_kwargs: "job_2")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/cleanup-tracks/trk_1/preview",
            {},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_2"
    assert "genId" not in payload


def test_segment_generate_route_returns_job_and_gen(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "video": {"editSource": {"fps": {"num": 24, "den": 1}}},
        "segments": [
            {
                "segmentId": "seg_1",
                "startFrame": 0,
                "endFrameExclusive": 24,
                "durationFrames": 24,
                "durationSec": 1.0,
                "crop": None,
            }
        ],
        "segmentGenerations": {},
        "history": [],
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict, merge_on_conflict: bool = False):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "_queue_job", lambda **_kwargs: "job_seg")
    monkeypatch.setattr(api_handler, "new_id", lambda prefix: f"{prefix}_abc")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/segments/seg_1/generate",
            {"lumaModel": "ray-2", "mode": "adhere_1", "prompt": "make it cinematic"},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_seg"
    assert payload["genId"] == "gen_abc"
    assert saved
    assert "gen_abc" in saved[-1]["segmentGenerations"]


def test_manual_segment_upload_init_route_returns_upload_details(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "filePrefix": "",
        "segments": [{"segmentId": "seg_1"}],
    }

    class _Store:
        pass

    class _AssetStore:
        def presign_put(self, key: str, expires: int = 0, content_type: str | None = None):
            return f"https://upload.example/{key}?e={expires}&ct={content_type}"

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "new_id", lambda prefix: f"{prefix}_abc")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/segments/seg_1/manual-generation/upload/init",
            {"filename": "clip.mp4", "contentType": "video/mp4"},
        )
    )
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert "/segments/seg_1/manual_uploads/" in payload["uploadKey"]
    assert payload["uploadUrl"].startswith("https://upload.example/")


def test_chunked_generation_pause_route_updates_run_status(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "chunkedGenerationRuns": [{"runId": "run_1", "status": "running", "chunks": []}],
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict, merge_on_conflict: bool = False):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/chunked-generations/run_1/pause",
            {"reason": "manual pause"},
        )
    )
    assert result["statusCode"] == 200
    payload = json.loads(result["body"])
    assert payload["ok"] is True
    assert saved
    run = saved[-1]["chunkedGenerationRuns"][0]
    assert run["status"] == "paused"
    assert run["pauseReason"] == "manual pause"


def test_chunked_generation_save_draft_route_queues_finalize_job(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "chunkedGenerationRuns": [{"runId": "run_1", "status": "complete", "chunks": []}],
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict, merge_on_conflict: bool = False):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "_queue_job", lambda **_kwargs: "job_finalize")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/chunked-generations/run_1/save-draft",
            {},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_finalize"
    assert saved
    run = saved[-1]["chunkedGenerationRuns"][0]
    assert run["saveStatus"] == "queued"
    assert run["saveJobId"] == "job_finalize"


def test_segment_generation_extend_route_missing_generation_returns_404(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "segmentGenerations": {},
        "segments": [],
        "video": {"editSource": {"frameCount": 120, "fps": {"num": 24, "den": 1}}},
    }

    class _Store:
        pass

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/segment-generations/gen_missing/extend",
            {"alignmentFrameIndex": 10},
        )
    )
    assert result["statusCode"] == 404


def test_segment_generation_extend_route_adjusts_late_alignment_to_model_minimum(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "video": {"editSource": {"frameCount": 240, "fps": {"num": 24, "den": 1}}},
        "segments": [
            {
                "segmentId": "seg_prev",
                "startFrame": 0,
                "endFrameExclusive": 240,
                "durationFrames": 240,
                "durationSec": 10.0,
                "startFrameId": "frame_prev",
            }
        ],
        "segmentGenerations": {
            "gen_prev": {
                "genId": "gen_prev",
                "segmentId": "seg_prev",
                "status": "complete",
                "outputKey": "users/user-1/tasks/task_1/generated/gen_prev.mp4",
                "luma": {"model": "ray-2", "mode": "start_video", "prompt": "Continue motion"},
                "generationSettings": {},
            }
        },
        "frames": {"frame_prev": {"frameId": "frame_prev", "variants": []}},
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict, merge_on_conflict: bool = False):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "supports_generation_extension", lambda _model: True)
    monkeypatch.setattr(api_handler, "get_video_model_capability", lambda _model: SimpleNamespace(max_seconds=10, min_seconds=4))
    monkeypatch.setattr(api_handler, "_resolve_segment_frames", lambda _task, start, end_frame_exclusive: (start, end_frame_exclusive, end_frame_exclusive - start))

    def _create_segment_record(*, task: dict, start: int, end_excl: int, dur_frames: int, asset_store: object):
        segment = {
            "segmentId": "seg_next",
            "startFrame": start,
            "endFrameExclusive": end_excl,
            "durationFrames": dur_frames,
            "durationSec": round(dur_frames / 24, 3),
            "startFrameId": "frame_next",
        }
        task.setdefault("segments", []).append(segment)
        task.setdefault("frames", {})["frame_next"] = {"frameId": "frame_next", "variants": []}
        return segment

    monkeypatch.setattr(api_handler, "_create_segment_record", _create_segment_record)
    monkeypatch.setattr(api_handler, "_segment_model_limit_error", lambda _task, _segment, _model: None)
    monkeypatch.setattr(
        api_handler,
        "_copy_generated_anchor_to_frame_variant",
        lambda **_kwargs: {"variantId": "var_anchor", "sourceGeneratedFrameIndex": 90},
    )
    monkeypatch.setattr(api_handler, "_queue_segment_generation_record", lambda **_kwargs: ("gen_next", "job_next"))

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/segment-generations/gen_prev/extend",
            {"alignmentFrameIndex": 236, "anchorFramesFromEnd": 5, "durationSeconds": 4, "prompt": "Continue motion"},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["alignmentFrameIndex"] == 144
    assert payload["requestedAlignmentFrameIndex"] == 236
    assert saved


def test_generation_merge_alignment_suggestion_route_queues_job(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "segmentGenerations": {
            "gen_1": {
                "genId": "gen_1",
                "status": "complete",
                "outputKey": "users/user-1/tasks/task_1/generated/out.mp4",
            }
        },
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "_queue_job", lambda **_kwargs: "job_align")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/segment-generations/gen_1/merge-alignment-suggestion",
            {},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_align"
    assert saved
    state = saved[-1]["segmentGenerations"]["gen_1"]["mergeAlignmentSuggestion"]
    assert state["status"] == "queued"
    assert state["jobId"] == "job_align"


def test_generation_reconcile_timing_route_queues_derived_generation(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "segmentGenerations": {
            "gen_1": {
                "genId": "gen_1",
                "segmentId": "seg_1",
                "status": "complete",
                "outputKey": "users/user-1/tasks/task_1/generated/out.mp4",
                "generationSettings": {},
            }
        },
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "_queue_job", lambda **_kwargs: "job_reconcile")
    monkeypatch.setattr(api_handler, "new_id", lambda prefix: f"{prefix}_abc")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/segment-generations/gen_1/reconcile-timing",
            {"trimStartFrames": 1, "trimEndFrames": 2},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_reconcile"
    assert payload["genId"] == "gen_abc"
    assert saved
    assert "gen_abc" in saved[-1]["segmentGenerations"]


def test_export_topaz_upscale_route_queues_job(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "exports": [
            {
                "exportId": "exp_1",
                "outputKey": "users/user-1/tasks/task_1/exports/output.mp4",
                "createdAt": "2026-05-06T10:00:00Z",
            }
        ],
    }
    saved: list[dict] = []

    class _Store:
        def save_task(self, task_payload: dict):
            saved.append(json.loads(json.dumps(task_payload)))
            return task_payload

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)
    monkeypatch.setattr(api_handler, "_queue_job", lambda **_kwargs: "job_topaz")
    monkeypatch.setattr(api_handler, "new_id", lambda prefix: f"{prefix}_new")

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/exports/exp_1/topaz-upscale",
            {"preset": "balanced", "model": "Proteus", "upscaleFactor": 2.0, "h264Output": True},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["jobId"] == "job_topaz"
    assert payload["exportId"] == "exp_new"
    assert saved
    state = saved[-1]["exports"][0]["topazUpscale"]
    assert state["status"] == "queued"
    assert state["jobId"] == "job_topaz"
    assert state["resultExportId"] == "exp_new"


def test_export_topaz_upscale_route_returns_existing_running_job(monkeypatch) -> None:
    task = {
        "taskId": "task_1",
        "userId": "user-1",
        "name": "Task 1",
        "exports": [
            {
                "exportId": "exp_1",
                "outputKey": "users/user-1/tasks/task_1/exports/output.mp4",
                "topazUpscale": {
                    "status": "running",
                    "jobId": "job_existing",
                    "resultExportId": "exp_prev",
                },
            }
        ],
    }

    class _Store:
        pass

    class _AssetStore:
        pass

    monkeypatch.setattr(api_handler, "get_user_id", lambda _event: "user-1")
    monkeypatch.setattr(api_handler, "get_user_claims", lambda _event: {"email": "u@example.com"})
    monkeypatch.setattr(api_handler, "S3JsonStore", lambda _bucket: _Store())
    monkeypatch.setattr(api_handler, "AssetStore", lambda _bucket, _region: _AssetStore())
    monkeypatch.setattr(api_handler, "JobQueue", lambda _url: object())
    monkeypatch.setattr(api_handler, "_load_task_or_404", lambda _store, _user_id, _task_id: task)

    result = api_handler._route(
        _event(
            "POST",
            "/tasks/task_1/exports/exp_1/topaz-upscale",
            {"preset": "balanced"},
        )
    )
    assert result["statusCode"] == 202
    payload = json.loads(result["body"])
    assert payload["alreadyRunning"] is True
    assert payload["jobId"] == "job_existing"
    assert payload["exportId"] == "exp_prev"

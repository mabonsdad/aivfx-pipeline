from __future__ import annotations

import json

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

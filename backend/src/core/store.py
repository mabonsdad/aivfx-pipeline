from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_KEYED_LIST_IDS: dict[str, str] = {
    "segments": "segmentId",
    "chunkedGenerationRuns": "runId",
    "videoCleanupTracks": "trackId",
    "customReports": "reportId",
    "externalQcPairs": "pairId",
    "variants": "variantId",
    "references": "referenceId",
    "propagationRuns": "runId",
    "keyframes": "id",
    "currentMasks": "frameIndexLocal",
}


def _merge_keyed_lists(current: list[Any], incoming: list[Any], item_id_key: str) -> list[Any]:
    merged_order: list[str] = []
    merged_lookup: dict[str, Any] = {}

    def _key_for(item: Any) -> str | None:
        if not isinstance(item, dict):
            return None
        value = item.get(item_id_key)
        return str(value) if value is not None else None

    for item in current:
        item_key = _key_for(item)
        if item_key is None:
            continue
        merged_order.append(item_key)
        merged_lookup[item_key] = deepcopy(item)

    for item in incoming:
        item_key = _key_for(item)
        if item_key is None:
            continue
        if item_key in merged_lookup and isinstance(merged_lookup[item_key], dict) and isinstance(item, dict):
            merged_lookup[item_key] = _merge_records(merged_lookup[item_key], item)
        else:
            merged_lookup[item_key] = deepcopy(item)
        if item_key not in merged_order:
            merged_order.append(item_key)

    merged_items = [merged_lookup[item_key] for item_key in merged_order if item_key in merged_lookup]

    current_non_keyed = [deepcopy(item) for item in current if _key_for(item) is None]
    incoming_non_keyed = [deepcopy(item) for item in incoming if _key_for(item) is None]
    return current_non_keyed + merged_items + incoming_non_keyed


def _merge_history(current: list[Any], incoming: list[Any]) -> list[Any]:
    merged: list[Any] = []
    seen: set[str] = set()
    for item in current + incoming:
        marker = json.dumps(item, sort_keys=True, default=str)
        if marker in seen:
            continue
        seen.add(marker)
        merged.append(deepcopy(item))
    return merged


def _merge_records(current: Any, incoming: Any, *, field_name: str | None = None) -> Any:
    if isinstance(current, dict) and isinstance(incoming, dict):
        merged = deepcopy(current)
        for key, incoming_value in incoming.items():
            if key not in merged:
                merged[key] = deepcopy(incoming_value)
                continue
            current_value = merged[key]
            if key == "history" and isinstance(current_value, list) and isinstance(incoming_value, list):
                merged[key] = _merge_history(current_value, incoming_value)
                continue
            keyed_list_id = _KEYED_LIST_IDS.get(key)
            if keyed_list_id and isinstance(current_value, list) and isinstance(incoming_value, list):
                merged[key] = _merge_keyed_lists(current_value, incoming_value, keyed_list_id)
                continue
            merged[key] = _merge_records(current_value, incoming_value, field_name=key)
        return merged
    if isinstance(current, list) and isinstance(incoming, list):
        keyed_list_id = _KEYED_LIST_IDS.get(field_name or "")
        if keyed_list_id:
            return _merge_keyed_lists(current, incoming, keyed_list_id)
        return deepcopy(incoming)
    return deepcopy(incoming)


class S3JsonStore:
    def __init__(self, metadata_bucket: str):
        self.metadata_bucket = metadata_bucket
        self.s3 = boto3.client("s3")

    @staticmethod
    def task_key(user_id: str, task_id: str) -> str:
        return f"users/{user_id}/tasks/{task_id}/task.json"

    @staticmethod
    def task_snapshots_prefix(user_id: str, task_id: str) -> str:
        return f"users/{user_id}/tasks/{task_id}/snapshots/"

    @staticmethod
    def task_snapshots_key(user_id: str, task_id: str, version: int) -> str:
        return f"users/{user_id}/tasks/{task_id}/snapshots/{version}.json"

    @staticmethod
    def user_tasks_prefix(user_id: str) -> str:
        return f"users/{user_id}/tasks/"

    @staticmethod
    def job_key(user_id: str, job_id: str) -> str:
        return f"users/{user_id}/jobs/{job_id}.json"

    @staticmethod
    def report_result_key(user_id: str, task_id: str, report_id: str) -> str:
        return f"users/{user_id}/tasks/{task_id}/reports/{report_id}.json"

    @staticmethod
    def api_request_key(user_id: str, request_id: str) -> str:
        return f"users/{user_id}/api_requests/{request_id}.json"

    @staticmethod
    def user_api_requests_prefix(user_id: str) -> str:
        return f"users/{user_id}/api_requests/"

    def get_json(self, key: str) -> dict[str, Any] | None:
        try:
            data = self.s3.get_object(Bucket=self.metadata_bucket, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
                return None
            raise
        return json.loads(data)

    def put_json(self, key: str, payload: dict[str, Any]) -> None:
        self.s3.put_object(
            Bucket=self.metadata_bucket,
            Key=key,
            Body=json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )

    def delete_json(self, key: str) -> None:
        self.s3.delete_object(Bucket=self.metadata_bucket, Key=key)

    def load_task(self, user_id: str, task_id: str) -> dict[str, Any] | None:
        return self.get_json(self.task_key(user_id, task_id))

    def save_task(self, task: dict[str, Any], *, snapshot: bool = True, merge_on_conflict: bool = False) -> dict[str, Any]:
        user_id = task["userId"]
        task_id = task["taskId"]
        key = self.task_key(user_id, task_id)
        base_version = int(task.get("metaVersion", 0))
        current = self.get_json(key)
        to_save = deepcopy(task)
        if merge_on_conflict and isinstance(current, dict) and int(current.get("metaVersion", 0)) > base_version:
            to_save = _merge_records(current, to_save)
        latest_version = int(current.get("metaVersion", 0)) if isinstance(current, dict) else base_version
        to_save["updatedAt"] = now_iso()
        to_save["metaVersion"] = latest_version + 1
        self.put_json(key, to_save)
        if snapshot:
            self.put_json(self.task_snapshots_key(user_id, task_id, to_save["metaVersion"]), to_save)
        task.clear()
        task.update(to_save)
        return task

    def list_tasks(self, user_id: str) -> list[dict[str, Any]]:
        prefix = self.user_tasks_prefix(user_id)
        paginator = self.s3.get_paginator("list_objects_v2")
        tasks: list[dict[str, Any]] = []
        for page in paginator.paginate(Bucket=self.metadata_bucket, Prefix=prefix):
            for item in page.get("Contents", []):
                key = item["Key"]
                if not key.endswith("/task.json"):
                    continue
                payload = self.get_json(key)
                if payload and not payload.get("deletedAt"):
                    tasks.append(payload)
        tasks.sort(key=lambda t: t.get("updatedAt", ""), reverse=True)
        return tasks

    def load_job(self, user_id: str, job_id: str) -> dict[str, Any] | None:
        return self.get_json(self.job_key(user_id, job_id))

    def save_job(self, job: dict[str, Any]) -> dict[str, Any]:
        job["updatedAt"] = now_iso()
        self.put_json(self.job_key(job["userId"], job["jobId"]), job)
        return job

    def load_api_request(self, user_id: str, request_id: str) -> dict[str, Any] | None:
        return self.get_json(self.api_request_key(user_id, request_id))

    def save_api_request(self, request_record: dict[str, Any]) -> dict[str, Any]:
        request_record["updatedAt"] = now_iso()
        self.put_json(self.api_request_key(request_record["userId"], request_record["requestId"]), request_record)
        return request_record

    def list_api_requests(self, user_id: str) -> list[dict[str, Any]]:
        prefix = self.user_api_requests_prefix(user_id)
        paginator = self.s3.get_paginator("list_objects_v2")
        requests: list[dict[str, Any]] = []
        for page in paginator.paginate(Bucket=self.metadata_bucket, Prefix=prefix):
            for item in page.get("Contents", []):
                key = item["Key"]
                if not key.endswith(".json"):
                    continue
                payload = self.get_json(key)
                if payload:
                    requests.append(payload)
        requests.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
        return requests

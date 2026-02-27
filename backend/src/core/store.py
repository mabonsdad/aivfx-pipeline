from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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

    def load_task(self, user_id: str, task_id: str) -> dict[str, Any] | None:
        return self.get_json(self.task_key(user_id, task_id))

    def save_task(self, task: dict[str, Any], *, snapshot: bool = True) -> dict[str, Any]:
        user_id = task["userId"]
        task_id = task["taskId"]
        task["updatedAt"] = now_iso()
        version = int(task.get("metaVersion", 0)) + 1
        task["metaVersion"] = version
        key = self.task_key(user_id, task_id)
        self.put_json(key, task)
        if snapshot:
            self.put_json(self.task_snapshots_key(user_id, task_id, version), task)
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

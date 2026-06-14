#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import boto3


@dataclass
class DeletedTaskRecord:
    user_id: str
    task_id: str
    deleted_at: str
    name: str | None
    workflow_id: str | None


def _list_deleted_tasks(s3, metadata_bucket: str, *, user_id: str | None = None) -> list[DeletedTaskRecord]:
    prefix = f"users/{user_id}/tasks/" if user_id else "users/"
    paginator = s3.get_paginator("list_objects_v2")
    deleted: list[DeletedTaskRecord] = []
    for page in paginator.paginate(Bucket=metadata_bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            key = str(item.get("Key") or "")
            if not key.endswith("/task.json"):
                continue
            payload = json.loads(s3.get_object(Bucket=metadata_bucket, Key=key)["Body"].read())
            deleted_at = str(payload.get("deletedAt") or "").strip()
            if not deleted_at:
                continue
            deleted.append(
                DeletedTaskRecord(
                    user_id=str(payload.get("userId") or ""),
                    task_id=str(payload.get("taskId") or ""),
                    deleted_at=deleted_at,
                    name=(str(payload.get("name")) if payload.get("name") is not None else None),
                    workflow_id=(str(payload.get("workflowId")) if payload.get("workflowId") is not None else None),
                )
            )
    return deleted


def _sum_prefix(s3, bucket: str, prefix: str) -> tuple[int, int]:
    paginator = s3.get_paginator("list_objects_v2")
    count = 0
    size = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            count += 1
            size += int(item.get("Size") or 0)
    return count, size


def _delete_versions(s3, bucket: str, prefix: str) -> tuple[int, int]:
    paginator = s3.get_paginator("list_object_versions")
    deleted_versions = 0
    deleted_markers = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        batch: list[dict[str, str]] = []
        for field, counter_name in (("Versions", "version"), ("DeleteMarkers", "marker")):
            for item in page.get(field) or []:
                key = item.get("Key")
                version_id = item.get("VersionId")
                if not key or not version_id:
                    continue
                batch.append({"Key": key, "VersionId": version_id})
                if counter_name == "version":
                    deleted_versions += 1
                else:
                    deleted_markers += 1
        for start in range(0, len(batch), 1000):
            chunk = batch[start : start + 1000]
            if chunk:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": chunk, "Quiet": True})
    return deleted_versions, deleted_markers


def _iter_task_prefixes(task: DeletedTaskRecord) -> Iterable[tuple[str, str]]:
    task_prefix = f"users/{task.user_id}/tasks/{task.task_id}/"
    yield ("assets", task_prefix)
    yield ("metadata", task_prefix)


def main() -> int:
    parser = argparse.ArgumentParser(description="Purge already-deleted AIVFX tasks from S3.")
    parser.add_argument("--assets-bucket", required=True)
    parser.add_argument("--metadata-bucket", required=True)
    parser.add_argument("--user-id")
    parser.add_argument("--apply", action="store_true", help="Actually delete versions and objects")
    args = parser.parse_args()

    s3 = boto3.client("s3")
    deleted_tasks = _list_deleted_tasks(s3, args.metadata_bucket, user_id=args.user_id)
    summary: list[dict[str, Any]] = []
    total_asset_bytes = 0
    total_meta_bytes = 0

    for task in deleted_tasks:
        asset_prefix = f"users/{task.user_id}/tasks/{task.task_id}/"
        meta_prefix = asset_prefix
        asset_objects, asset_bytes = _sum_prefix(s3, args.assets_bucket, asset_prefix)
        meta_objects, meta_bytes = _sum_prefix(s3, args.metadata_bucket, meta_prefix)
        total_asset_bytes += asset_bytes
        total_meta_bytes += meta_bytes
        row: dict[str, Any] = {
            "taskId": task.task_id,
            "userId": task.user_id,
            "deletedAt": task.deleted_at,
            "name": task.name,
            "workflowId": task.workflow_id,
            "assetObjects": asset_objects,
            "assetBytes": asset_bytes,
            "metaObjects": meta_objects,
            "metaBytes": meta_bytes,
        }
        if args.apply:
            asset_versions, asset_markers = _delete_versions(s3, args.assets_bucket, asset_prefix)
            meta_versions, meta_markers = _delete_versions(s3, args.metadata_bucket, meta_prefix)
            row["purged"] = {
                "assetVersionsDeleted": asset_versions,
                "assetDeleteMarkersDeleted": asset_markers,
                "metaVersionsDeleted": meta_versions,
                "metaDeleteMarkersDeleted": meta_markers,
            }
        summary.append(row)

    print(
        json.dumps(
            {
                "mode": "apply" if args.apply else "dry-run",
                "deletedTaskCount": len(deleted_tasks),
                "totalAssetBytes": total_asset_bytes,
                "totalMetaBytes": total_meta_bytes,
                "tasks": summary,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

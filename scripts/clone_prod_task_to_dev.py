from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def normalize_task_name(raw: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", raw.strip().lower())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_-")
    if not cleaned:
        cleaned = "task"
    return cleaned[:15]


def unique_task_name(base: str, existing_names: set[str]) -> str:
    candidate = base[:15]
    if candidate not in existing_names:
        return candidate
    index = 2
    while True:
        suffix = str(index)
        prefix = candidate[: max(1, 15 - len(suffix))]
        next_candidate = f"{prefix}{suffix}"
        if next_candidate not in existing_names:
            return next_candidate
        index += 1


def build_file_prefix(task_name: str, task_id: str, existing_prefixes: set[str]) -> str:
    date_part = datetime.now(timezone.utc).strftime("%y%m%d")
    name_alnum = re.sub(r"[^a-zA-Z0-9]+", "", task_name.lower())
    seed = f"{name_alnum}{re.sub(r'[^a-zA-Z0-9]+', '', task_id.lower())}zzzzz"
    base_root = (seed[:5]).ljust(5, "x")
    candidate = f"{base_root}-{date_part}-"
    if candidate not in existing_prefixes:
        return candidate
    for idx in range(5, len(seed)):
        root = (seed[idx - 4 : idx + 1]).ljust(5, "x")
        candidate = f"{root}-{date_part}-"
        if candidate not in existing_prefixes:
            return candidate
    fallback = re.sub(r"[^a-zA-Z0-9]+", "", task_id.lower())[:5].ljust(5, "x")
    return f"{fallback}-{date_part}-"


def load_outputs(path: Path, stack_name: str | None = None) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if stack_name and stack_name in payload:
        return payload[stack_name]
    if len(payload) == 1:
        return next(iter(payload.values()))
    raise KeyError(f"Could not resolve stack outputs from {path}")


def s3_get_json(s3, bucket: str, key: str) -> dict[str, Any] | None:
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    return json.loads(response["Body"].read())


def s3_put_json(s3, bucket: str, key: str, payload: dict[str, Any]) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )


def task_key(user_id: str, task_id: str) -> str:
    return f"users/{user_id}/tasks/{task_id}/task.json"


def task_snapshot_key(user_id: str, task_id: str, version: int) -> str:
    return f"users/{user_id}/tasks/{task_id}/snapshots/{version}.json"


def find_task_record(s3, metadata_bucket: str, task_id: str, source_user_id: str | None = None) -> tuple[str, dict[str, Any]]:
    if source_user_id:
        payload = s3_get_json(s3, metadata_bucket, task_key(source_user_id, task_id))
        if not isinstance(payload, dict):
            raise KeyError(f"Task {task_id} not found for user {source_user_id}")
        return source_user_id, payload

    paginator = s3.get_paginator("list_objects_v2")
    suffix = f"/tasks/{task_id}/task.json"
    matches: list[str] = []
    for page in paginator.paginate(Bucket=metadata_bucket, Prefix="users/"):
        for item in page.get("Contents") or []:
            key = str(item.get("Key") or "")
            if key.endswith(suffix):
                matches.append(key)
    if not matches:
        raise KeyError(f"Task {task_id} not found in {metadata_bucket}")
    if len(matches) > 1:
        raise RuntimeError(f"Task {task_id} matched multiple owners; rerun with --source-user-id")
    key = matches[0]
    user_id = key.split("/")[1]
    payload = s3_get_json(s3, metadata_bucket, key)
    if not isinstance(payload, dict):
        raise KeyError(f"Task payload missing for {task_id}")
    return user_id, payload


def list_existing_tasks(s3, metadata_bucket: str, user_id: str) -> list[dict[str, Any]]:
    prefix = f"users/{user_id}/tasks/"
    paginator = s3.get_paginator("list_objects_v2")
    tasks: list[dict[str, Any]] = []
    for page in paginator.paginate(Bucket=metadata_bucket, Prefix=prefix):
        for item in page.get("Contents") or []:
            key = str(item.get("Key") or "")
            if not key.endswith("/task.json"):
                continue
            payload = s3_get_json(s3, metadata_bucket, key)
            if isinstance(payload, dict) and not payload.get("deletedAt"):
                tasks.append(payload)
    return tasks


def resolve_user_id_for_email(cognito, user_pool_id: str, email: str) -> str:
    response = cognito.list_users(UserPoolId=user_pool_id, Filter=f'email = "{email}"', Limit=2)
    users = response.get("Users") or []
    if not users:
        raise KeyError(f"No Cognito user found for email {email} in pool {user_pool_id}")
    attributes = {item["Name"]: item["Value"] for item in users[0].get("Attributes") or []}
    sub = attributes.get("sub")
    if not sub:
        raise KeyError(f"User for {email} has no sub attribute")
    return sub


def replace_ids_and_collect_pairs(
    value: Any,
    *,
    source_user_id: str,
    source_task_id: str,
    target_user_id: str,
    target_task_id: str,
    source_asset_prefix: str,
    target_asset_prefix: str,
    source_meta_prefix: str,
    target_meta_prefix: str,
    asset_pairs: set[tuple[str, str]],
    metadata_pairs: set[tuple[str, str]],
    field_name: str | None = None,
) -> Any:
    if isinstance(value, dict):
        return {
            key: replace_ids_and_collect_pairs(
                item,
                source_user_id=source_user_id,
                source_task_id=source_task_id,
                target_user_id=target_user_id,
                target_task_id=target_task_id,
                source_asset_prefix=source_asset_prefix,
                target_asset_prefix=target_asset_prefix,
                source_meta_prefix=source_meta_prefix,
                target_meta_prefix=target_meta_prefix,
                asset_pairs=asset_pairs,
                metadata_pairs=metadata_pairs,
                field_name=key,
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            replace_ids_and_collect_pairs(
                item,
                source_user_id=source_user_id,
                source_task_id=source_task_id,
                target_user_id=target_user_id,
                target_task_id=target_task_id,
                source_asset_prefix=source_asset_prefix,
                target_asset_prefix=target_asset_prefix,
                source_meta_prefix=source_meta_prefix,
                target_meta_prefix=target_meta_prefix,
                asset_pairs=asset_pairs,
                metadata_pairs=metadata_pairs,
                field_name=field_name,
            )
            for item in value
        ]
    if isinstance(value, str):
        if field_name == "taskId" and value == source_task_id:
            return target_task_id
        if field_name == "userId" and value == source_user_id:
            return target_user_id
        if value.startswith(source_asset_prefix):
            destination = f"{target_asset_prefix}{value[len(source_asset_prefix):]}"
            asset_pairs.add((value, destination))
            return destination
        if value.startswith(source_meta_prefix):
            destination = f"{target_meta_prefix}{value[len(source_meta_prefix):]}"
            metadata_pairs.add((value, destination))
            return destination
    return value


def sanitize_task_for_clone(task: dict[str, Any], cloned_at: str, source_task_id: str, source_user_id: str) -> None:
    task.pop("deletedAt", None)
    task.pop("purgeJobId", None)
    task["status"] = "ready" if task.get("status") in {"created", "ingesting", "error", "deleting"} else task.get("status", "ready")
    task["clonedFrom"] = {
        "environment": "prod",
        "taskId": source_task_id,
        "userId": source_user_id,
        "clonedAt": cloned_at,
    }
    history = task.setdefault("history", [])
    history.append(
        {
            "at": cloned_at,
            "type": "cloned_from_prod",
            "sourceTaskId": source_task_id,
            "sourceUserId": source_user_id,
        }
    )

    for generation in (task.get("segmentGenerations") or {}).values():
        if not isinstance(generation, dict):
            continue
        if generation.get("status") in {"queued", "running"}:
            generation["status"] = "failed"
            generation["error"] = "Cloned from prod without live background job state"
            generation["updatedAt"] = cloned_at
            generation["finishedAt"] = cloned_at

    for report in task.get("customReports") or []:
        if not isinstance(report, dict):
            continue
        if report.get("status") in {"queued", "running"}:
            report["status"] = "failed"
            report["error"] = "Cloned from prod without live background job state"
            report["updatedAt"] = cloned_at

    for export in task.get("exports") or []:
        if not isinstance(export, dict):
            continue
        for key in ("topazUpscale", "motionSyncQc"):
            nested = export.get(key)
            if isinstance(nested, dict) and nested.get("status") in {"queued", "running"}:
                nested["status"] = "failed"
                nested["error"] = "Cloned from prod without live background job state"
                nested["updatedAt"] = cloned_at


def copy_s3_object(s3, bucket: str, source_key: str, destination_key: str) -> None:
    if source_key == destination_key:
        return
    s3.copy_object(
        Bucket=bucket,
        Key=destination_key,
        CopySource={"Bucket": bucket, "Key": source_key},
        ServerSideEncryption="AES256",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Clone a single prod task into the isolated dev environment.")
    parser.add_argument("--task-id", required=True, help="Prod task id to clone")
    parser.add_argument("--source-user-id", help="Optional prod owner id; otherwise search the prod metadata bucket")
    parser.add_argument("--target-user-id", help="Dev Cognito sub to own the cloned task")
    parser.add_argument("--target-email", help="Resolve the dev Cognito user by email instead of explicit sub")
    parser.add_argument("--prod-outputs", default="infra/cdk-outputs.prod.json")
    parser.add_argument("--dev-outputs", default="infra/cdk-outputs.dev.json")
    parser.add_argument("--prod-stack-name", default="AivfxStack")
    parser.add_argument("--dev-stack-name", default="AivfxDevStack")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.target_user_id and not args.target_email:
        parser.error("Provide either --target-user-id or --target-email")

    repo_root = Path(__file__).resolve().parents[1]
    prod_outputs = load_outputs(repo_root / args.prod_outputs, args.prod_stack_name)
    dev_outputs = load_outputs(repo_root / args.dev_outputs, args.dev_stack_name)

    s3 = boto3.client("s3", region_name="eu-west-2")
    cognito = boto3.client("cognito-idp", region_name="eu-west-2")

    target_user_id = args.target_user_id or resolve_user_id_for_email(
        cognito,
        str(dev_outputs["CognitoUserPoolId"]),
        str(args.target_email),
    )

    source_user_id, source_task = find_task_record(
        s3,
        str(prod_outputs["MetadataBucketName"]),
        args.task_id,
        args.source_user_id,
    )

    existing_tasks = list_existing_tasks(s3, str(dev_outputs["MetadataBucketName"]), target_user_id)
    existing_names = {str(item.get("name") or "").lower() for item in existing_tasks}
    existing_prefixes = {str(item.get("filePrefix") or "") for item in existing_tasks if item.get("filePrefix")}

    target_task_id = new_id("task")
    cloned_at = now_iso()
    target_name = unique_task_name(normalize_task_name(str(source_task.get("name") or "task")), existing_names)
    target_file_prefix = build_file_prefix(target_name, target_task_id, existing_prefixes)

    source_asset_prefix = f"users/{source_user_id}/tasks/{args.task_id}"
    target_asset_prefix = f"users/{target_user_id}/tasks/{target_task_id}"
    source_meta_prefix = f"users/{source_user_id}/tasks/{args.task_id}"
    target_meta_prefix = f"users/{target_user_id}/tasks/{target_task_id}"

    asset_pairs: set[tuple[str, str]] = set()
    metadata_pairs: set[tuple[str, str]] = set()

    cloned_task = replace_ids_and_collect_pairs(
        copy.deepcopy(source_task),
        source_user_id=source_user_id,
        source_task_id=args.task_id,
        target_user_id=target_user_id,
        target_task_id=target_task_id,
        source_asset_prefix=source_asset_prefix,
        target_asset_prefix=target_asset_prefix,
        source_meta_prefix=source_meta_prefix,
        target_meta_prefix=target_meta_prefix,
        asset_pairs=asset_pairs,
        metadata_pairs=metadata_pairs,
    )
    if not isinstance(cloned_task, dict):
        raise RuntimeError("Unexpected task payload shape")

    cloned_task["taskId"] = target_task_id
    cloned_task["userId"] = target_user_id
    cloned_task["name"] = target_name
    cloned_task["filePrefix"] = target_file_prefix
    cloned_task["createdAt"] = cloned_at
    cloned_task["updatedAt"] = cloned_at
    cloned_task["metaVersion"] = 1
    sanitize_task_for_clone(cloned_task, cloned_at, args.task_id, source_user_id)

    copied_reports = 0
    report_asset_pairs_before = len(asset_pairs)
    metadata_pairs = {
        pair for pair in metadata_pairs if pair[0].endswith(".json")
    }

    if not args.dry_run:
        for source_key, destination_key in sorted(metadata_pairs):
            payload = s3_get_json(s3, str(prod_outputs["MetadataBucketName"]), source_key)
            if not isinstance(payload, dict):
                continue
            rewritten = replace_ids_and_collect_pairs(
                payload,
                source_user_id=source_user_id,
                source_task_id=args.task_id,
                target_user_id=target_user_id,
                target_task_id=target_task_id,
                source_asset_prefix=source_asset_prefix,
                target_asset_prefix=target_asset_prefix,
                source_meta_prefix=source_meta_prefix,
                target_meta_prefix=target_meta_prefix,
                asset_pairs=asset_pairs,
                metadata_pairs=set(),
            )
            if isinstance(rewritten, dict):
                rewritten["taskId"] = target_task_id
            s3_put_json(s3, str(dev_outputs["MetadataBucketName"]), destination_key, rewritten)
            copied_reports += 1

        for source_key, destination_key in sorted(asset_pairs):
            copy_s3_object(s3, str(prod_outputs["AssetsBucketName"]), source_key, destination_key)

        s3_put_json(s3, str(dev_outputs["MetadataBucketName"]), task_key(target_user_id, target_task_id), cloned_task)
        s3_put_json(
            s3,
            str(dev_outputs["MetadataBucketName"]),
            task_snapshot_key(target_user_id, target_task_id, 1),
            cloned_task,
        )

    print(
        json.dumps(
            {
                "dryRun": args.dry_run,
                "sourceTaskId": args.task_id,
                "sourceUserId": source_user_id,
                "targetTaskId": target_task_id,
                "targetUserId": target_user_id,
                "targetName": target_name,
                "copiedAssetCount": len(asset_pairs),
                "copiedReportJsonCount": copied_reports if not args.dry_run else len(metadata_pairs),
                "additionalReportReferencedAssets": max(0, len(asset_pairs) - report_asset_pairs_before),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

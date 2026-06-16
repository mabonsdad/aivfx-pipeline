from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import uuid
from dataclasses import dataclass
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


def s3_get_json(s3, bucket: str, key: str) -> dict[str, Any] | list[Any] | None:
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    return json.loads(response["Body"].read())


def s3_put_json(s3, bucket: str, key: str, payload: Any) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )


def list_object_keys(s3, bucket: str, prefix: str) -> list[str]:
    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents") or []:
            key = str(item.get("Key") or "")
            if key:
                keys.append(key)
    return keys


def copy_s3_object(s3, source_bucket: str, source_key: str, target_bucket: str, target_key: str) -> None:
    if source_bucket == target_bucket and source_key == target_key:
        return
    s3.copy_object(
        Bucket=target_bucket,
        Key=target_key,
        CopySource={"Bucket": source_bucket, "Key": source_key},
        ServerSideEncryption="AES256",
    )


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


def list_tasks_for_user(s3, metadata_bucket: str, user_id: str) -> list[dict[str, Any]]:
    prefix = f"users/{user_id}/tasks/"
    tasks: list[dict[str, Any]] = []
    for key in list_object_keys(s3, metadata_bucket, prefix):
        if not key.endswith("/task.json"):
            continue
        payload = s3_get_json(s3, metadata_bucket, key)
        if isinstance(payload, dict) and not payload.get("deletedAt"):
            tasks.append(payload)
    tasks.sort(key=lambda item: str(item.get("updatedAt") or item.get("createdAt") or ""))
    return tasks


@dataclass(frozen=True)
class TaskPlan:
    source_task_id: str
    target_task_id: str
    source_meta_prefix: str
    target_meta_prefix: str
    source_asset_prefix: str
    target_asset_prefix: str
    source_name: str
    target_name: str
    source_file_prefix: str
    target_file_prefix: str


def replace_values(
    value: Any,
    *,
    source_user_id: str,
    target_user_id: str,
    task_id_map: dict[str, str],
    prefix_map: list[tuple[str, str]],
    field_name: str | None = None,
) -> Any:
    if isinstance(value, dict):
        return {
            key: replace_values(
                item,
                source_user_id=source_user_id,
                target_user_id=target_user_id,
                task_id_map=task_id_map,
                prefix_map=prefix_map,
                field_name=key,
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            replace_values(
                item,
                source_user_id=source_user_id,
                target_user_id=target_user_id,
                task_id_map=task_id_map,
                prefix_map=prefix_map,
                field_name=field_name,
            )
            for item in value
        ]
    if isinstance(value, str):
        if field_name == "userId" and value == source_user_id:
            return target_user_id
        if field_name == "taskId" and value in task_id_map:
            return task_id_map[value]
        for source_prefix, target_prefix in prefix_map:
            if value.startswith(source_prefix):
                return f"{target_prefix}{value[len(source_prefix):]}"
    return value


def sanitize_migrated_task(
    task: dict[str, Any],
    *,
    migrated_at: str,
    source_label: str,
    source_user_id: str,
    source_task_id: str,
) -> None:
    task.pop("deletedAt", None)
    task.pop("purgeJobId", None)
    task["migratedFrom"] = {
        "environment": source_label,
        "taskId": source_task_id,
        "userId": source_user_id,
        "migratedAt": migrated_at,
    }
    history = task.setdefault("history", [])
    if isinstance(history, list):
        history.append(
            {
                "at": migrated_at,
                "type": "migrated_user_data",
                "sourceEnvironment": source_label,
                "sourceTaskId": source_task_id,
                "sourceUserId": source_user_id,
            }
        )

    for generation in (task.get("segmentGenerations") or {}).values():
        if not isinstance(generation, dict):
            continue
        if generation.get("status") in {"queued", "running"}:
            generation["status"] = "failed"
            generation["error"] = "Migrated without live background job state"
            generation["updatedAt"] = migrated_at
            generation["finishedAt"] = migrated_at

    for report in task.get("customReports") or []:
        if not isinstance(report, dict):
            continue
        if report.get("status") in {"queued", "running"}:
            report["status"] = "failed"
            report["error"] = "Migrated without live background job state"
            report["updatedAt"] = migrated_at

    for export in task.get("exports") or []:
        if not isinstance(export, dict):
            continue
        for key in ("topazUpscale", "motionSyncQc"):
            nested = export.get(key)
            if isinstance(nested, dict) and nested.get("status") in {"queued", "running"}:
                nested["status"] = "failed"
                nested["error"] = "Migrated without live background job state"
                nested["updatedAt"] = migrated_at


def build_task_plans(
    source_tasks: list[dict[str, Any]],
    target_tasks: list[dict[str, Any]],
    *,
    source_user_id: str,
    target_user_id: str,
    task_id_mode: str,
) -> list[TaskPlan]:
    existing_target_ids = {str(task.get("taskId") or "") for task in target_tasks}
    existing_names = {str(task.get("name") or "").lower() for task in target_tasks}
    existing_prefixes = {str(task.get("filePrefix") or "") for task in target_tasks if task.get("filePrefix")}
    plans: list[TaskPlan] = []

    for task in source_tasks:
        source_task_id = str(task.get("taskId") or "")
        if not source_task_id:
            raise ValueError("Source task is missing taskId")
        source_name = str(task.get("name") or source_task_id)
        source_file_prefix = str(task.get("filePrefix") or "")

        if task_id_mode == "preserve":
            if source_task_id in existing_target_ids:
                raise ValueError(f"Target user already has task id {source_task_id}; rerun with --task-id-mode regenerate")
            target_task_id = source_task_id
            target_name = source_name
            target_file_prefix = source_file_prefix
        else:
            target_task_id = new_id("task")
            while target_task_id in existing_target_ids:
                target_task_id = new_id("task")
            normalized = normalize_task_name(source_name)
            target_name = unique_task_name(normalized, existing_names)
            target_file_prefix = build_file_prefix(target_name, target_task_id, existing_prefixes)

        existing_target_ids.add(target_task_id)
        existing_names.add(target_name.lower())
        if target_file_prefix:
            existing_prefixes.add(target_file_prefix)

        plans.append(
            TaskPlan(
                source_task_id=source_task_id,
                target_task_id=target_task_id,
                source_meta_prefix=f"users/{source_user_id}/tasks/{source_task_id}",
                target_meta_prefix=f"users/{target_user_id}/tasks/{target_task_id}",
                source_asset_prefix=f"users/{source_user_id}/tasks/{source_task_id}",
                target_asset_prefix=f"users/{target_user_id}/tasks/{target_task_id}",
                source_name=source_name,
                target_name=target_name,
                source_file_prefix=source_file_prefix,
                target_file_prefix=target_file_prefix,
            )
        )
    return plans


def migrate_task_records(
    *,
    s3,
    source_metadata_bucket: str,
    target_metadata_bucket: str,
    source_assets_bucket: str,
    target_assets_bucket: str,
    source_user_id: str,
    target_user_id: str,
    source_label: str,
    task_plans: list[TaskPlan],
    skip_task_assets: bool,
    dry_run: bool,
) -> dict[str, int]:
    migrated_at = now_iso()
    task_id_map = {plan.source_task_id: plan.target_task_id for plan in task_plans}
    prefix_map: list[tuple[str, str]] = []
    for plan in task_plans:
        prefix_map.append((plan.source_asset_prefix, plan.target_asset_prefix))
        prefix_map.append((plan.source_meta_prefix, plan.target_meta_prefix))

    counts = {"taskMetadataObjects": 0, "taskAssetObjects": 0}

    for plan in task_plans:
        source_meta_keys = list_object_keys(s3, source_metadata_bucket, f"{plan.source_meta_prefix}/")
        for source_key in source_meta_keys:
            counts["taskMetadataObjects"] += 1
            target_key = f"{plan.target_meta_prefix}{source_key[len(plan.source_meta_prefix):]}"
            if dry_run:
                continue
            if source_key.endswith(".json"):
                payload = s3_get_json(s3, source_metadata_bucket, source_key)
                rewritten = replace_values(
                    copy.deepcopy(payload),
                    source_user_id=source_user_id,
                    target_user_id=target_user_id,
                    task_id_map=task_id_map,
                    prefix_map=prefix_map,
                )
                if source_key.endswith("/task.json") and isinstance(rewritten, dict):
                    rewritten["taskId"] = plan.target_task_id
                    rewritten["userId"] = target_user_id
                    rewritten["name"] = plan.target_name
                    rewritten["filePrefix"] = plan.target_file_prefix
                    sanitize_migrated_task(
                        rewritten,
                        migrated_at=migrated_at,
                        source_label=source_label,
                        source_user_id=source_user_id,
                        source_task_id=plan.source_task_id,
                    )
                s3_put_json(s3, target_metadata_bucket, target_key, rewritten)
            else:
                copy_s3_object(s3, source_metadata_bucket, source_key, target_metadata_bucket, target_key)

        if not skip_task_assets:
            source_asset_keys = list_object_keys(s3, source_assets_bucket, f"{plan.source_asset_prefix}/")
            for source_key in source_asset_keys:
                counts["taskAssetObjects"] += 1
                if dry_run:
                    continue
                target_key = f"{plan.target_asset_prefix}{source_key[len(plan.source_asset_prefix):]}"
                copy_s3_object(s3, source_assets_bucket, source_key, target_assets_bucket, target_key)

    return counts


def migrate_api_data(
    *,
    s3,
    source_metadata_bucket: str,
    target_metadata_bucket: str,
    source_assets_bucket: str,
    target_assets_bucket: str,
    source_user_id: str,
    target_user_id: str,
    task_plans: list[TaskPlan],
    skip_api_asset_objects: bool,
    skip_api_upload_objects: bool,
    dry_run: bool,
) -> dict[str, int]:
    task_id_map = {plan.source_task_id: plan.target_task_id for plan in task_plans}
    prefix_map: list[tuple[str, str]] = [
        (f"users/{source_user_id}/api_requests", f"users/{target_user_id}/api_requests"),
        (f"users/{source_user_id}/api_uploads", f"users/{target_user_id}/api_uploads"),
    ]
    for plan in task_plans:
        prefix_map.append((plan.source_asset_prefix, plan.target_asset_prefix))
        prefix_map.append((plan.source_meta_prefix, plan.target_meta_prefix))

    counts = {"apiMetadataObjects": 0, "apiAssetObjects": 0, "apiUploadObjects": 0}

    source_request_keys = list_object_keys(s3, source_metadata_bucket, f"users/{source_user_id}/api_requests/")
    for source_key in source_request_keys:
        counts["apiMetadataObjects"] += 1
        target_key = source_key.replace(f"users/{source_user_id}/api_requests/", f"users/{target_user_id}/api_requests/", 1)
        if dry_run:
            continue
        if source_key.endswith(".json"):
            payload = s3_get_json(s3, source_metadata_bucket, source_key)
            rewritten = replace_values(
                copy.deepcopy(payload),
                source_user_id=source_user_id,
                target_user_id=target_user_id,
                task_id_map=task_id_map,
                prefix_map=prefix_map,
            )
            s3_put_json(s3, target_metadata_bucket, target_key, rewritten)
        else:
            copy_s3_object(s3, source_metadata_bucket, source_key, target_metadata_bucket, target_key)

    if not skip_api_asset_objects:
        source_request_asset_keys = list_object_keys(s3, source_assets_bucket, f"users/{source_user_id}/api_requests/")
        for source_key in source_request_asset_keys:
            counts["apiAssetObjects"] += 1
            if dry_run:
                continue
            target_key = source_key.replace(f"users/{source_user_id}/api_requests/", f"users/{target_user_id}/api_requests/", 1)
            copy_s3_object(s3, source_assets_bucket, source_key, target_assets_bucket, target_key)

    if not skip_api_upload_objects:
        source_upload_keys = list_object_keys(s3, source_assets_bucket, f"users/{source_user_id}/api_uploads/")
        for source_key in source_upload_keys:
            counts["apiUploadObjects"] += 1
            if dry_run:
                continue
            target_key = source_key.replace(f"users/{source_user_id}/api_uploads/", f"users/{target_user_id}/api_uploads/", 1)
            copy_s3_object(s3, source_assets_bucket, source_key, target_assets_bucket, target_key)

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate one user's AIVFX data between environments or buckets.")
    parser.add_argument("--source-user-id", help="Source Cognito sub")
    parser.add_argument("--source-email", help="Resolve source user by email in the source pool")
    parser.add_argument("--target-user-id", help="Target Cognito sub")
    parser.add_argument("--target-email", help="Resolve target user by email in the target pool")
    parser.add_argument("--source-outputs", default="infra/cdk-outputs.shared.json")
    parser.add_argument("--target-outputs", default="infra/cdk-outputs.prod.json")
    parser.add_argument("--source-stack-name", default=None)
    parser.add_argument("--target-stack-name", default=None)
    parser.add_argument("--source-label", default="source")
    parser.add_argument("--target-label", default="target")
    parser.add_argument("--task-id-mode", choices=("preserve", "regenerate"), default="preserve")
    parser.add_argument("--skip-api-data", action="store_true", help="Migrate tasks only")
    parser.add_argument("--skip-task-assets", action="store_true", help="Rewrite task metadata only")
    parser.add_argument("--skip-api-assets", action="store_true", help="Skip api_requests asset objects")
    parser.add_argument("--skip-api-uploads", action="store_true", help="Skip api_uploads asset objects")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.source_user_id and not args.source_email:
        parser.error("Provide either --source-user-id or --source-email")
    if not args.target_user_id and not args.target_email:
        parser.error("Provide either --target-user-id or --target-email")

    repo_root = Path(__file__).resolve().parents[1]
    source_outputs = load_outputs(repo_root / args.source_outputs, args.source_stack_name)
    target_outputs = load_outputs(repo_root / args.target_outputs, args.target_stack_name)

    s3 = boto3.client("s3", region_name="eu-west-2")
    cognito = boto3.client("cognito-idp", region_name="eu-west-2")

    source_user_id = args.source_user_id or resolve_user_id_for_email(
        cognito,
        str(source_outputs["CognitoUserPoolId"]),
        str(args.source_email),
    )
    target_user_id = args.target_user_id or resolve_user_id_for_email(
        cognito,
        str(target_outputs["CognitoUserPoolId"]),
        str(args.target_email),
    )

    source_tasks = list_tasks_for_user(s3, str(source_outputs["MetadataBucketName"]), source_user_id)
    target_tasks = list_tasks_for_user(s3, str(target_outputs["MetadataBucketName"]), target_user_id)
    task_plans = build_task_plans(
        source_tasks,
        target_tasks,
        source_user_id=source_user_id,
        target_user_id=target_user_id,
        task_id_mode=args.task_id_mode,
    )

    task_counts = migrate_task_records(
        s3=s3,
        source_metadata_bucket=str(source_outputs["MetadataBucketName"]),
        target_metadata_bucket=str(target_outputs["MetadataBucketName"]),
        source_assets_bucket=str(source_outputs["AssetsBucketName"]),
        target_assets_bucket=str(target_outputs["AssetsBucketName"]),
        source_user_id=source_user_id,
        target_user_id=target_user_id,
        source_label=args.source_label,
        task_plans=task_plans,
        skip_task_assets=args.skip_task_assets,
        dry_run=args.dry_run,
    )

    api_counts = {"apiMetadataObjects": 0, "apiAssetObjects": 0, "apiUploadObjects": 0}
    if not args.skip_api_data:
        api_counts = migrate_api_data(
            s3=s3,
            source_metadata_bucket=str(source_outputs["MetadataBucketName"]),
            target_metadata_bucket=str(target_outputs["MetadataBucketName"]),
            source_assets_bucket=str(source_outputs["AssetsBucketName"]),
            target_assets_bucket=str(target_outputs["AssetsBucketName"]),
            source_user_id=source_user_id,
            target_user_id=target_user_id,
            task_plans=task_plans,
            skip_api_asset_objects=args.skip_api_assets,
            skip_api_upload_objects=args.skip_api_uploads,
            dry_run=args.dry_run,
        )

    print(
        json.dumps(
            {
                "dryRun": args.dry_run,
                "source": {
                    "label": args.source_label,
                    "userId": source_user_id,
                    "metadataBucket": source_outputs["MetadataBucketName"],
                    "assetsBucket": source_outputs["AssetsBucketName"],
                    "userPoolId": source_outputs["CognitoUserPoolId"],
                },
                "target": {
                    "label": args.target_label,
                    "userId": target_user_id,
                    "metadataBucket": target_outputs["MetadataBucketName"],
                    "assetsBucket": target_outputs["AssetsBucketName"],
                    "userPoolId": target_outputs["CognitoUserPoolId"],
                },
                "taskIdMode": args.task_id_mode,
                "migratedTaskCount": len(task_plans),
                "taskPlans": [
                    {
                        "sourceTaskId": plan.source_task_id,
                        "targetTaskId": plan.target_task_id,
                        "sourceName": plan.source_name,
                        "targetName": plan.target_name,
                    }
                    for plan in task_plans
                ],
                **task_counts,
                **api_counts,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

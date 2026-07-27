#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from src.core.store import S3JsonStore  # noqa: E402

STACK_BY_ENV = {
    "dev": (ROOT / "infra" / "cdk-outputs.dev.json", "AivfxDevStack"),
    "prod": (ROOT / "infra" / "cdk-outputs.prod.json", "AivfxProdStack"),
    "shared": (ROOT / "infra" / "cdk-outputs.shared.json", "AivfxStack"),
}
PREVIZ_WORKFLOW_ID = "simple_generation_workflow"
BACKFILL_MARKER_KEY = "descriptionBackfillV1At"


def _load_outputs(path: Path, stack_name: str) -> dict:
    payload = json.loads(path.read_text())
    if stack_name in payload:
        return payload[stack_name]
    if len(payload) == 1:
        return next(iter(payload.values()))
    raise KeyError(f"Could not resolve stack outputs for {stack_name} from {path}")


def _backfill_task_description(task: dict) -> bool:
    if str(task.get("workflowId") or "").strip() != PREVIZ_WORKFLOW_ID:
        return False
    previz = task.get("previz") if isinstance(task.get("previz"), dict) else None
    if not isinstance(previz, dict):
        return False
    scene_prompt = str(previz.get("scenePrompt") or "").strip()
    if not scene_prompt:
        return False
    current_description = str(task.get("description") or "").strip()
    if current_description:
        return False
    task["description"] = scene_prompt
    migration = task.get("migrationFlags") if isinstance(task.get("migrationFlags"), dict) else {}
    migration[BACKFILL_MARKER_KEY] = True
    task["migrationFlags"] = migration
    return True


def _scan(env: str, dry_run: bool) -> dict:
    outputs_path, stack_name = STACK_BY_ENV[env]
    outputs = _load_outputs(outputs_path, stack_name)
    bucket = str(outputs.get("MetadataBucketName") or "").strip()
    if not bucket:
        raise KeyError(f"MetadataBucketName missing from {outputs_path}")
    store = S3JsonStore(bucket)
    tasks = store.list_all_tasks()
    updated = 0
    touched: list[dict] = []
    for task in tasks:
        if not isinstance(task, dict) or task.get("deletedAt"):
            continue
        if not _backfill_task_description(task):
            continue
        updated += 1
        touched.append(
            {
                "taskId": task.get("taskId"),
                "name": task.get("name"),
                "userId": task.get("userId"),
            }
        )
        if not dry_run:
            store.save_task(task)
    return {
        "env": env,
        "bucket": bucket,
        "dryRun": dry_run,
        "updatedTasks": updated,
        "touched": touched,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill task.description from legacy previz.scenePrompt.")
    parser.add_argument("--env", choices=("dev", "prod", "shared", "all"), default="dev")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    target_envs = [args.env] if args.env != "all" else ["dev", "prod", "shared"]
    for env in target_envs:
        print(json.dumps(_scan(env, dry_run=args.dry_run), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

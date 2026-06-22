#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from src.core.store import S3JsonStore  # noqa: E402

DEV_BUCKET = "aivfxdevstack-metadatabuckete6b09702-xoncwnqxnmyq"
PROD_BUCKET = "aivfxprodstack-metadatabuckete6b09702-vzucrbijg4m4"

TASK_WORKFLOW_MODE_MAP = {
    "source_video_flow": ("source", "start_video"),
    "source_video_start_end_workflow": ("source", "start_end"),
    "source_video_edit_workflow": ("source", "edit_video"),
    "character_animate_workflow": ("character", "pose_video"),
    "character_animate_audio_workflow": ("character", "audio_driven"),
}


def _normalize_task_generation_metadata(task: dict) -> tuple[bool, int]:
    workflow_id = str(task.get("workflowId") or "").strip()
    workflow_config = TASK_WORKFLOW_MODE_MAP.get(workflow_id)
    if not workflow_config:
        return False, 0
    if not task.get("migratedFrom"):
        return False, 0

    family, expected_mode = workflow_config
    generations = task.get("segmentGenerations")
    if not isinstance(generations, dict):
        return False, 0

    changed = False
    updated_generations = 0
    for generation in generations.values():
        if not isinstance(generation, dict):
            continue
        generation_changed = False

        origin = generation.get("origin")
        if not isinstance(origin, dict):
            origin = {}
            generation["origin"] = origin
            generation_changed = True
        if origin.get("workflowId") != workflow_id:
            origin["workflowId"] = workflow_id
            generation_changed = True
        if origin.get("creationMode") != expected_mode:
            origin["creationMode"] = expected_mode
            generation_changed = True

        generation_settings = generation.get("generationSettings")
        if not isinstance(generation_settings, dict):
            generation_settings = {}
            generation["generationSettings"] = generation_settings
            generation_changed = True
        if generation_settings.get("workflowId") != workflow_id:
            generation_settings["workflowId"] = workflow_id
            generation_changed = True

        if family == "source":
            if generation_settings.get("inputMode") != expected_mode:
                generation_settings["inputMode"] = expected_mode
                generation_changed = True
        else:
            if generation_settings.get("characterMode") != expected_mode:
                generation_settings["characterMode"] = expected_mode
                generation_changed = True
            character_animation = generation.get("characterAnimation")
            if not isinstance(character_animation, dict):
                character_animation = {}
                generation["characterAnimation"] = character_animation
                generation_changed = True
            if character_animation.get("workflowId") != workflow_id:
                character_animation["workflowId"] = workflow_id
                generation_changed = True
            if character_animation.get("mode") != expected_mode:
                character_animation["mode"] = expected_mode
                generation_changed = True

        if generation_changed:
            updated_generations += 1
            changed = True

    return changed, updated_generations


def _scan_and_repair(bucket: str, *, dry_run: bool) -> dict:
    store = S3JsonStore(bucket)
    tasks = store.list_all_tasks()
    updated_tasks = 0
    updated_generations = 0
    touched: list[dict] = []

    for task in tasks:
        if not isinstance(task, dict) or task.get("deletedAt"):
            continue
        changed, generation_count = _normalize_task_generation_metadata(task)
        if not changed:
            continue
        updated_tasks += 1
        updated_generations += generation_count
        touched.append(
            {
                "taskId": task.get("taskId"),
                "name": task.get("name"),
                "workflowId": task.get("workflowId"),
                "updatedGenerations": generation_count,
            }
        )
        if not dry_run:
            store.save_task(task)

    return {
        "bucket": bucket,
        "dryRun": dry_run,
        "updatedTasks": updated_tasks,
        "updatedGenerations": updated_generations,
        "touched": touched,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Repair migrated task workflow metadata after workflow split.")
    parser.add_argument("--env", choices=("dev", "prod", "both"), default="dev")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    env_buckets = []
    if args.env in {"dev", "both"}:
        env_buckets.append(("dev", DEV_BUCKET))
    if args.env in {"prod", "both"}:
        env_buckets.append(("prod", PROD_BUCKET))

    for env_name, bucket in env_buckets:
        summary = _scan_and_repair(bucket, dry_run=args.dry_run)
        print(json.dumps({"env": env_name, **summary}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

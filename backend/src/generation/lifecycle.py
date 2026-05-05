from __future__ import annotations

from typing import Any


def get_generation(task: dict[str, Any], generation_id: str) -> dict[str, Any] | None:
    generation = task.get("segmentGenerations", {}).get(generation_id)
    return generation if isinstance(generation, dict) else None


def get_segment(task: dict[str, Any], segment_id: str) -> dict[str, Any] | None:
    return next(
        (item for item in task.get("segments", []) if isinstance(item, dict) and item.get("segmentId") == segment_id),
        None,
    )


def generation_ready_for_post(generation: dict[str, Any]) -> bool:
    return str(generation.get("status") or "").lower() == "complete" and bool(generation.get("outputKey"))


def build_reconcile_generation_record(
    source_generation: dict[str, Any],
    *,
    result_generation_id: str,
    segment_id: str,
    source_generation_id: str,
    job_id: str,
    now_iso: str,
    trim_start_frames: int,
    trim_end_frames: int,
    playback_rate: float | None,
) -> dict[str, Any]:
    base_settings = source_generation.get("generationSettings") if isinstance(source_generation.get("generationSettings"), dict) else {}
    return {
        **source_generation,
        "genId": result_generation_id,
        "segmentId": segment_id,
        "status": "queued",
        "outputKey": None,
        "jobId": job_id,
        "error": None,
        "queuedAt": now_iso,
        "createdAt": now_iso,
        "updatedAt": now_iso,
        "startedAt": None,
        "finishedAt": None,
        "processingDurationSec": None,
        "downloadUrl": None,
        "inputMediaUrl": None,
        "mergeAlignmentSuggestion": None,
        "timingReconcile": None,
        "alignment": None,
        "sourceFrameOffset": None,
        "cleanupTrackId": None,
        "derivedFromGenerationId": source_generation_id,
        "generationSettings": {
            **base_settings,
            "workflow": "timing_reconcile",
            "derivedFromGenerationId": source_generation_id,
            "reconcileTiming": {
                "sourceGenerationId": source_generation_id,
                "trimStartFrames": int(trim_start_frames),
                "trimEndFrames": int(trim_end_frames),
                "playbackRate": playback_rate,
            },
        },
    }


def build_reconcile_state(
    *,
    job_id: str,
    result_generation_id: str,
    now_iso: str,
    trim_start_frames: int,
    trim_end_frames: int,
    playback_rate: float | None,
) -> dict[str, Any]:
    return {
        "status": "queued",
        "jobId": job_id,
        "resultGenId": result_generation_id,
        "updatedAt": now_iso,
        "adjustments": {
            "trimStartFrames": int(trim_start_frames),
            "trimEndFrames": int(trim_end_frames),
            "playbackRate": playback_rate,
        },
    }

from __future__ import annotations

from typing import Any

DEFAULT_TASK_WORKFLOW_ID = "source_video_flow"
SOURCE_VIDEO_WORKFLOW_IDS = {
    "source_video_flow",
    "source_video_start_end_workflow",
    "source_video_edit_workflow",
}
CHARACTER_ANIMATE_WORKFLOW_IDS = {
    "character_animate_workflow",
    "character_animate_audio_workflow",
}
TASK_WORKFLOW_IDS = {
    *SOURCE_VIDEO_WORKFLOW_IDS,
    *CHARACTER_ANIMATE_WORKFLOW_IDS,
    "simple_generation_workflow",
    "canvas_workflow",
}
START_END_MODES = frozenset({"kling_start_end", "veo_start_end", "ltx23_i2v_start_end"})
START_ONLY_MODES = frozenset({"kling_start_only", "veo_start_only", "runway_i2v", "sora_i2v", "happy_horse_i2v", "wan_a14b_i2v"})


def is_task_workflow_id(value: str | None) -> bool:
    return str(value or "").strip() in TASK_WORKFLOW_IDS


def normalize_task_workflow_id(value: str | None) -> str:
    workflow_id = str(value or "").strip()
    return workflow_id if workflow_id in TASK_WORKFLOW_IDS else DEFAULT_TASK_WORKFLOW_ID


def is_source_video_workflow_id(value: str | None) -> bool:
    return normalize_task_workflow_id(value) in SOURCE_VIDEO_WORKFLOW_IDS


def is_character_animate_workflow_id(value: str | None) -> bool:
    return normalize_task_workflow_id(value) in CHARACTER_ANIMATE_WORKFLOW_IDS


def is_previz_workflow_id(value: str | None) -> bool:
    return normalize_task_workflow_id(value) == "simple_generation_workflow"


def workflow_for_source_video_mode(mode: str | None) -> str:
    mode_value = str(mode or "").strip()
    if mode_value == "start_end":
        return "source_video_start_end_workflow"
    if mode_value == "edit_video":
        return "source_video_edit_workflow"
    return "source_video_flow"


def workflow_for_character_mode(mode: str | None) -> str:
    return "character_animate_audio_workflow" if str(mode or "").strip() == "audio_driven" else "character_animate_workflow"


def infer_source_generation_input_mode(task: dict[str, Any], generation: dict[str, Any]) -> str | None:
    generation_settings = generation.get("generationSettings") if isinstance(generation.get("generationSettings"), dict) else {}
    explicit_input_mode = str(generation_settings.get("inputMode") or "").strip()
    if explicit_input_mode in {"start_video", "start_end", "start_only", "edit_video"}:
        return explicit_input_mode
    selected_reference_ids = generation_settings.get("selectedReferenceIds")
    if isinstance(selected_reference_ids, list) and selected_reference_ids:
        return "edit_video"
    prompt = str((generation.get("luma") or {}).get("prompt") or "").lower()
    audio_reference_id = str(generation_settings.get("audioReferenceId") or "").strip()
    if audio_reference_id or "@image" in prompt or "@audio" in prompt:
        return "edit_video"
    mode = str((generation.get("luma") or {}).get("mode") or "").strip()
    if mode in START_END_MODES:
        return "start_end"
    if mode in START_ONLY_MODES:
        return "start_only"
    if mode in {"happy_horse_video_edit", "runway_aleph_v2v", "kling_v3_omni_video_edit", "seedance_reference_to_video", "flex_1"}:
        has_edit_references = isinstance(task.get("editVideoReferences"), list) and len(task.get("editVideoReferences")) > 0
        if mode == "seedance_reference_to_video" and "@video1" in prompt and has_edit_references:
            return "edit_video"
        return "start_video"
    if str((generation.get("luma") or {}).get("model") or "").strip() == "wan2.7-videoedit":
        return "edit_video"
    return None


def infer_task_workflow_id(task: dict[str, Any]) -> str:
    current = str(task.get("workflowId") or "").strip()
    if current in TASK_WORKFLOW_IDS and current not in {"source_video_flow", "character_animate_workflow"}:
        return current
    if current == "simple_generation_workflow":
        return current
    if current == "canvas_workflow":
        return current

    source_media_kind = str(task.get("sourceMedia", {}).get("kind") or task.get("video", {}).get("editSource", {}).get("mediaType") or "").strip()
    generations = task.get("segmentGenerations") if isinstance(task.get("segmentGenerations"), dict) else {}
    newest_generations = sorted(
        (generation for generation in generations.values() if isinstance(generation, dict)),
        key=lambda generation: str(
            generation.get("finishedAt")
            or generation.get("updatedAt")
            or generation.get("createdAt")
            or ""
        ),
        reverse=True,
    )

    if current == "character_animate_workflow" or source_media_kind == "audio":
        for generation in newest_generations:
            mode = str(
                generation.get("characterAnimation", {}).get("mode")
                or generation.get("generationSettings", {}).get("characterMode")
                or ""
            ).strip()
            if mode:
                return workflow_for_character_mode(mode)
        return workflow_for_character_mode("audio_driven" if source_media_kind == "audio" else "pose_video")

    if current == "source_video_flow" or not current:
        for generation in newest_generations:
            mode = infer_source_generation_input_mode(task, generation)
            if mode:
                return workflow_for_source_video_mode(mode)
        if isinstance(task.get("generationAudioReference"), dict):
            return "source_video_edit_workflow"
        return "source_video_flow"

    return normalize_task_workflow_id(current)

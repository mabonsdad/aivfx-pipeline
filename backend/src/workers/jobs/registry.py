from __future__ import annotations

from typing import Any, Callable

from src.workers.dispatch import JobHandler


def build_job_handlers(
    *,
    handle_ingest_fn: Callable[..., Any],
    handle_full_edit_fn: Callable[..., Any],
    handle_patch_edit_fn: Callable[..., Any],
    handle_api_image_edit_full_fn: Callable[..., Any],
    handle_api_image_edit_patch_fn: Callable[..., Any],
    handle_api_video_generate_reference_fn: Callable[..., Any],
    handle_quality_match_apply_fn: Callable[..., Any],
    handle_quality_match_sam_fn: Callable[..., Any],
    handle_segment_generate_fn: Callable[..., Any],
    handle_chunked_generation_finalize_fn: Callable[..., Any],
    handle_merge_alignment_suggestion_fn: Callable[..., Any],
    handle_generation_reconcile_timing_fn: Callable[..., Any],
    handle_merge_fn: Callable[..., Any],
    handle_qc_report_build_fn: Callable[..., Any],
    handle_motion_sync_qc_fn: Callable[..., Any],
    handle_video_cleanup_init_fn: Callable[..., Any],
    handle_video_cleanup_track_fn: Callable[..., Any],
    handle_video_cleanup_retrack_window_fn: Callable[..., Any],
    handle_video_cleanup_preview_fn: Callable[..., Any],
    handle_video_cleanup_apply_fn: Callable[..., Any],
) -> dict[str, JobHandler]:
    return {
        "ingest_video": lambda **kwargs: handle_ingest_fn(**kwargs),
        "edit_full": lambda **kwargs: handle_full_edit_fn(**kwargs),
        "edit_patch": lambda **kwargs: handle_patch_edit_fn(**kwargs),
        "api_image_edit_full": lambda **kwargs: handle_api_image_edit_full_fn(
            job=kwargs["job"],
            store=kwargs["store"],
            asset_store=kwargs["asset_store"],
            settings=kwargs["settings"],
        ),
        "api_image_edit_patch": lambda **kwargs: handle_api_image_edit_patch_fn(
            job=kwargs["job"],
            store=kwargs["store"],
            asset_store=kwargs["asset_store"],
            settings=kwargs["settings"],
        ),
        "api_video_generate_reference": lambda **kwargs: handle_api_video_generate_reference_fn(
            job=kwargs["job"],
            store=kwargs["store"],
            asset_store=kwargs["asset_store"],
            settings=kwargs["settings"],
        ),
        "quality_match_apply": lambda **kwargs: handle_quality_match_apply_fn(**kwargs),
        "quality_match_sam": lambda **kwargs: handle_quality_match_sam_fn(**kwargs),
        "segment_generate": lambda **kwargs: handle_segment_generate_fn(**kwargs),
        "chunked_generation_finalize": lambda **kwargs: handle_chunked_generation_finalize_fn(**kwargs),
        "merge_alignment_suggestion": lambda **kwargs: handle_merge_alignment_suggestion_fn(**kwargs),
        "generation_reconcile_timing": lambda **kwargs: handle_generation_reconcile_timing_fn(**kwargs),
        "merge_export": lambda **kwargs: handle_merge_fn(**kwargs),
        "qc_report_build": lambda **kwargs: handle_qc_report_build_fn(**kwargs),
        "motion_sync_qc": lambda **kwargs: handle_motion_sync_qc_fn(**kwargs),
        "video_cleanup_init": lambda **kwargs: handle_video_cleanup_init_fn(**kwargs),
        "video_cleanup_track": lambda **kwargs: handle_video_cleanup_track_fn(**kwargs),
        "video_cleanup_retrack_window": lambda **kwargs: handle_video_cleanup_retrack_window_fn(**kwargs),
        "video_cleanup_preview": lambda **kwargs: handle_video_cleanup_preview_fn(**kwargs),
        "video_cleanup_apply": lambda **kwargs: handle_video_cleanup_apply_fn(**kwargs),
    }

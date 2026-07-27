from __future__ import annotations

from src.workers.jobs.failure import handle_job_failure
from src.workers.jobs.registry import build_job_handlers


class _Store:
    def __init__(self) -> None:
        self.task: dict | None = None
        self.api_request: dict | None = None

    def load_api_request(self, _user_id: str, _request_id: str):
        return self.api_request

    def save_api_request(self, request: dict):
        self.api_request = request

    def load_task(self, _user_id: str, _task_id: str):
        return self.task

    def save_task(self, task: dict, **_kwargs):
        self.task = task
        return task


def test_build_job_handlers_routes_api_handler_inputs() -> None:
    seen: dict[str, dict] = {}

    def _capture(name: str):
        def _fn(**kwargs):
            seen[name] = kwargs
            return name

        return _fn

    handlers = build_job_handlers(
        handle_ingest_fn=_capture("ingest"),
        handle_bind_source_media_fn=_capture("bind_source_media"),
        handle_full_edit_fn=_capture("full"),
        handle_patch_edit_fn=_capture("patch"),
        handle_api_image_edit_full_fn=_capture("api_full"),
        handle_api_image_edit_patch_fn=_capture("api_patch"),
        handle_canvas_image_generate_fn=_capture("canvas_image_generate"),
        handle_api_video_generate_reference_fn=_capture("api_video"),
        handle_edit_video_reference_generate_fn=_capture("edit_video_reference_generate"),
        handle_previz_generate_fn=_capture("previz_generate"),
        handle_pdf_ingest_fn=_capture("pdf_ingest"),
        handle_quality_match_apply_fn=_capture("qm_apply"),
        handle_quality_match_sam_fn=_capture("qm_sam"),
        handle_segment_generate_fn=_capture("segment"),
        handle_chunked_generation_finalize_fn=_capture("chunk_final"),
        handle_merge_alignment_suggestion_fn=_capture("merge_align"),
        handle_generation_reconcile_timing_fn=_capture("reconcile"),
        handle_merge_fn=_capture("merge"),
        handle_export_topaz_upscale_fn=_capture("topaz"),
        handle_qc_report_build_fn=_capture("qc"),
        handle_motion_sync_qc_fn=_capture("motion"),
        handle_task_purge_fn=_capture("task_purge"),
        handle_video_cleanup_init_fn=_capture("cleanup_init"),
        handle_video_cleanup_track_fn=_capture("cleanup_track"),
        handle_video_cleanup_retrack_window_fn=_capture("cleanup_retrack"),
        handle_video_cleanup_preview_fn=_capture("cleanup_preview"),
        handle_video_cleanup_apply_fn=_capture("cleanup_apply"),
    )
    result = handlers["api_image_edit_full"](job={"jobId": "job_1"}, store="store", asset_store="asset", settings="settings")

    assert result == "api_full"
    assert seen["api_full"] == {
        "job": {"jobId": "job_1"},
        "store": "store",
        "asset_store": "asset",
        "settings": "settings",
    }


def test_handle_job_failure_updates_generation_alignment_state() -> None:
    store = _Store()
    store.task = {
        "segmentGenerations": {
            "gen_1": {"genId": "gen_1"},
        }
    }
    handled = handle_job_failure(
        job_type="merge_alignment_suggestion",
        job_id="job_1",
        task_id="task_1",
        user_id="user_1",
        job={"payload": {"genId": "gen_1"}},
        store=store,
        task=store.task,
        error=RuntimeError("boom"),
        now_iso_fn=lambda: "2026-05-05T15:00:00Z",
        get_cleanup_track_fn=lambda _task, _track_id: None,
        find_chunked_generation_run_fn=lambda _task, _run_id: None,
        mark_chunked_generation_run_failed_fn=lambda **_kwargs: None,
    )

    assert handled is True
    generation = (store.task or {}).get("segmentGenerations", {}).get("gen_1", {})
    suggestion = generation.get("mergeAlignmentSuggestion")
    assert isinstance(suggestion, dict)
    assert suggestion["status"] == "failed"
    assert suggestion["jobId"] == "job_1"


def test_handle_job_failure_updates_topaz_state() -> None:
    store = _Store()
    store.task = {
        "exports": [
            {
                "exportId": "exp_src",
                "outputKey": "users/u/tasks/t/exports/out.mp4",
            }
        ]
    }
    handled = handle_job_failure(
        job_type="export_topaz_upscale",
        job_id="job_topaz",
        task_id="task_1",
        user_id="user_1",
        job={"payload": {"sourceExportId": "exp_src", "resultExportId": "exp_new"}},
        store=store,
        task=store.task,
        error=RuntimeError("fal unavailable"),
        now_iso_fn=lambda: "2026-05-06T12:00:00Z",
        get_cleanup_track_fn=lambda _task, _track_id: None,
        find_chunked_generation_run_fn=lambda _task, _run_id: None,
        mark_chunked_generation_run_failed_fn=lambda **_kwargs: None,
    )

    assert handled is True
    exports = (store.task or {}).get("exports", [])
    assert isinstance(exports, list) and exports
    topaz_state = exports[0].get("topazUpscale")
    assert isinstance(topaz_state, dict)
    assert topaz_state["status"] == "failed"
    assert topaz_state["jobId"] == "job_topaz"

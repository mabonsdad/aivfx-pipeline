from __future__ import annotations

import re
from pathlib import Path

from src.contracts.api import (
    ASSET_DELETE_TYPE_IDS,
    ASSET_UPLOAD_TYPE_IDS,
    CUSTOM_REPORT_OUTPUT_ASSET_TYPE_IDS,
    CUSTOM_REPORT_TYPE_IDS,
    JOB_STATUS_IDS,
    MANUAL_REFINE_EXPORT_FORMAT_IDS,
    QC_EDGE_BIAS_IDS,
    QC_EDGE_SUPPRESSION_IDS,
    QC_SAM_PROMPT_TYPE_IDS,
    SEGMENT_CROP_ASPECT_IDS,
    TASK_STATUS_IDS,
)
from src.contracts.video import FULL_EDIT_MODEL_IDS, PATCH_EDIT_MODEL_IDS, VIDEO_MODE_IDS, VIDEO_MODEL_IDS


def _parse_ts_const(ts_source: str, name: str) -> tuple[str, ...]:
    pattern = rf"export const {name} = \[(.*?)\] as const;"
    match = re.search(pattern, ts_source, re.DOTALL)
    if not match:
        raise AssertionError(f"Could not find TS const: {name}")
    values = re.findall(r'"([^"]+)"', match.group(1))
    return tuple(values)


def test_generated_frontend_contract_matches_backend_contract() -> None:
    root = Path(__file__).resolve().parents[2]
    ts_path = root / "frontend" / "src" / "lib" / "generated" / "videoContracts.ts"
    source = ts_path.read_text(encoding="utf-8")

    assert _parse_ts_const(source, "VIDEO_MODEL_IDS") == VIDEO_MODEL_IDS
    assert _parse_ts_const(source, "VIDEO_MODE_IDS") == VIDEO_MODE_IDS
    assert _parse_ts_const(source, "FULL_EDIT_MODEL_IDS") == FULL_EDIT_MODEL_IDS
    assert _parse_ts_const(source, "PATCH_EDIT_MODEL_IDS") == PATCH_EDIT_MODEL_IDS


def test_generated_frontend_api_contract_matches_backend_contract() -> None:
    root = Path(__file__).resolve().parents[2]
    ts_path = root / "frontend" / "src" / "lib" / "generated" / "apiContracts.ts"
    source = ts_path.read_text(encoding="utf-8")

    assert _parse_ts_const(source, "TASK_STATUS_IDS") == TASK_STATUS_IDS
    assert _parse_ts_const(source, "JOB_STATUS_IDS") == JOB_STATUS_IDS
    assert _parse_ts_const(source, "ASSET_UPLOAD_TYPE_IDS") == ASSET_UPLOAD_TYPE_IDS
    assert _parse_ts_const(source, "SEGMENT_CROP_ASPECT_IDS") == SEGMENT_CROP_ASPECT_IDS
    assert _parse_ts_const(source, "ASSET_DELETE_TYPE_IDS") == ASSET_DELETE_TYPE_IDS
    assert _parse_ts_const(source, "CUSTOM_REPORT_OUTPUT_ASSET_TYPE_IDS") == CUSTOM_REPORT_OUTPUT_ASSET_TYPE_IDS
    assert _parse_ts_const(source, "CUSTOM_REPORT_TYPE_IDS") == CUSTOM_REPORT_TYPE_IDS
    assert _parse_ts_const(source, "MANUAL_REFINE_EXPORT_FORMAT_IDS") == MANUAL_REFINE_EXPORT_FORMAT_IDS
    assert _parse_ts_const(source, "QC_EDGE_SUPPRESSION_IDS") == QC_EDGE_SUPPRESSION_IDS
    assert _parse_ts_const(source, "QC_SAM_PROMPT_TYPE_IDS") == QC_SAM_PROMPT_TYPE_IDS
    assert _parse_ts_const(source, "QC_EDGE_BIAS_IDS") == QC_EDGE_BIAS_IDS

    for type_name in (
        "SegmentGeneratePayload",
        "ChunkedSegmentGeneratePayload",
        "ApiReferenceVideoGeneratePayload",
        "CustomReportCreatePayload",
    ):
        assert f"export type {type_name} =" in source

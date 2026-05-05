from __future__ import annotations

import re
from pathlib import Path

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

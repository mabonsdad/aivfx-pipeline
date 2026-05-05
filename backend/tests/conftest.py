from __future__ import annotations

import os
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = ROOT / "backend" / "src"
src_pkg = types.ModuleType("src")
src_pkg.__path__ = [str(SRC_ROOT)]  # type: ignore[attr-defined]
sys.modules.setdefault("src", src_pkg)

# Minimal env required by src.core.config.load_settings() at import time.
os.environ.setdefault("ASSETS_BUCKET", "test-assets")
os.environ.setdefault("METADATA_BUCKET", "test-metadata")
os.environ.setdefault("JOBS_QUEUE_URL", "https://example.invalid/queue")
os.environ.setdefault("SECRETS_ARN", "arn:aws:secretsmanager:eu-west-2:111111111111:secret:test")

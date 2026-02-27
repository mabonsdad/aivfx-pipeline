from __future__ import annotations

import hashlib
import uuid


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def deterministic_frame_id(task_id: str, edit_source_key: str, frame_index: int) -> str:
    digest = hashlib.sha256(f"{task_id}:{edit_source_key}:{frame_index}".encode("utf-8")).hexdigest()
    return f"frame_{digest[:20]}"


def prompt_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()

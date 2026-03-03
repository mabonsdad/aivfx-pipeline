from __future__ import annotations

import hashlib
import mimetypes
import re
from dataclasses import dataclass
from typing import Any
from pathlib import Path

import boto3
import requests
from botocore.config import Config


@dataclass(frozen=True)
class AssetPaths:
    user_id: str
    task_id: str
    file_prefix: str = ""

    def _filename(self, stem: str, ext: str) -> str:
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.file_prefix}{stem}{safe_ext}"

    def task_prefix(self) -> str:
        return f"users/{self.user_id}/tasks/{self.task_id}"

    def original_video(self, filename: str) -> str:
        ext = Path(filename).suffix or ".mp4"
        return f"{self.task_prefix()}/original/{self._filename('orig', ext)}"

    def edit_source(self) -> str:
        return f"{self.task_prefix()}/edit_source/{self._filename('editsource', '.mp4')}"

    def preview_source(self) -> str:
        return f"{self.task_prefix()}/preview/{self._filename('preview', '.mp4')}"

    def thumbs_prefix(self) -> str:
        return f"{self.task_prefix()}/thumbs"

    def frame_capture(self, frame_id: str) -> str:
        short_frame = re.sub(r"[^a-zA-Z0-9]+", "", frame_id)[-8:]
        return f"{self.task_prefix()}/frames/{frame_id}/{self._filename(f'capframe{short_frame}', '.png')}"

    def frame_variant(self, frame_id: str, variant_id: str) -> str:
        short_frame = re.sub(r"[^a-zA-Z0-9]+", "", frame_id)[-6:]
        short_var = re.sub(r"[^a-zA-Z0-9]+", "", variant_id)[-6:]
        return f"{self.task_prefix()}/frames/{frame_id}/variants/{self._filename(f'frame{short_frame}_edit{short_var}', '.png')}"

    def frame_patch(self, frame_id: str, variant_id: str) -> str:
        short_var = re.sub(r"[^a-zA-Z0-9]+", "", variant_id)[-8:]
        return f"{self.task_prefix()}/frames/{frame_id}/patches/{self._filename(f'patch{short_var}', '.png')}"

    def frame_mask(self, frame_id: str, variant_id: str) -> str:
        short_var = re.sub(r"[^a-zA-Z0-9]+", "", variant_id)[-8:]
        return f"{self.task_prefix()}/frames/{frame_id}/masks/{self._filename(f'mask{short_var}', '.png')}"

    def frame_reference(self, frame_id: str, reference_id: str, filename: str) -> str:
        short_ref = re.sub(r"[^a-zA-Z0-9]+", "", reference_id)[-8:]
        ext = Path(filename).suffix or ".png"
        return f"{self.task_prefix()}/frames/{frame_id}/references/{self._filename(f'ref{short_ref}', ext)}"

    def segment_original(self, segment_id: str) -> str:
        short_seg = re.sub(r"[^a-zA-Z0-9]+", "", segment_id)[-8:]
        return f"{self.task_prefix()}/segments/{segment_id}/{self._filename(f'seg{short_seg}_orig', '.mp4')}"

    def segment_generated(self, segment_id: str, generation_id: str) -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        return f"{self.task_prefix()}/segments/{segment_id}/generated/{self._filename(f'output{short_gen}', '.mp4')}"

    def segment_provider_input(self, segment_id: str, generation_id: str, provider: str) -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        safe_provider = re.sub(r"[^a-zA-Z0-9]+", "", provider.lower())[:12] or "provider"
        return f"{self.task_prefix()}/segments/{segment_id}/inputs/{self._filename(f'{safe_provider}{short_gen}_input', '.mp4')}"

    def segment_provider_first_frame(self, segment_id: str, generation_id: str, provider: str) -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        safe_provider = re.sub(r"[^a-zA-Z0-9]+", "", provider.lower())[:12] or "provider"
        return f"{self.task_prefix()}/segments/{segment_id}/inputs/{self._filename(f'{safe_provider}{short_gen}_first', '.jpg')}"

    def export_output(self, export_id: str) -> str:
        short_export = re.sub(r"[^a-zA-Z0-9]+", "", export_id)[-8:]
        return f"{self.task_prefix()}/exports/{self._filename(f'output{short_export}', '.mp4')}"


class AssetStore:
    def __init__(self, assets_bucket: str, aws_region: str):
        self.assets_bucket = assets_bucket
        self.s3 = boto3.client(
            "s3",
            region_name=aws_region,
            config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
        )

    def presign_put(self, key: str, *, expires: int = 900, content_type: str | None = None) -> str:
        # Keep browser uploads CORS-friendly by signing only bucket/key.
        # Bucket-level default encryption handles SSE at rest.
        params: dict[str, Any] = {
            "Bucket": self.assets_bucket,
            "Key": key,
        }
        return self.s3.generate_presigned_url(
            ClientMethod="put_object",
            Params=params,
            ExpiresIn=expires,
        )

    def presign_get(self, key: str, *, expires: int = 900) -> str:
        return self.s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": self.assets_bucket, "Key": key},
            ExpiresIn=expires,
        )

    def head_object(self, key: str) -> dict[str, Any]:
        return self.s3.head_object(Bucket=self.assets_bucket, Key=key)

    def put_bytes(self, key: str, payload: bytes, *, content_type: str | None = None) -> None:
        if not content_type:
            content_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
        self.s3.put_object(
            Bucket=self.assets_bucket,
            Key=key,
            Body=payload,
            ContentType=content_type,
            ServerSideEncryption="AES256",
        )

    def download_url_to_s3(self, source_url: str, target_key: str, *, timeout: int = 120) -> None:
        with requests.get(source_url, timeout=timeout, stream=True) as response:
            response.raise_for_status()
            self.s3.upload_fileobj(
                response.raw,
                self.assets_bucket,
                target_key,
                ExtraArgs={"ServerSideEncryption": "AES256", "ContentType": response.headers.get("Content-Type", "application/octet-stream")},
            )

    def read_bytes(self, key: str) -> bytes:
        return self.s3.get_object(Bucket=self.assets_bucket, Key=key)["Body"].read()

    def delete_object(self, key: str) -> None:
        self.s3.delete_object(Bucket=self.assets_bucket, Key=key)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

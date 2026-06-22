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

    def audio_edit_source(self) -> str:
        return f"{self.task_prefix()}/edit_source/{self._filename('editsource', '.wav')}"

    def audio_preview_source(self) -> str:
        return f"{self.task_prefix()}/preview/{self._filename('preview', '.m4a')}"

    def audio_waveform(self) -> str:
        return f"{self.task_prefix()}/preview/{self._filename('waveform', '.png')}"

    def thumbs_prefix(self) -> str:
        return f"{self.task_prefix()}/thumbs"

    def frame_capture(self, frame_id: str) -> str:
        short_frame = re.sub(r"[^a-zA-Z0-9]+", "", frame_id)[-8:]
        return f"{self.task_prefix()}/frames/{frame_id}/{self._filename(f'capframe{short_frame}', '.png')}"

    def frame_variant(self, frame_id: str, variant_id: str) -> str:
        short_frame = re.sub(r"[^a-zA-Z0-9]+", "", frame_id)[-6:]
        short_var = re.sub(r"[^a-zA-Z0-9]+", "", variant_id)[-12:]
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

    def edit_video_reference(self, reference_id: str, filename: str) -> str:
        short_ref = re.sub(r"[^a-zA-Z0-9]+", "", reference_id)[-8:]
        ext = Path(filename).suffix or ".png"
        return f"{self.task_prefix()}/edit_video/references/{self._filename(f'ref{short_ref}', ext)}"

    def generation_audio_reference_original(self, reference_id: str, filename: str) -> str:
        short_ref = re.sub(r"[^a-zA-Z0-9]+", "", reference_id)[-8:]
        ext = Path(filename).suffix or ".wav"
        return f"{self.task_prefix()}/generation_audio/{self._filename(f'audio{short_ref}_orig', ext)}"

    def generation_audio_reference_edit_source(self, reference_id: str) -> str:
        short_ref = re.sub(r"[^a-zA-Z0-9]+", "", reference_id)[-8:]
        return f"{self.task_prefix()}/generation_audio/{self._filename(f'audio{short_ref}_edit', '.wav')}"

    def generation_audio_reference_preview(self, reference_id: str) -> str:
        short_ref = re.sub(r"[^a-zA-Z0-9]+", "", reference_id)[-8:]
        return f"{self.task_prefix()}/generation_audio/{self._filename(f'audio{short_ref}_preview', '.m4a')}"

    def generation_audio_reference_waveform(self, reference_id: str) -> str:
        short_ref = re.sub(r"[^a-zA-Z0-9]+", "", reference_id)[-8:]
        return f"{self.task_prefix()}/generation_audio/{self._filename(f'audio{short_ref}_waveform', '.png')}"

    def external_qc_original(self, pair_id: str, filename: str) -> str:
        ext = Path(filename).suffix or ".png"
        return f"{self.task_prefix()}/external_qc/{pair_id}/{self._filename('original', ext)}"

    def external_qc_edited(self, pair_id: str, filename: str) -> str:
        ext = Path(filename).suffix or ".png"
        return f"{self.task_prefix()}/external_qc/{pair_id}/{self._filename('edited', ext)}"

    def document_original(self, document_id: str, filename: str) -> str:
        ext = Path(filename).suffix or ".pdf"
        return f"{self.task_prefix()}/documents/{document_id}/original/{self._filename('source', ext)}"

    def document_ingest_result(self, document_id: str, ingest_id: str) -> str:
        return f"{self.task_prefix()}/documents/{document_id}/ingests/{ingest_id}/{self._filename('result', '.json')}"

    def document_ingest_image(self, document_id: str, ingest_id: str, asset_id: str, ext: str) -> str:
        short_asset = re.sub(r"[^a-zA-Z0-9]+", "", asset_id)[-10:]
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return (
            f"{self.task_prefix()}/documents/{document_id}/ingests/{ingest_id}/images/"
            f"{self._filename(f'image{short_asset}', safe_ext)}"
        )

    def canvas_media_asset(self, asset_id: str, filename: str) -> str:
        short_asset = re.sub(r"[^a-zA-Z0-9]+", "", asset_id)[-10:]
        ext = Path(filename).suffix or ".bin"
        return f"{self.task_prefix()}/canvas/media/{asset_id}/{self._filename(f'asset{short_asset}', ext)}"

    def segment_original(self, segment_id: str) -> str:
        short_seg = re.sub(r"[^a-zA-Z0-9]+", "", segment_id)[-8:]
        return f"{self.task_prefix()}/segments/{segment_id}/{self._filename(f'seg{short_seg}_orig', '.mp4')}"

    def segment_original_audio(self, segment_id: str, ext: str = ".wav") -> str:
        short_seg = re.sub(r"[^a-zA-Z0-9]+", "", segment_id)[-8:]
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.task_prefix()}/segments/{segment_id}/{self._filename(f'seg{short_seg}_orig', safe_ext)}"

    def segment_generated(self, segment_id: str, generation_id: str) -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        return f"{self.task_prefix()}/segments/{segment_id}/generated/{self._filename(f'output{short_gen}', '.mp4')}"

    def segment_generated_poster(self, segment_id: str, generation_id: str) -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        return f"{self.task_prefix()}/segments/{segment_id}/generated/{self._filename(f'output{short_gen}_poster', '.png')}"

    def segment_provider_input(self, segment_id: str, generation_id: str, provider: str) -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        safe_provider = re.sub(r"[^a-zA-Z0-9]+", "", provider.lower())[:12] or "provider"
        return f"{self.task_prefix()}/segments/{segment_id}/inputs/{self._filename(f'{safe_provider}{short_gen}_input', '.mp4')}"

    def segment_provider_first_frame(self, segment_id: str, generation_id: str, provider: str, ext: str = ".jpg") -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        safe_provider = re.sub(r"[^a-zA-Z0-9]+", "", provider.lower())[:12] or "provider"
        return f"{self.task_prefix()}/segments/{segment_id}/inputs/{self._filename(f'{safe_provider}{short_gen}_first', ext)}"

    def segment_provider_last_frame(self, segment_id: str, generation_id: str, provider: str, ext: str = ".jpg") -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        safe_provider = re.sub(r"[^a-zA-Z0-9]+", "", provider.lower())[:12] or "provider"
        return f"{self.task_prefix()}/segments/{segment_id}/inputs/{self._filename(f'{safe_provider}{short_gen}_last', ext)}"

    def segment_provider_audio(self, segment_id: str, generation_id: str, provider: str, ext: str = ".mp3") -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        safe_provider = re.sub(r"[^a-zA-Z0-9]+", "", provider.lower())[:12] or "provider"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.task_prefix()}/segments/{segment_id}/inputs/{self._filename(f'{safe_provider}{short_gen}_audio', safe_ext)}"

    def export_output(self, export_id: str) -> str:
        short_export = re.sub(r"[^a-zA-Z0-9]+", "", export_id)[-8:]
        return f"{self.task_prefix()}/exports/{self._filename(f'output{short_export}', '.mp4')}"

    def export_motion_qc_prefix(self, export_id: str) -> str:
        return f"{self.task_prefix()}/exports/{export_id}/motion_qc"

    def export_motion_qc_artifact(self, export_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "artifact"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.export_motion_qc_prefix(export_id)}/{self._filename(safe_stem, safe_ext)}"

    def qc_prefix(self, segment_id: str, generation_id: str) -> str:
        return f"{self.task_prefix()}/segments/{segment_id}/qc/{generation_id}"

    def qc_artifact(self, segment_id: str, generation_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "artifact"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.qc_prefix(segment_id, generation_id)}/{self._filename(safe_stem, safe_ext)}"

    def report_prefix(self, report_id: str) -> str:
        return f"{self.task_prefix()}/reports/{report_id}"

    def report_artifact(self, report_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "artifact"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.report_prefix(report_id)}/{self._filename(safe_stem, safe_ext)}"

    def quality_match_prefix(self, frame_id: str, analysis_id: str) -> str:
        return f"{self.task_prefix()}/frames/{frame_id}/quality_match/{analysis_id}"

    def quality_match_artifact(self, frame_id: str, analysis_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "artifact"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.quality_match_prefix(frame_id, analysis_id)}/{self._filename(safe_stem, safe_ext)}"

    def quality_match_mask_upload(self, frame_id: str, analysis_id: str, suffix: str = "mask") -> str:
        safe_suffix = re.sub(r"[^a-zA-Z0-9_-]+", "", suffix)[:32] or "mask"
        return f"{self.quality_match_prefix(frame_id, analysis_id)}/{self._filename(f'{safe_suffix}', '.png')}"

    def manual_refine_export(self, frame_id: str, source_variant_id: str, export_id: str, ext: str = ".psd") -> str:
        short_var = re.sub(r"[^a-zA-Z0-9]+", "", source_variant_id)[-12:]
        short_export = re.sub(r"[^a-zA-Z0-9]+", "", export_id)[-8:]
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return (
            f"{self.task_prefix()}/frames/{frame_id}/manual_refine/"
            f"{self._filename(f'frameexport{short_var}_{short_export}', safe_ext)}"
        )

    def manual_refine_upload(self, frame_id: str, upload_id: str, filename: str) -> str:
        short_upload = re.sub(r"[^a-zA-Z0-9]+", "", upload_id)[-12:]
        ext = Path(filename).suffix or ".png"
        return (
            f"{self.task_prefix()}/frames/{frame_id}/manual_refine/uploads/"
            f"{self._filename(f'upload{short_upload}', ext)}"
        )

    def manual_frame_upload(self, frame_id: str, upload_id: str, filename: str) -> str:
        short_upload = re.sub(r"[^a-zA-Z0-9]+", "", upload_id)[-12:]
        ext = Path(filename).suffix or ".png"
        return (
            f"{self.task_prefix()}/frames/{frame_id}/manual_uploads/"
            f"{self._filename(f'upload{short_upload}', ext)}"
        )

    def manual_segment_generation_upload(self, segment_id: str, upload_id: str, filename: str) -> str:
        short_upload = re.sub(r"[^a-zA-Z0-9]+", "", upload_id)[-12:]
        ext = Path(filename).suffix or ".mp4"
        return (
            f"{self.task_prefix()}/segments/{segment_id}/manual_uploads/"
            f"{self._filename(f'upload{short_upload}', ext)}"
        )

    def manual_segment_generation_output(self, segment_id: str, generation_id: str, filename: str) -> str:
        short_gen = re.sub(r"[^a-zA-Z0-9]+", "", generation_id)[-8:]
        ext = Path(filename).suffix or ".mp4"
        return (
            f"{self.task_prefix()}/segments/{segment_id}/generated/manual/"
            f"{self._filename(f'output{short_gen}', ext)}"
        )

    def cleanup_track_prefix(self, track_id: str) -> str:
        return f"{self.task_prefix()}/cleanup_tracks/{track_id}"

    def cleanup_track_input(self, track_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "input"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.cleanup_track_prefix(track_id)}/input/{self._filename(safe_stem, safe_ext)}"

    def cleanup_track_working_segment(self, track_id: str, stem: str = "source_segment") -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "segment"
        return f"{self.cleanup_track_prefix(track_id)}/working/{self._filename(safe_stem, '.mp4')}"

    def cleanup_track_working_frame(self, track_id: str, frame_kind: str, frame_index_local: int, ext: str = ".png") -> str:
        safe_kind = re.sub(r"[^a-zA-Z0-9_-]+", "", frame_kind)[:32] or "frame"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return (
            f"{self.cleanup_track_prefix(track_id)}/working/{safe_kind}_frames/"
            f"{self._filename(f'frame_{frame_index_local:04d}', safe_ext)}"
        )

    def cleanup_track_tracking_run_prefix(self, track_id: str, run_id: str) -> str:
        return f"{self.cleanup_track_prefix(track_id)}/tracking/runs/{run_id}"

    def cleanup_track_tracking_run_artifact(self, track_id: str, run_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "artifact"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.cleanup_track_tracking_run_prefix(track_id, run_id)}/{self._filename(safe_stem, safe_ext)}"

    def cleanup_track_tracking_mask(self, track_id: str, run_id: str, frame_index_local: int) -> str:
        return (
            f"{self.cleanup_track_tracking_run_prefix(track_id, run_id)}/masks/"
            f"{self._filename(f'frame_{frame_index_local:04d}', '.png')}"
        )

    def cleanup_track_review_frame(self, track_id: str, frame_kind: str, frame_index_local: int, ext: str = ".png") -> str:
        safe_kind = re.sub(r"[^a-zA-Z0-9_-]+", "", frame_kind)[:32] or "frame"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return (
            f"{self.cleanup_track_prefix(track_id)}/review/{safe_kind}_frames/"
            f"{self._filename(f'frame_{frame_index_local:04d}', safe_ext)}"
        )

    def cleanup_track_review_artifact(self, track_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "artifact"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.cleanup_track_prefix(track_id)}/review/{self._filename(safe_stem, safe_ext)}"

    def cleanup_track_keyframe_mask(self, track_id: str, frame_index_local: int) -> str:
        return (
            f"{self.cleanup_track_prefix(track_id)}/keyframes/"
            f"{self._filename(f'frame_{frame_index_local:04d}_mask', '.png')}"
        )

    def cleanup_track_apply_artifact(self, track_id: str, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "artifact"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{self.cleanup_track_prefix(track_id)}/apply/{self._filename(safe_stem, safe_ext)}"


@dataclass(frozen=True)
class ApiAssetPaths:
    user_id: str

    def _filename(self, stem: str, ext: str) -> str:
        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "", stem)[:80] or "asset"
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        return f"{safe_stem}{safe_ext}"

    def uploads_prefix(self) -> str:
        return f"users/{self.user_id}/api_uploads"

    def upload_asset(self, asset_id: str, filename: str) -> str:
        ext = Path(filename).suffix or ".bin"
        safe_asset = re.sub(r"[^a-zA-Z0-9_-]+", "", asset_id)[:40] or "asset"
        return f"{self.uploads_prefix()}/{safe_asset}/{self._filename('incoming', ext)}"

    def requests_prefix(self) -> str:
        return f"users/{self.user_id}/api_requests"

    def request_prefix(self, request_id: str) -> str:
        safe_request = re.sub(r"[^a-zA-Z0-9_-]+", "", request_id)[:40] or "request"
        return f"{self.requests_prefix()}/{safe_request}"

    def request_artifact(self, request_id: str, section: str, stem: str, ext: str) -> str:
        safe_section = re.sub(r"[^a-zA-Z0-9_-]+", "", section)[:32] or "artifact"
        return f"{self.request_prefix(request_id)}/{safe_section}/{self._filename(stem, ext)}"


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

    def delete_object(self, key: str, *, purge_versions: bool = False) -> None:
        if not purge_versions:
            self.s3.delete_object(Bucket=self.assets_bucket, Key=key)
            return
        self.delete_prefix(key, purge_versions=True, exact_key=True)

    def delete_prefix(self, prefix: str, *, purge_versions: bool = False, exact_key: bool = False) -> None:
        if not prefix:
            return
        if not purge_versions:
            paginator = self.s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.assets_bucket, Prefix=prefix):
                contents = page.get("Contents") or []
                if not contents:
                    continue
                delete_batch = {
                    "Objects": [{"Key": item["Key"]} for item in contents if isinstance(item, dict) and item.get("Key")],
                    "Quiet": True,
                }
                if delete_batch["Objects"]:
                    self.s3.delete_objects(Bucket=self.assets_bucket, Delete=delete_batch)
            if exact_key:
                self.s3.delete_object(Bucket=self.assets_bucket, Key=prefix)
            return

        paginator = self.s3.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=self.assets_bucket, Prefix=prefix):
            objects: list[dict[str, str]] = []
            for field in ("Versions", "DeleteMarkers"):
                for item in page.get(field) or []:
                    if not isinstance(item, dict):
                        continue
                    key = item.get("Key")
                    version_id = item.get("VersionId")
                    if not key or not version_id:
                        continue
                    if exact_key and key != prefix:
                        continue
                    objects.append({"Key": key, "VersionId": version_id})
            for start in range(0, len(objects), 1000):
                chunk = objects[start : start + 1000]
                if chunk:
                    self.s3.delete_objects(
                        Bucket=self.assets_bucket,
                        Delete={"Objects": chunk, "Quiet": True},
                    )

    def copy_object(self, source_key: str, target_key: str, *, content_type: str | None = None) -> None:
        extra_args: dict[str, Any] = {"ServerSideEncryption": "AES256"}
        if content_type:
            extra_args["ContentType"] = content_type
            extra_args["MetadataDirective"] = "REPLACE"
        self.s3.copy_object(
            Bucket=self.assets_bucket,
            Key=target_key,
            CopySource={"Bucket": self.assets_bucket, "Key": source_key},
            **extra_args,
        )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

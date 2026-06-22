from __future__ import annotations

import json
from typing import Any, Callable

from botocore.exceptions import ClientError

from src.models.schemas import DocumentUploadCompleteRequest, DocumentUploadInitRequest, PdfIngestRequest


def _is_pdf_content_type(value: str | None) -> bool:
    normalized = str(value or "").strip().lower()
    return normalized in {"application/pdf", "application/x-pdf"} or normalized.endswith("/pdf")


def _find_document(task: dict[str, Any], document_id: str) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in task.get("documents", [])
            if isinstance(item, dict) and str(item.get("documentId") or "") == str(document_id)
        ),
        None,
    )


def _find_document_ingest(task: dict[str, Any], document_id: str, ingest_id: str) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in task.get("documentIngests", [])
            if isinstance(item, dict)
            and str(item.get("documentId") or "") == str(document_id)
            and str(item.get("ingestId") or "") == str(ingest_id)
        ),
        None,
    )


def _reconcile_document_ingest_state(
    *,
    store,
    asset_store,
    task: dict[str, Any],
    document: dict[str, Any],
    ingest_record: dict[str, Any],
    now_iso_fn: Callable[[], str],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    status = str(ingest_record.get("status") or "").strip().lower()
    job_id = str(ingest_record.get("jobId") or "").strip()
    result_payload: dict[str, Any] | None = None
    changed = False

    if isinstance(ingest_record.get("resultKey"), str):
        try:
            result_payload = json.loads(asset_store.read_bytes(str(ingest_record["resultKey"])).decode("utf-8"))
        except Exception:
            result_payload = None

    if status not in {"complete", "failed"} and job_id:
        job = store.load_job(str(task.get("userId") or ""), job_id)
        job_status = str((job or {}).get("status") or "").strip().lower()
        if job_status == "complete":
            ingest_record["status"] = "complete"
            ingest_record["updatedAt"] = str((job or {}).get("finishedAt") or now_iso_fn())
            ingest_record["finishedAt"] = str((job or {}).get("finishedAt") or now_iso_fn())
            ingest_record["error"] = None
            changed = True
        elif job_status == "failed":
            ingest_record["status"] = "failed"
            ingest_record["updatedAt"] = str((job or {}).get("finishedAt") or now_iso_fn())
            ingest_record["finishedAt"] = str((job or {}).get("finishedAt") or now_iso_fn())
            ingest_record["error"] = str((job or {}).get("error") or "PDF ingest failed")
            changed = True

    if str(ingest_record.get("status") or "") == "complete" and isinstance(result_payload, dict):
        if not isinstance(ingest_record.get("summary"), dict):
            ingest_record["summary"] = dict(result_payload.get("summary") or {})
            changed = True
        if not isinstance(ingest_record.get("imageAssets"), list) or not ingest_record.get("imageAssets"):
            ingest_record["imageAssets"] = list(result_payload.get("imageAssets") or [])
            changed = True
        if not isinstance(ingest_record.get("warnings"), list) or (
            not ingest_record.get("warnings") and result_payload.get("warnings")
        ):
            ingest_record["warnings"] = list(result_payload.get("warnings") or [])
            changed = True
        if document.get("latestIngestId") != ingest_record.get("ingestId"):
            document["latestIngestId"] = ingest_record.get("ingestId")
            changed = True

    if changed:
        document["updatedAt"] = now_iso_fn()
        store.save_task(task, merge_on_conflict=True)
        document = _find_document(task, str(document.get("documentId") or "")) or document
        ingest_record = _find_document_ingest(task, str(document.get("documentId") or ""), str(ingest_record.get("ingestId") or "")) or ingest_record
    return document, ingest_record, result_payload


def handle_task_document_routes(
    method: str,
    *,
    task_id: str,
    parts: list[str],
    event: dict[str, Any],
    origin: str | None,
    user_id: str,
    task: dict[str, Any],
    store,
    asset_store,
    json_model: Callable[[Any, dict[str, Any]], Any],
    response_fn: Callable[..., dict[str, Any]],
    error_response_fn: Callable[..., dict[str, Any]],
    new_id_fn: Callable[[str], str],
    now_iso_fn: Callable[[], str],
    queue_job_fn: Callable[..., str],
    max_upload_bytes: int,
    asset_paths_for_task_fn: Callable[[dict[str, Any]], Any],
    decorate_embedded_s3_keys_fn: Callable[[Any, Any], None],
) -> dict[str, Any] | None:
    if method == "POST" and len(parts) == 5 and parts[2] == "documents" and parts[3] == "upload" and parts[4] == "init":
        req = json_model(DocumentUploadInitRequest, event)
        if req.sizeBytes > max_upload_bytes:
            return error_response_fn(400, f"Upload too large (max={max_upload_bytes})", origin=origin)
        if not _is_pdf_content_type(req.contentType):
            return error_response_fn(400, "Only PDF uploads are supported", origin=origin)
        document_id = new_id_fn("doc")
        upload_key = asset_paths_for_task_fn(task).document_original(document_id, req.filename)
        return response_fn(
            200,
            {
                "documentId": document_id,
                "uploadKey": upload_key,
                "uploadUrl": asset_store.presign_put(upload_key, expires=900, content_type=req.contentType),
            },
            origin=origin,
        )

    if method == "POST" and len(parts) == 5 and parts[2] == "documents" and parts[3] == "upload" and parts[4] == "complete":
        req = json_model(DocumentUploadCompleteRequest, event)
        paths = asset_paths_for_task_fn(task)
        expected_prefix = f"{paths.task_prefix()}/documents/{req.documentId}/original/"
        if not req.uploadKey.startswith(expected_prefix):
            return error_response_fn(400, "Upload key is outside this task document path", origin=origin)
        try:
            head = asset_store.head_object(req.uploadKey)
        except ClientError:
            return error_response_fn(404, "Uploaded PDF file not found", origin=origin)

        content_type = str(head.get("ContentType") or "")
        if not (_is_pdf_content_type(content_type) or req.filename.lower().endswith(".pdf")):
            return error_response_fn(400, "Uploaded file must be a PDF", origin=origin)

        now = now_iso_fn()
        document_record = {
            "documentId": req.documentId,
            "documentKind": "pdf",
            "filename": req.filename,
            "contentType": content_type or "application/pdf",
            "originalKey": req.uploadKey,
            "sizeBytes": int(head.get("ContentLength") or 0),
            "etag": str(head.get("ETag") or "").strip('"'),
            "createdAt": now,
            "updatedAt": now,
            "latestIngestId": None,
        }
        documents = task.setdefault("documents", [])
        task["documents"] = [
            item
            for item in documents
            if not (isinstance(item, dict) and str(item.get("documentId") or "") == str(req.documentId))
        ]
        task["documents"].append(document_record)
        task.setdefault("history", []).append(
            {
                "at": now,
                "event": "document.uploaded",
                "documentId": req.documentId,
                "filename": req.filename,
                "userId": user_id,
            }
        )
        store.save_task(task, merge_on_conflict=True)
        response_payload = json.loads(json.dumps(document_record))
        decorate_embedded_s3_keys_fn(response_payload, asset_store)
        return response_fn(200, {"document": response_payload}, origin=origin)

    if method == "POST" and len(parts) == 5 and parts[2] == "documents" and parts[4] == "ingests":
        document_id = parts[3]
        document = _find_document(task, document_id)
        if not isinstance(document, dict):
            return error_response_fn(404, "Document not found", origin=origin)
        if str(document.get("documentKind") or "") != "pdf":
            return error_response_fn(400, "Only PDF ingest is supported", origin=origin)
        req = json_model(PdfIngestRequest, event)
        ingest_id = new_id_fn("pdfing")
        result_key = asset_paths_for_task_fn(task).document_ingest_result(document_id, ingest_id)
        job_id = queue_job_fn(
            store=store,
            user_id=user_id,
            task_id=task_id,
            job_type="pdf_ingest",
            payload={
                "documentId": document_id,
                "ingestId": ingest_id,
                "mode": req.mode,
                "resultKey": result_key,
            },
        )
        now = now_iso_fn()
        ingest_record = {
            "ingestId": ingest_id,
            "documentId": document_id,
            "documentKind": "pdf",
            "mode": req.mode,
            "status": "queued",
            "jobId": job_id,
            "resultKey": result_key,
            "imageAssets": [],
            "warnings": [],
            "error": None,
            "createdAt": now,
            "updatedAt": now,
        }
        task.setdefault("documentIngests", []).append(ingest_record)
        document["latestIngestId"] = ingest_id
        document["updatedAt"] = now
        task.setdefault("history", []).append(
            {
                "at": now,
                "event": "document.ingest.queued",
                "documentId": document_id,
                "ingestId": ingest_id,
                "jobId": job_id,
                "mode": req.mode,
            }
        )
        store.save_task(task, merge_on_conflict=True)
        return response_fn(202, {"documentId": document_id, "ingestId": ingest_id, "jobId": job_id}, origin=origin)

    if method == "GET" and len(parts) == 6 and parts[2] == "documents" and parts[4] == "ingests":
        document_id = parts[3]
        ingest_id = parts[5]
        document = _find_document(task, document_id)
        if not isinstance(document, dict):
            return error_response_fn(404, "Document not found", origin=origin)
        ingest_record = _find_document_ingest(task, document_id, ingest_id)
        if not isinstance(ingest_record, dict):
            return error_response_fn(404, "Document ingest not found", origin=origin)
        document, ingest_record, reconciled_result = _reconcile_document_ingest_state(
            store=store,
            asset_store=asset_store,
            task=task,
            document=document,
            ingest_record=ingest_record,
            now_iso_fn=now_iso_fn,
        )

        payload = {
            "document": json.loads(json.dumps(document)),
            "ingest": json.loads(json.dumps(ingest_record)),
        }
        if str(ingest_record.get("status") or "") == "complete" and isinstance(ingest_record.get("resultKey"), str):
            try:
                payload["result"] = reconciled_result or json.loads(asset_store.read_bytes(str(ingest_record["resultKey"])).decode("utf-8"))
            except Exception:
                payload["result"] = None
        decorate_embedded_s3_keys_fn(payload, asset_store)
        return response_fn(200, payload, origin=origin)

    return None

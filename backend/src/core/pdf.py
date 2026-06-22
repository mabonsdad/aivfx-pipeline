from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image
from pypdf import PdfReader


@dataclass
class PdfExtractedImage:
    digest: str
    ext: str
    mime_type: str
    width: int
    height: int
    bytes_data: bytes
    page_numbers: list[int]
    occurrences: list[dict[str, Any]]


def _normalize_table_rows(rows: list[list[Any]] | None) -> list[list[str | None]]:
    normalized: list[list[str | None]] = []
    for row in rows or []:
        normalized_row: list[str | None] = []
        for cell in row or []:
            if cell is None:
                normalized_row.append(None)
            else:
                normalized_row.append(str(cell))
        normalized.append(normalized_row)
    return normalized


def _extract_table_rows_from_text(text: str) -> list[dict[str, Any]]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    candidate_rows: list[list[str]] = []
    tables: list[dict[str, Any]] = []
    previous_col_count: int | None = None

    def flush_rows() -> None:
        nonlocal candidate_rows, previous_col_count
        if len(candidate_rows) >= 2:
            normalized_rows = _normalize_table_rows(candidate_rows)
            tables.append(
                {
                    "tableIndex": len(tables),
                    "rowCount": len(normalized_rows),
                    "colCount": max((len(item) for item in normalized_rows), default=0),
                    "rows": normalized_rows,
                }
            )
        candidate_rows = []
        previous_col_count = None

    for line in lines:
        if "|" in line:
            cells = [cell.strip() for cell in line.split("|")]
        else:
            cells = [cell.strip() for cell in re.split(r"(?:\t+|\s{2,})", line) if cell.strip()]
        if len(cells) < 2:
            flush_rows()
            continue
        if previous_col_count is not None and abs(previous_col_count - len(cells)) > 1:
            flush_rows()
        candidate_rows.append(cells)
        previous_col_count = len(cells)
    flush_rows()
    return tables


def _image_details(image_bytes_data: bytes, fallback_name: str) -> tuple[str, str, int, int]:
    with Image.open(BytesIO(image_bytes_data)) as image:
        width, height = image.size
        format_name = str(image.format or "").lower()
    ext = Path(fallback_name).suffix.lower().lstrip(".") or format_name or "png"
    if ext == "jpeg":
        ext = "jpg"
    mime_ext = "jpeg" if ext == "jpg" else ext
    return ext, f"image/{mime_ext}", int(width), int(height)


def extract_pdf_contents(
    pdf_bytes: bytes,
    *,
    extract_text_tables: bool,
    extract_images: bool,
) -> tuple[dict[str, Any], list[PdfExtractedImage]]:
    reader = PdfReader(BytesIO(pdf_bytes))
    page_count = len(reader.pages)
    extracted_images: dict[str, PdfExtractedImage] = {}
    result: dict[str, Any] = {
        "pageCount": page_count,
        "pages": [],
        "warnings": [],
        "summary": {
            "textPageCount": 0,
            "textCharCount": 0,
            "tableCount": 0,
            "imageCount": 0,
        },
    }

    if extract_text_tables:
        result["warnings"].append(
            "Table extraction is heuristic in this deployment and works best on digitally-generated PDFs with clear spacing or pipe-delimited columns."
        )

    for page_index, page in enumerate(reader.pages):
        page_number = page_index + 1
        page_entry: dict[str, Any] = {"pageNumber": page_number}

        if extract_text_tables:
            try:
                text = page.extract_text() or ""
            except Exception as exc:
                text = ""
                result["warnings"].append(f"Page {page_number}: text extraction failed ({exc})")
            page_entry["text"] = text
            result["summary"]["textCharCount"] += len(text)
            if text.strip():
                result["summary"]["textPageCount"] += 1

            try:
                page_tables = _extract_table_rows_from_text(text)
            except Exception as exc:
                page_tables = []
                result["warnings"].append(f"Page {page_number}: table extraction failed ({exc})")
            page_entry["tables"] = page_tables
            result["summary"]["tableCount"] += len(page_tables)

        if extract_images:
            page_image_refs: list[dict[str, Any]] = []
            try:
                page_images = list(getattr(page, "images", []) or [])
            except Exception as exc:
                page_images = []
                result["warnings"].append(f"Page {page_number}: image enumeration failed ({exc})")
            for occurrence_index, image_file_object in enumerate(page_images):
                try:
                    image_bytes_data = bytes(image_file_object.data)
                except Exception as exc:
                    result["warnings"].append(f"Page {page_number}: image extraction failed ({exc})")
                    continue
                if not image_bytes_data:
                    continue
                fallback_name = str(getattr(image_file_object, "name", "") or f"image-{occurrence_index}.bin")
                try:
                    ext, mime_type, width, height = _image_details(image_bytes_data, fallback_name)
                except Exception as exc:
                    result["warnings"].append(f"Page {page_number}: image decode failed ({exc})")
                    continue
                digest = hashlib.sha256(image_bytes_data).hexdigest()
                occurrence = {
                    "pageNumber": page_number,
                    "name": fallback_name,
                    "occurrenceIndex": occurrence_index,
                    "width": width,
                    "height": height,
                }
                image_entry = extracted_images.get(digest)
                if image_entry is None:
                    image_entry = PdfExtractedImage(
                        digest=digest,
                        ext=ext,
                        mime_type=mime_type,
                        width=width,
                        height=height,
                        bytes_data=image_bytes_data,
                        page_numbers=[page_number],
                        occurrences=[occurrence],
                    )
                    extracted_images[digest] = image_entry
                else:
                    if page_number not in image_entry.page_numbers:
                        image_entry.page_numbers.append(page_number)
                    image_entry.occurrences.append(occurrence)
                page_image_refs.append(
                    {
                        "digest": digest,
                        "pageNumber": page_number,
                        "name": fallback_name,
                        "occurrenceIndex": occurrence_index,
                        "width": width,
                        "height": height,
                        "mimeType": mime_type,
                        "ext": ext,
                    }
                )
            page_entry["imageRefs"] = page_image_refs

        result["pages"].append(page_entry)

    result["summary"]["imageCount"] = len(extracted_images)
    return result, list(extracted_images.values())

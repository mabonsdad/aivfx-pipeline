from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class TaskCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=15)


class UploadVideoRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(default="video/mp4")
    sizeBytes: int = Field(gt=0)


class SegmentCreateRequest(BaseModel):
    startFrameIndex: int = Field(ge=0)
    durationSeconds: int = Field(ge=1, le=120)


class SegmentPatchRequest(BaseModel):
    startFrameIndex: int | None = Field(default=None, ge=0)
    endFrameExclusive: int | None = Field(default=None, ge=1)


class FrameCaptureRequest(BaseModel):
    frameIndex: int = Field(ge=0)


class FullEditRequest(BaseModel):
    model: Literal["nano_banana", "nano_banana_pro", "chatgpt"]
    prompt: str = Field(min_length=1)
    sourceVariantId: str | None = None


class PatchRect(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class PatchInitRequest(BaseModel):
    patchRect: PatchRect
    featherPx: int = Field(ge=0, le=200)
    bleedPx: int = Field(ge=0, le=300, default=32)
    hasMask: bool = False
    sourceVariantId: str | None = None


class PatchSubmitRequest(BaseModel):
    model: Literal["nano_banana_pro", "chatgpt", "runware_flux_fill", "runware_ace_pp"]
    prompt: str = Field(min_length=1)
    patchKey: str
    maskKey: str | None = None
    patchRect: PatchRect
    featherPx: int = Field(ge=0, le=200)
    bleedPx: int = Field(ge=0, le=300, default=32)
    referenceImageKey: str | None = None
    runwareRepaintingScale: float = Field(ge=0, le=1, default=0.7)
    edgeAwareRefine: bool = False
    edgeAwareStrength: float = Field(ge=0, le=1, default=0.45)
    edgeAwareRadiusPx: int = Field(ge=0, le=24, default=6)
    maskGrowPx: int = Field(ge=-64, le=64, default=0)
    sourceVariantId: str | None = None


class ReferenceUploadItem(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)


class ReferenceUploadRequest(BaseModel):
    files: list[ReferenceUploadItem] = Field(min_length=1, max_length=1)


class SegmentGenerateRequest(BaseModel):
    lumaModel: Literal[
        "ray-2",
        "ray-flash-2",
        "runway-gen4.5",
        "kling-2.6",
        "veo-3.1",
        "veo-3.1-fast",
        "wan2.2-a14b",
        "wan2.2-animate",
    ] = "ray-2"
    mode: Literal[
        "adhere_1",
        "adhere_2",
        "adhere_3",
        "flex_1",
        "flex_2",
        "flex_3",
        "reimagine_1",
        "reimagine_2",
        "reimagine_3",
        "runway_i2v",
        "kling_start_end",
        "veo_start_end",
        "wan_a14b_i2v",
        "wan_animate_replace",
    ]
    prompt: str | None = Field(default=None)
    firstFrameVariantId: str | None = None
    lastFrameVariantId: str | None = None


class MergeGenerationAdjustment(BaseModel):
    startFrameOverride: int | None = Field(default=None, ge=0)
    trimStartFrames: int = Field(default=0, ge=0)
    trimEndFrames: int = Field(default=0, ge=0)


class MergeRequest(BaseModel):
    selectedSegmentGenerationIds: list[str]
    temporalFeatherFrames: int = Field(ge=0, le=30, default=0)
    generationAdjustments: dict[str, MergeGenerationAdjustment] | None = None


class QcRunRequest(BaseModel):
    generationIds: list[str] | None = Field(default=None, max_length=20)


class VariantSelectRequest(BaseModel):
    ok: bool = True


class AssetDeleteRequest(BaseModel):
    assetType: Literal["upload", "frame_capture", "frame_variant", "segment_generation", "export"]
    frameId: str | None = None
    variantId: str | None = None
    genId: str | None = None
    exportId: str | None = None


class CustomReportOutputRef(BaseModel):
    assetType: Literal["frame_variant", "segment_generation"]
    frameId: str | None = None
    variantId: str | None = None
    genId: str | None = None


class CustomReportCreateRequest(BaseModel):
    reportType: Literal["qc_frame", "qc_video"]
    outputRefs: list[CustomReportOutputRef] = Field(min_length=1, max_length=400)
    name: str | None = Field(default=None, min_length=1, max_length=80)


class TaskFrameVariant(BaseModel):
    variantId: str
    type: Literal["full", "patch"]
    model: Literal["nano_banana", "nano_banana_pro", "chatgpt", "runware_flux_fill", "runware_ace_pp"]
    promptHash: str
    createdAt: datetime
    outputKey: str
    patchMeta: dict[str, Any] | None = None


class TaskFrame(BaseModel):
    frameId: str
    frameIndex: int
    timecode: str
    captureKey: str
    variants: list[TaskFrameVariant] = Field(default_factory=list)
    selectedVariantId: str | None = None


class TaskMetadata(BaseModel):
    taskId: str
    userId: str
    name: str
    createdAt: datetime
    updatedAt: datetime
    status: Literal["created", "ingesting", "ready", "error"]
    video: dict[str, Any] = Field(default_factory=dict)
    segments: list[dict[str, Any]] = Field(default_factory=list)
    frames: dict[str, TaskFrame] = Field(default_factory=dict)
    segmentGenerations: dict[str, Any] = Field(default_factory=dict)
    exports: list[dict[str, Any]] = Field(default_factory=list)
    customReports: list[dict[str, Any]] = Field(default_factory=list)
    history: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

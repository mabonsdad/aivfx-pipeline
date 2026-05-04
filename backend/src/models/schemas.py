from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class TaskCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=15)


class UploadVideoRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(default="video/mp4")
    sizeBytes: int = Field(gt=0)


class ExternalQcPairUploadRequest(BaseModel):
    originalFilename: str = Field(min_length=1, max_length=255)
    originalContentType: str = Field(min_length=1, max_length=120)
    editedFilename: str = Field(min_length=1, max_length=255)
    editedContentType: str = Field(min_length=1, max_length=120)


class SegmentCreateRequest(BaseModel):
    startFrameIndex: int = Field(ge=0)
    durationSeconds: int | None = Field(default=None, ge=1, le=120)
    endFrameExclusive: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _validate_segment_bounds(self):
        if self.durationSeconds is None and self.endFrameExclusive is None:
            raise ValueError("Provide durationSeconds or endFrameExclusive")
        return self


class SegmentCropRequest(BaseModel):
    aspect: Literal["16:9", "9:16"] = "16:9"
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    featherPx: int = Field(default=0, ge=0, le=200)


class SegmentPatchRequest(BaseModel):
    startFrameIndex: int | None = Field(default=None, ge=0)
    endFrameExclusive: int | None = Field(default=None, ge=1)
    crop: SegmentCropRequest | None = None


class FrameCaptureRequest(BaseModel):
    frameIndex: int = Field(ge=0)


class FullEditRequest(BaseModel):
    model: Literal["nano_banana", "nano_banana_pro", "chatgpt", "chatgpt_latest"]
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
    model: Literal["nano_banana_pro", "chatgpt", "chatgpt_latest", "runware_flux_fill", "runware_ace_pp"]
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
        "sora-2-image-to-video",
        "happy-horse-video-edit",
        "happy-horse-image-to-video",
        "runway-gen4-aleph",
        "kling-2.6",
        "kling-o1",
        "kling-v3-omni-video",
        "seedance-2.0-reference-to-video",
        "veo-3.1",
        "veo-3.1-fast",
        "wan2.2-a14b",
        "wan2.2-animate",
        "wan2.7-videoedit",
        "wan2.7-i2v",
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
        "sora_i2v",
        "happy_horse_video_edit",
        "happy_horse_i2v",
        "runway_aleph_v2v",
        "kling_start_end",
        "kling_start_only",
        "veo_start_end",
        "veo_start_only",
        "wan_a14b_i2v",
        "wan_animate_replace",
        "kling_o1_video_edit",
        "kling_v3_omni_video_edit",
        "seedance_reference_to_video",
        "wan27_video_edit",
        "wan27_i2v_start_only",
        "wan27_i2v_start_end",
    ]
    prompt: str | None = Field(default=None)
    negativePrompt: str | None = Field(default=None)
    firstFrameVariantId: str | None = None
    lastFrameVariantId: str | None = None
    replicateKlingMode: Literal["std", "pro"] | None = None
    replicateKlingV3Mode: Literal["standard", "pro"] | None = None
    wan27Resolution: Literal["720p", "1080p"] | None = None
    happyHorseResolution: Literal["720p", "1080p"] | None = None
    sora2Resolution: Literal["auto", "720p", "1080p"] | None = None
    preserveFrames: bool = True


class ApiAssetUploadInitRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)
    assetType: Literal["image", "video"] = "image"


class ApiImageEditFullRequest(BaseModel):
    model: Literal["nano_banana", "nano_banana_pro", "chatgpt", "chatgpt_latest"]
    prompt: str = Field(min_length=1)
    inputAssetKey: str = Field(min_length=1)


class ApiImageEditPatchRequest(BaseModel):
    model: Literal["nano_banana_pro", "chatgpt", "chatgpt_latest", "runware_flux_fill", "runware_ace_pp"]
    prompt: str = Field(min_length=1)
    inputAssetKey: str = Field(min_length=1)
    patchAssetKey: str = Field(min_length=1)
    patchRect: PatchRect
    maskAssetKey: str | None = None
    referenceAssetKey: str | None = None
    featherPx: int = Field(ge=0, le=200)
    bleedPx: int = Field(ge=0, le=300, default=32)
    runwareRepaintingScale: float = Field(ge=0, le=1, default=0.7)
    edgeAwareRefine: bool = False
    edgeAwareStrength: float = Field(ge=0, le=1, default=0.45)
    edgeAwareRadiusPx: int = Field(ge=0, le=24, default=6)
    maskGrowPx: int = Field(ge=-64, le=64, default=0)


class ApiReferenceVideoGenerateRequest(BaseModel):
    model: Literal[
        "ray-2",
        "ray-flash-2",
        "runway-gen4.5",
        "sora-2-image-to-video",
        "happy-horse-video-edit",
        "happy-horse-image-to-video",
        "runway-gen4-aleph",
        "kling-2.6",
        "kling-o1",
        "kling-v3-omni-video",
        "seedance-2.0-reference-to-video",
        "veo-3.1",
        "veo-3.1-fast",
        "wan2.2-a14b",
        "wan2.2-animate",
        "wan2.7-videoedit",
        "wan2.7-i2v",
    ]
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
        "sora_i2v",
        "happy_horse_video_edit",
        "happy_horse_i2v",
        "runway_aleph_v2v",
        "kling_start_end",
        "kling_start_only",
        "veo_start_end",
        "veo_start_only",
        "wan_a14b_i2v",
        "wan_animate_replace",
        "kling_o1_video_edit",
        "kling_v3_omni_video_edit",
        "seedance_reference_to_video",
        "wan27_video_edit",
        "wan27_i2v_start_only",
        "wan27_i2v_start_end",
    ]
    prompt: str | None = None
    negativePrompt: str | None = None
    videoAssetKey: str | None = None
    firstFrameAssetKey: str = Field(min_length=1)
    lastFrameAssetKey: str | None = None
    durationSeconds: int | None = Field(default=None, ge=1, le=10)
    replicateKlingMode: Literal["std", "pro"] | None = None
    replicateKlingV3Mode: Literal["standard", "pro"] | None = None
    wan27Resolution: Literal["720p", "1080p"] | None = None
    happyHorseResolution: Literal["720p", "1080p"] | None = None
    sora2Resolution: Literal["auto", "720p", "1080p"] | None = None
    preserveFrames: bool = True


class MergeGenerationAdjustment(BaseModel):
    startFrameOverride: int | None = Field(default=None, ge=0)
    trimStartFrames: int = Field(default=0, ge=0)
    trimEndFrames: int = Field(default=0, ge=0)
    playbackRate: float | None = Field(default=None, gt=0.05, le=20.0)


class ReconcileTimingRequest(BaseModel):
    trimStartFrames: int = Field(default=0, ge=0)
    trimEndFrames: int = Field(default=0, ge=0)
    playbackRate: float | None = Field(default=None, gt=0.05, le=20.0)


class MergeRequest(BaseModel):
    selectedSegmentGenerationIds: list[str]
    temporalFeatherFrames: int = Field(ge=0, le=30, default=0)
    generationAdjustments: dict[str, MergeGenerationAdjustment] | None = None


class SegmentGenerationExtendRequest(BaseModel):
    alignmentFrameIndex: int = Field(ge=0)
    anchorFramesFromEnd: int = Field(default=5, ge=1, le=60)
    durationSeconds: int | None = Field(default=None, ge=1, le=15)
    prompt: str | None = None


class ChunkedSegmentGenerateRequest(BaseModel):
    lumaModel: Literal[
        "ray-2",
        "ray-flash-2",
        "runway-gen4-aleph",
        "kling-o1",
        "kling-v3-omni-video",
        "seedance-2.0-reference-to-video",
        "wan2.2-animate",
        "wan2.7-videoedit",
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
        "runway_aleph_v2v",
        "wan_animate_replace",
        "kling_o1_video_edit",
        "kling_v3_omni_video_edit",
        "seedance_reference_to_video",
        "wan27_video_edit",
    ]
    openingPrompt: str | None = Field(default=None)
    continuationPrompt: str | None = Field(default=None)
    firstFrameVariantId: str | None = None
    replicateKlingMode: Literal["std", "pro"] | None = None
    replicateKlingV3Mode: Literal["standard", "pro"] | None = None
    wan27Resolution: Literal["720p", "1080p"] | None = None
    preserveFrames: bool = True


class ChunkedGenerationPauseRequest(BaseModel):
    reason: str | None = None


class ChunkedGenerationRestartRequest(BaseModel):
    fromChunkIndex: int = Field(ge=0)
    prompt: str | None = None


class ChunkedGenerationSaveDraftRequest(BaseModel):
    pass


class ChunkedGenerationCancelRequest(BaseModel):
    reason: str | None = None


class MotionSyncQcRunRequest(BaseModel):
    force: bool = False


class QualityMatchSettingsRequest(BaseModel):
    diffThreshold: float = Field(default=0.08, ge=0.01, le=0.99)
    minRegionAreaPct: float = Field(default=0.0005, ge=0.0, le=0.1)
    featherWidthPx: int = Field(default=6, ge=0, le=64)
    boundaryProtectionWidthPx: int = Field(default=8, ge=0, le=128)
    edgeSuppression: Literal["off", "low", "medium", "high"] = "medium"
    useSeamlessCloneFallback: bool = True
    autoDetectEditRegion: bool = True


class QualityMatchAnalyseRequest(BaseModel):
    variantId: str = Field(min_length=1)
    existingAnalysisId: str | None = None
    maskKey: str | None = None
    settings: QualityMatchSettingsRequest | None = None


class QualityMatchMaskUploadRequest(BaseModel):
    analysisId: str | None = None


class QualityMatchPreviewRequest(BaseModel):
    analysisId: str = Field(min_length=1)
    maskKey: str = Field(min_length=1)
    settings: QualityMatchSettingsRequest | None = None


class QualityMatchSamPoint(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)


class QualityMatchSamBox(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    w: float = Field(gt=0)
    h: float = Field(gt=0)


class QualityMatchSamRequest(BaseModel):
    variantId: str = Field(min_length=1)
    analysisId: str | None = None
    promptType: Literal["points", "box"]
    positivePoints: list[QualityMatchSamPoint] = Field(default_factory=list, max_length=32)
    negativePoints: list[QualityMatchSamPoint] = Field(default_factory=list, max_length=32)
    box: QualityMatchSamBox | None = None
    restrictToMaskBounds: bool = True
    existingMaskKey: str | None = None
    edgeBias: Literal["conservative", "balanced", "inclusive"] = "balanced"


class QualityMatchApplyRequest(BaseModel):
    analysisId: str = Field(min_length=1)
    finalMaskKey: str | None = None
    settings: QualityMatchSettingsRequest | None = None
    overwriteGeneratedFrame: bool = True


class ManualRefineExportRequest(BaseModel):
    sourceVariantId: str = Field(min_length=1)
    format: Literal["psd", "png_zip"] = "psd"


class ManualRefineUploadInitRequest(BaseModel):
    sourceVariantId: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)


class ManualRefineUploadCompleteRequest(BaseModel):
    sourceVariantId: str = Field(min_length=1)
    uploadKey: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)


class ManualFrameUploadInitRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)


class ManualFrameUploadCompleteRequest(BaseModel):
    uploadKey: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)


class ManualSegmentGenerationUploadInitRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)


class ManualSegmentGenerationUploadCompleteRequest(BaseModel):
    uploadKey: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)
    model: Literal[
        "ray-2",
        "ray-flash-2",
        "runway-gen4.5",
        "sora-2-image-to-video",
        "happy-horse-video-edit",
        "happy-horse-image-to-video",
        "runway-gen4-aleph",
        "kling-2.6",
        "kling-o1",
        "kling-v3-omni-video",
        "seedance-2.0-reference-to-video",
        "veo-3.1",
        "veo-3.1-fast",
        "wan2.2-a14b",
        "wan2.2-animate",
        "wan2.7-videoedit",
        "wan2.7-i2v",
    ]
    mode: str = Field(min_length=1, max_length=120)
    prompt: str | None = None
    negativePrompt: str | None = None
    firstFrameVariantId: str | None = None
    lastFrameVariantId: str | None = None


class VariantSelectRequest(BaseModel):
    ok: bool = True


class AssetDeleteRequest(BaseModel):
    assetType: Literal["upload", "frame_capture", "frame_variant", "segment_generation", "export"]
    frameId: str | None = None
    variantId: str | None = None
    genId: str | None = None
    exportId: str | None = None


class CustomReportOutputRef(BaseModel):
    assetType: Literal["frame_variant", "segment_generation", "export", "external_frame_pair"]
    frameId: str | None = None
    variantId: str | None = None
    genId: str | None = None
    exportId: str | None = None
    pairId: str | None = None


class CustomReportCreateRequest(BaseModel):
    reportType: Literal["qc_frame", "qc_video", "video_compare"]
    outputRefs: list[CustomReportOutputRef] = Field(min_length=1, max_length=400)
    tests: list[str] = Field(min_length=1, max_length=20)
    name: str | None = Field(default=None, min_length=1, max_length=80)


class TaskFrameVariant(BaseModel):
    variantId: str
    type: Literal["full", "patch", "extension_anchor"]
    model: Literal["nano_banana", "nano_banana_pro", "chatgpt", "chatgpt_latest", "runware_flux_fill", "runware_ace_pp", "generated_extension_anchor"]
    promptHash: str
    createdAt: datetime
    jobId: str | None = None
    startedAt: datetime | None = None
    finishedAt: datetime | None = None
    processingDurationSec: float | None = None
    outputKey: str
    variantKind: Literal["edited", "refined"] | None = None
    sourceVariantId: str | None = None
    refinedVariantIds: list[str] = Field(default_factory=list)
    generationSettings: dict[str, Any] | None = None
    qualityMatch: dict[str, Any] | None = None
    patchMeta: dict[str, Any] | None = None


class TaskFrame(BaseModel):
    frameId: str
    frameIndex: int
    timecode: str
    captureKey: str
    width: int | None = None
    height: int | None = None
    variants: list[TaskFrameVariant] = Field(default_factory=list)
    selectedVariantId: str | None = None
    qcReviewed: bool | None = None
    qualityMatched: bool | None = None
    qualityMatchStatus: dict[str, Any] | None = None


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
    chunkedGenerationRuns: list[dict[str, Any]] = Field(default_factory=list)
    externalQcPairs: list[dict[str, Any]] = Field(default_factory=list)
    qualityMatchAnalyses: dict[str, Any] = Field(default_factory=dict)
    videoCleanupTracks: list[dict[str, Any]] = Field(default_factory=list)
    exports: list[dict[str, Any]] = Field(default_factory=list)
    customReports: list[dict[str, Any]] = Field(default_factory=list)
    history: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

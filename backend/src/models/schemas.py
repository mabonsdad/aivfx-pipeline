from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from src.contracts.video import (
    FULL_EDIT_MODEL_IDS,
    HAPPY_HORSE_RESOLUTION_IDS,
    PATCH_EDIT_MODEL_IDS,
    REPLICATE_KLING_MODE_IDS,
    REPLICATE_KLING_V3_MODE_IDS,
    SORA2_RESOLUTION_IDS,
    VIDEO_MODE_IDS,
    VIDEO_MODEL_IDS,
    WAN27_RESOLUTION_IDS,
)
from src.contracts.api import (
    LUMA_UNI_MODEL_IDS,
    LUMA_UNI_OUTPUT_FORMAT_IDS,
    LUMA_UNI_STYLE_IDS,
    TOPAZ_UPSCALE_PRESET_IDS,
    TOPAZ_VIDEO_MODEL_IDS,
)


def _validate_choice(value: str, *, field_name: str, allowed: tuple[str, ...]) -> str:
    if value not in allowed:
        allowed_values = ", ".join(allowed)
        raise ValueError(f"{field_name} must be one of: {allowed_values}")
    return value


class TaskCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=15)
    workflowId: Literal["source_video_flow", "character_animate_workflow", "simple_generation_workflow"] = "source_video_flow"
    scenePrompt: str | None = Field(default=None, max_length=4000)


class PrevizUpdateRequest(BaseModel):
    scenePrompt: str | None = Field(default=None, max_length=4000)
    sceneAspectRatio: str | None = Field(default=None, max_length=16)
    selectedReferenceIds: list[str] | None = Field(default=None, max_length=24)
    frameReferenceIds: list[str] | None = Field(default=None, max_length=48)
    selectedFrameIds: list[str] | None = Field(default=None, max_length=24)


class PrevizGenerateRequest(BaseModel):
    model: Literal["veo_3_1", "happy_horse_1_0", "seedance_2_0"]
    prompt: str = Field(min_length=1, max_length=4000)
    durationSec: int = Field(ge=4, le=15)
    sceneAspectRatio: str | None = Field(default=None, max_length=16)
    selectedFrameIds: list[str] = Field(default_factory=list, min_length=1, max_length=9)


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
    model: str
    prompt: str = Field(min_length=1)
    sourceVariantId: str | None = None
    lumaUniModel: str | None = None
    lumaUniStyle: str | None = None
    lumaUniOutputFormat: str | None = None

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=FULL_EDIT_MODEL_IDS)

    @field_validator("lumaUniModel")
    @classmethod
    def validate_luma_uni_model(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="lumaUniModel", allowed=LUMA_UNI_MODEL_IDS)

    @field_validator("lumaUniStyle")
    @classmethod
    def validate_luma_uni_style(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="lumaUniStyle", allowed=LUMA_UNI_STYLE_IDS)

    @field_validator("lumaUniOutputFormat")
    @classmethod
    def validate_luma_uni_output_format(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="lumaUniOutputFormat", allowed=LUMA_UNI_OUTPUT_FORMAT_IDS)


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
    model: str
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

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=PATCH_EDIT_MODEL_IDS)


class ReferenceUploadItem(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)


class ReferenceUploadRequest(BaseModel):
    files: list[ReferenceUploadItem] = Field(min_length=1, max_length=1)


class EditVideoReferenceUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)


class EditVideoReferenceUploadCompleteRequest(BaseModel):
    referenceId: str = Field(min_length=1, max_length=120)
    uploadKey: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)


class EditVideoReferenceImportItem(BaseModel):
    sourceKey: str = Field(min_length=1)
    filename: str | None = Field(default=None, min_length=1, max_length=255)
    sourceType: Literal["uploaded", "generated", "frame_capture", "frame_variant"] = "uploaded"
    originTaskId: str | None = Field(default=None, max_length=120)


class EditVideoReferenceImportRequest(BaseModel):
    sources: list[EditVideoReferenceImportItem] = Field(min_length=1, max_length=12)


class EditVideoReferenceGenerateRequest(BaseModel):
    model: Literal["chatgpt", "chatgpt_latest", "nano_banana", "nano_banana_pro", "luma_uni_1", "luma_uni_1_max"]
    prompt: str = Field(min_length=1, max_length=2000)
    aspectRatio: str | None = Field(default=None, max_length=16)
    selectedReferenceIds: list[str] = Field(default_factory=list, max_length=9)


class SegmentGenerateRequest(BaseModel):
    lumaModel: str = "ray-2"
    mode: str
    inputMode: Literal["start_video", "start_end", "start_only", "edit_video"] | None = None
    prompt: str | None = Field(default=None)
    negativePrompt: str | None = Field(default=None)
    firstFrameVariantId: str | None = None
    lastFrameVariantId: str | None = None
    replicateKlingMode: str | None = None
    replicateKlingV3Mode: str | None = None
    wan27Resolution: str | None = None
    happyHorseResolution: str | None = None
    sora2Resolution: str | None = None
    selectedReferenceIds: list[str] = Field(default_factory=list, max_length=4)
    audioReferenceId: str | None = Field(default=None, max_length=120)
    preserveFrames: bool = True

    @field_validator("lumaModel")
    @classmethod
    def validate_luma_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="lumaModel", allowed=VIDEO_MODEL_IDS)

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, value: str) -> str:
        return _validate_choice(value, field_name="mode", allowed=VIDEO_MODE_IDS)

    @field_validator("replicateKlingMode")
    @classmethod
    def validate_replicate_kling_mode(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="replicateKlingMode", allowed=REPLICATE_KLING_MODE_IDS)

    @field_validator("replicateKlingV3Mode")
    @classmethod
    def validate_replicate_kling_v3_mode(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="replicateKlingV3Mode", allowed=REPLICATE_KLING_V3_MODE_IDS)

    @field_validator("wan27Resolution")
    @classmethod
    def validate_wan27_resolution(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="wan27Resolution", allowed=WAN27_RESOLUTION_IDS)

    @field_validator("happyHorseResolution")
    @classmethod
    def validate_happy_horse_resolution(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="happyHorseResolution", allowed=HAPPY_HORSE_RESOLUTION_IDS)

    @field_validator("sora2Resolution")
    @classmethod
    def validate_sora2_resolution(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="sora2Resolution", allowed=SORA2_RESOLUTION_IDS)


class CharacterAnimateGenerateRequest(BaseModel):
    mode: Literal["pose_video", "audio_driven"]
    model: Literal["runway_act_two", "kling_v3_motion_control", "seedance_2_0_reference_to_video", "omnihuman_v1_5"]
    characterReferenceId: str = Field(min_length=1, max_length=120)
    prompt: str | None = Field(default=None, max_length=2000)
    outputAspectRatio: Literal["1280:720", "720:1280", "960:960", "1104:832", "832:1104", "1584:672"] | None = None
    bodyControl: bool = True
    expressionIntensity: int = Field(default=3, ge=1, le=5)
    omnihumanResolution: Literal["720p", "1080p"] | None = None
    klingMode: Literal["std", "pro"] | None = None
    klingCharacterOrientation: Literal["image", "video"] | None = None
    seedanceResolution: Literal["480p", "720p", "1080p"] | None = None
    seedanceAspectRatio: Literal["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] | None = None


class SegmentPromptWizardRequest(BaseModel):
    selected_model: str = Field(min_length=1, max_length=120)
    provider: Literal["Luma", "fal.ai", "Runway", "Replicate", "Runware"]
    provider_model: str = Field(min_length=1, max_length=160)
    endpoint_used: str | None = Field(default=None, max_length=300)
    mode: Literal["start_video", "start_end", "edit_video"]
    user_draft_prompt: str = Field(min_length=1, max_length=4000)
    has_source_video: bool
    has_edited_first_frame: bool
    has_last_frame: bool
    app_required_markers: list[str] = Field(default_factory=list)
    supports_negative_prompt: bool = False
    duration_seconds: float | None = Field(default=None, ge=0, le=120)
    aspect_ratio: str | None = Field(default=None, max_length=16)
    luma_mode: Literal["adhere", "flex", "reimagine"] | None = None
    user_visible_model_name: str = Field(min_length=1, max_length=120)
    first_frame_variant_id: str | None = Field(default=None, max_length=120)
    selected_reference_ids: list[str] = Field(default_factory=list, max_length=4)

    @field_validator("supports_negative_prompt")
    @classmethod
    def validate_negative_prompt_support(cls, value: bool) -> bool:
        if value:
            raise ValueError("supports_negative_prompt must be false")
        return value


class ApiAssetUploadInitRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)
    assetType: Literal["image", "video"] = "image"


class ApiImageEditFullRequest(BaseModel):
    model: str
    prompt: str = Field(min_length=1)
    inputAssetKey: str = Field(min_length=1)
    referenceAssetKeys: list[str] = Field(default_factory=list, max_length=9)
    lumaUniModel: str | None = None
    lumaUniStyle: str | None = None
    lumaUniOutputFormat: str | None = None

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=FULL_EDIT_MODEL_IDS)

    @field_validator("lumaUniModel")
    @classmethod
    def validate_luma_uni_model(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="lumaUniModel", allowed=LUMA_UNI_MODEL_IDS)

    @field_validator("lumaUniStyle")
    @classmethod
    def validate_luma_uni_style(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="lumaUniStyle", allowed=LUMA_UNI_STYLE_IDS)

    @field_validator("lumaUniOutputFormat")
    @classmethod
    def validate_luma_uni_output_format(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="lumaUniOutputFormat", allowed=LUMA_UNI_OUTPUT_FORMAT_IDS)


class ApiImageEditPatchRequest(BaseModel):
    model: str
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
    referenceAssetKeys: list[str] = Field(default_factory=list, max_length=9)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=PATCH_EDIT_MODEL_IDS)


class ApiReferenceVideoGenerateRequest(BaseModel):
    model: str
    mode: str
    prompt: str | None = None
    negativePrompt: str | None = None
    videoAssetKey: str | None = None
    firstFrameAssetKey: str = Field(min_length=1)
    lastFrameAssetKey: str | None = None
    referenceAssetKeys: list[str] = Field(default_factory=list, max_length=9)
    durationSeconds: int | None = Field(default=None, ge=1, le=10)
    replicateKlingMode: str | None = None
    replicateKlingV3Mode: str | None = None
    wan27Resolution: str | None = None
    happyHorseResolution: str | None = None
    sora2Resolution: str | None = None
    preserveFrames: bool = True

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=VIDEO_MODEL_IDS)

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, value: str) -> str:
        return _validate_choice(value, field_name="mode", allowed=VIDEO_MODE_IDS)

    @field_validator("replicateKlingMode")
    @classmethod
    def validate_replicate_kling_mode(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="replicateKlingMode", allowed=REPLICATE_KLING_MODE_IDS)

    @field_validator("replicateKlingV3Mode")
    @classmethod
    def validate_replicate_kling_v3_mode(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="replicateKlingV3Mode", allowed=REPLICATE_KLING_V3_MODE_IDS)

    @field_validator("wan27Resolution")
    @classmethod
    def validate_wan27_resolution(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="wan27Resolution", allowed=WAN27_RESOLUTION_IDS)

    @field_validator("happyHorseResolution")
    @classmethod
    def validate_happy_horse_resolution(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="happyHorseResolution", allowed=HAPPY_HORSE_RESOLUTION_IDS)

    @field_validator("sora2Resolution")
    @classmethod
    def validate_sora2_resolution(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="sora2Resolution", allowed=SORA2_RESOLUTION_IDS)


class MergeGenerationAdjustment(BaseModel):
    startFrameOverride: int | None = Field(default=None, ge=0)
    sourceRestartFrame: int | None = Field(default=None, ge=0)
    trimStartFrames: int = Field(default=0, ge=0)
    trimEndFrames: int = Field(default=0, ge=0)
    playbackRate: float | None = Field(default=None, gt=0.05, le=20.0)
    cropEdgeFeather: CropEdgeFeatherRequest | None = None


class ReconcileTimingRequest(BaseModel):
    trimStartFrames: int = Field(default=0, ge=0)
    trimEndFrames: int = Field(default=0, ge=0)
    playbackRate: float | None = Field(default=None, gt=0.05, le=20.0)


class CropEdgeFeatherRequest(BaseModel):
    top: int = Field(default=0, ge=0, le=200)
    right: int = Field(default=0, ge=0, le=200)
    bottom: int = Field(default=0, ge=0, le=200)
    left: int = Field(default=0, ge=0, le=200)


class MergeRequest(BaseModel):
    selectedSegmentGenerationIds: list[str]
    temporalFeatherFrames: int | None = Field(default=None, ge=0, le=30)
    temporalFeatherStartFrames: int | None = Field(default=None, ge=0, le=30)
    temporalFeatherEndFrames: int | None = Field(default=None, ge=0, le=30)
    generationAdjustments: dict[str, MergeGenerationAdjustment] | None = None


class SegmentGenerationExtendRequest(BaseModel):
    alignmentFrameIndex: int = Field(ge=0)
    anchorFramesFromEnd: int = Field(default=5, ge=1, le=60)
    durationSeconds: int | None = Field(default=None, ge=1, le=15)
    prompt: str | None = None
    inputMode: Literal["start_video", "start_end", "start_only"] | None = None
    continueToRangeEnd: bool = False
    useSourceLastFrame: bool = True
    lastFrameVariantId: str | None = None


class SegmentGenerationLengthenRequest(BaseModel):
    model: str
    direction: Literal["start", "end"] = "end"
    durationSeconds: int = Field(ge=1, le=20)
    prompt: str = Field(min_length=1, max_length=4000)
    inputMode: Literal["start_end", "edit_video"]
    selectedReferenceIds: list[str] = Field(default_factory=list, max_length=9)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=VIDEO_MODEL_IDS)


class ChunkedSegmentGenerateRequest(BaseModel):
    lumaModel: str = "ray-2"
    mode: str
    openingPrompt: str | None = Field(default=None)
    continuationPrompt: str | None = Field(default=None)
    firstFrameVariantId: str | None = None
    replicateKlingMode: str | None = None
    replicateKlingV3Mode: str | None = None
    wan27Resolution: str | None = None
    preserveFrames: bool = True

    @field_validator("lumaModel")
    @classmethod
    def validate_luma_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="lumaModel", allowed=VIDEO_MODEL_IDS)

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, value: str) -> str:
        return _validate_choice(value, field_name="mode", allowed=VIDEO_MODE_IDS)

    @field_validator("replicateKlingMode")
    @classmethod
    def validate_replicate_kling_mode(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="replicateKlingMode", allowed=REPLICATE_KLING_MODE_IDS)

    @field_validator("replicateKlingV3Mode")
    @classmethod
    def validate_replicate_kling_v3_mode(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="replicateKlingV3Mode", allowed=REPLICATE_KLING_V3_MODE_IDS)

    @field_validator("wan27Resolution")
    @classmethod
    def validate_wan27_resolution(cls, value: str | None) -> str | None:
        if value is None:
            return value
        return _validate_choice(value, field_name="wan27Resolution", allowed=WAN27_RESOLUTION_IDS)


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


class ExportTopazUpscaleRequest(BaseModel):
    force: bool = False
    model: str = "Proteus"
    preset: str = "balanced"
    upscaleFactor: float = Field(default=1.0, ge=1.0, le=4.0)
    targetFps: int | None = Field(default=None, ge=16, le=60)
    h264Output: bool = False

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=TOPAZ_VIDEO_MODEL_IDS)

    @field_validator("preset")
    @classmethod
    def validate_preset(cls, value: str) -> str:
        return _validate_choice(value, field_name="preset", allowed=TOPAZ_UPSCALE_PRESET_IDS)


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
    model: str
    mode: str = Field(min_length=1, max_length=120)
    inputMode: Literal["start_video", "start_end", "start_only", "edit_video"] | None = None
    prompt: str | None = None
    negativePrompt: str | None = None
    firstFrameVariantId: str | None = None
    lastFrameVariantId: str | None = None

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return _validate_choice(value, field_name="model", allowed=VIDEO_MODEL_IDS)


class VariantSelectRequest(BaseModel):
    ok: bool = True


class AssetDeleteRequest(BaseModel):
    assetType: Literal["upload", "frame_capture", "frame_variant", "segment_generation", "export", "edit_video_reference", "generation_audio_reference"]
    frameId: str | None = None
    variantId: str | None = None
    genId: str | None = None
    exportId: str | None = None
    referenceId: str | None = None


class GenerationAudioReferenceUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)
    sizeBytes: int | None = Field(default=None, ge=0)


class GenerationAudioReferenceUploadCompleteRequest(BaseModel):
    referenceId: str = Field(min_length=1, max_length=120)
    uploadKey: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=255)


class CustomReportOutputRef(BaseModel):
    assetType: Literal["frame_variant", "segment_generation", "export", "external_frame_pair"]
    frameId: str | None = None
    variantId: str | None = None
    genId: str | None = None
    exportId: str | None = None
    pairId: str | None = None


class CustomReportCreateRequest(BaseModel):
    reportType: Literal["qc_frame", "qc_video", "video_compare", "previz_review"]
    outputRefs: list[CustomReportOutputRef] = Field(min_length=1, max_length=400)
    tests: list[str] = Field(min_length=1, max_length=20)
    name: str | None = Field(default=None, min_length=1, max_length=80)


class TaskFrameVariant(BaseModel):
    variantId: str
    type: Literal["full", "patch", "extension_anchor"]
    model: Literal[
        "nano_banana",
        "nano_banana_pro",
        "chatgpt",
        "chatgpt_latest",
        "luma_uni_1",
        "luma_uni_1_max",
        "luma_uni_1_1",
        "runware_flux_fill",
        "runware_ace_pp",
        "generated_extension_anchor",
    ]
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
    workflowId: str | None = None
    createdAt: datetime
    updatedAt: datetime
    status: Literal["created", "ingesting", "ready", "error"]
    video: dict[str, Any] = Field(default_factory=dict)
    sourceMedia: dict[str, Any] = Field(default_factory=dict)
    segments: list[dict[str, Any]] = Field(default_factory=list)
    frames: dict[str, TaskFrame] = Field(default_factory=dict)
    segmentGenerations: dict[str, Any] = Field(default_factory=dict)
    chunkedGenerationRuns: list[dict[str, Any]] = Field(default_factory=list)
    externalQcPairs: list[dict[str, Any]] = Field(default_factory=list)
    qualityMatchAnalyses: dict[str, Any] = Field(default_factory=dict)
    videoCleanupTracks: list[dict[str, Any]] = Field(default_factory=list)
    editVideoReferences: list[dict[str, Any]] = Field(default_factory=list)
    exports: list[dict[str, Any]] = Field(default_factory=list)
    customReports: list[dict[str, Any]] = Field(default_factory=list)
    history: list[dict[str, Any]] = Field(default_factory=list)
    previz: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

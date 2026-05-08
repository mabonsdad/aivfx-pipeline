from typing import Literal
from typing_extensions import NotRequired, TypedDict

# Canonical API/request-response identifiers shared between backend validation
# and generated frontend contract types.
TASK_STATUS_IDS: tuple[str, ...] = (
    "created",
    "ingesting",
    "ready",
    "error",
)

JOB_STATUS_IDS: tuple[str, ...] = (
    "queued",
    "running",
    "complete",
    "failed",
)

ASSET_UPLOAD_TYPE_IDS: tuple[str, ...] = ("image", "video")
SEGMENT_CROP_ASPECT_IDS: tuple[str, ...] = ("16:9", "9:16")
ASSET_DELETE_TYPE_IDS: tuple[str, ...] = (
    "upload",
    "frame_capture",
    "frame_variant",
    "segment_generation",
    "export",
)
CUSTOM_REPORT_OUTPUT_ASSET_TYPE_IDS: tuple[str, ...] = (
    "frame_variant",
    "segment_generation",
    "export",
    "external_frame_pair",
)
CUSTOM_REPORT_TYPE_IDS: tuple[str, ...] = (
    "qc_frame",
    "qc_video",
    "video_compare",
)
MANUAL_REFINE_EXPORT_FORMAT_IDS: tuple[str, ...] = ("psd", "png_zip")
QC_EDGE_SUPPRESSION_IDS: tuple[str, ...] = ("off", "low", "medium", "high")
QC_SAM_PROMPT_TYPE_IDS: tuple[str, ...] = ("points", "box")
QC_EDGE_BIAS_IDS: tuple[str, ...] = ("conservative", "balanced", "inclusive")
LUMA_UNI_MODEL_IDS: tuple[str, ...] = ("uni-1", "uni-1-max")
LUMA_UNI_STYLE_IDS: tuple[str, ...] = ("auto", "manga")
LUMA_UNI_OUTPUT_FORMAT_IDS: tuple[str, ...] = ("png", "jpeg")
TOPAZ_VIDEO_MODEL_IDS: tuple[str, ...] = (
    "Proteus",
    "Artemis HQ",
    "Nyx Fast",
    "Starlight Sharp",
)
TOPAZ_UPSCALE_PRESET_IDS: tuple[str, ...] = (
    "balanced",
    "recover_detail",
    "fast_sharpen",
)


class PatchRectPayload(TypedDict):
    x: int
    y: int
    width: int
    height: int


class SegmentGeneratePayload(TypedDict):
    lumaModel: str
    mode: str
    preserveFrames: NotRequired[bool]
    prompt: NotRequired[str | None]
    negativePrompt: NotRequired[str | None]
    firstFrameVariantId: NotRequired[str | None]
    lastFrameVariantId: NotRequired[str | None]
    replicateKlingMode: NotRequired[str | None]
    replicateKlingV3Mode: NotRequired[str | None]
    wan27Resolution: NotRequired[str | None]
    happyHorseResolution: NotRequired[str | None]
    sora2Resolution: NotRequired[str | None]


class ChunkedSegmentGeneratePayload(TypedDict):
    lumaModel: str
    mode: str
    preserveFrames: NotRequired[bool]
    openingPrompt: NotRequired[str | None]
    continuationPrompt: NotRequired[str | None]
    firstFrameVariantId: NotRequired[str | None]
    replicateKlingMode: NotRequired[str | None]
    replicateKlingV3Mode: NotRequired[str | None]
    wan27Resolution: NotRequired[str | None]


class SegmentGenerationExtendPayload(TypedDict):
    alignmentFrameIndex: int
    anchorFramesFromEnd: int
    durationSeconds: NotRequired[int | None]
    prompt: NotRequired[str | None]


class ReconcileTimingPayload(TypedDict):
    trimStartFrames: int
    trimEndFrames: int
    playbackRate: NotRequired[float | None]


class ExportTopazUpscalePayload(TypedDict):
    force: NotRequired[bool]
    model: NotRequired[str]
    preset: NotRequired[str]
    upscaleFactor: NotRequired[float]
    targetFps: NotRequired[int | None]
    h264Output: NotRequired[bool]


class CropEdgeFeatherPayload(TypedDict):
    top: int
    right: int
    bottom: int
    left: int


class MergeGenerationAdjustmentPayload(TypedDict):
    trimStartFrames: int
    trimEndFrames: int
    startFrameOverride: NotRequired[int | None]
    playbackRate: NotRequired[float | None]
    cropEdgeFeather: NotRequired[CropEdgeFeatherPayload | None]


class MergePayload(TypedDict):
    selectedSegmentGenerationIds: list[str]
    temporalFeatherFrames: int
    generationAdjustments: NotRequired[dict[str, MergeGenerationAdjustmentPayload] | None]


class ApiAssetUploadInitPayload(TypedDict):
    filename: str
    contentType: str
    assetType: Literal["image", "video"]


class ApiImageEditFullPayload(TypedDict):
    model: str
    prompt: str
    inputAssetKey: str
    lumaUniModel: NotRequired[Literal["uni-1", "uni-1-max"] | None]
    lumaUniStyle: NotRequired[Literal["auto", "manga"] | None]
    lumaUniOutputFormat: NotRequired[Literal["png", "jpeg"] | None]


class ApiImageEditPatchPayload(TypedDict):
    model: str
    prompt: str
    inputAssetKey: str
    patchAssetKey: str
    patchRect: PatchRectPayload
    featherPx: int
    bleedPx: int
    runwareRepaintingScale: float
    edgeAwareRefine: bool
    edgeAwareStrength: float
    edgeAwareRadiusPx: int
    maskGrowPx: int
    maskAssetKey: NotRequired[str | None]
    referenceAssetKey: NotRequired[str | None]


class ApiReferenceVideoGeneratePayload(TypedDict):
    model: str
    mode: str
    firstFrameAssetKey: str
    preserveFrames: NotRequired[bool]
    prompt: NotRequired[str | None]
    negativePrompt: NotRequired[str | None]
    videoAssetKey: NotRequired[str | None]
    lastFrameAssetKey: NotRequired[str | None]
    durationSeconds: NotRequired[int | None]
    replicateKlingMode: NotRequired[str | None]
    replicateKlingV3Mode: NotRequired[str | None]
    wan27Resolution: NotRequired[str | None]
    happyHorseResolution: NotRequired[str | None]
    sora2Resolution: NotRequired[str | None]


class AssetDeletePayload(TypedDict):
    assetType: Literal["upload", "frame_capture", "frame_variant", "segment_generation", "export"]
    frameId: NotRequired[str | None]
    variantId: NotRequired[str | None]
    genId: NotRequired[str | None]
    exportId: NotRequired[str | None]


class CustomReportOutputRefPayload(TypedDict):
    assetType: Literal["frame_variant", "segment_generation", "export", "external_frame_pair"]
    frameId: NotRequired[str | None]
    variantId: NotRequired[str | None]
    genId: NotRequired[str | None]
    exportId: NotRequired[str | None]
    pairId: NotRequired[str | None]


class CustomReportCreatePayload(TypedDict):
    reportType: Literal["qc_frame", "qc_video", "video_compare"]
    outputRefs: list[CustomReportOutputRefPayload]
    tests: list[str]
    name: NotRequired[str | None]

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class VideoCleanupSettingsRequest(BaseModel):
    maskFeatherPx: int = Field(default=6, ge=0, le=48)
    maskHardness: float = Field(default=0.7, ge=0.0, le=1.0)
    restoreStrength: float = Field(default=1.0, ge=0.0, le=1.0)
    maskDilatePx: int = Field(default=0, ge=0, le=64)
    maskErodePx: int = Field(default=0, ge=0, le=64)
    temporalSmoothingRadius: int = Field(default=1, ge=0, le=3)
    autoSuggestCorrections: bool = True
    suspiciousFrameThreshold: float = Field(default=0.12, ge=0.01, le=1.0)
    previewBurnInMask: bool = True
    previewCheckerOutsideMask: bool = False
    clampToSegmentBounds: bool = True
    trackingDensity: Literal["standard", "high_motion", "frame_by_frame"] = "standard"


class VideoCleanupFirstMaskSourceRequest(BaseModel):
    type: Literal["quality_match_analysis"]
    analysisId: str = Field(min_length=1)


class VideoCleanupCreateRequest(BaseModel):
    firstMaskSource: VideoCleanupFirstMaskSourceRequest
    settings: VideoCleanupSettingsRequest | None = None


class VideoCleanupKeyframeUploadInitRequest(BaseModel):
    frameIndexLocal: int = Field(ge=0)
    filename: str = Field(min_length=1, max_length=255)
    contentType: str = Field(min_length=1, max_length=120)


class VideoCleanupKeyframeUploadCompleteRequest(BaseModel):
    frameIndexLocal: int = Field(ge=0)
    uploadKey: str = Field(min_length=1)
    propagationMode: Literal["windowed", "forward", "backward", "bidirectional"] = "windowed"


class VideoCleanupPoint(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)


class VideoCleanupBox(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class VideoCleanupSamAssistRequest(BaseModel):
    frameIndexLocal: int = Field(ge=0)
    positivePoints: list[VideoCleanupPoint] = Field(default_factory=list, max_length=32)
    negativePoints: list[VideoCleanupPoint] = Field(default_factory=list, max_length=32)
    box: VideoCleanupBox | None = None
    existingMaskKey: str | None = None
    restrictToMaskBounds: bool = True
    edgeBias: Literal["conservative", "balanced", "inclusive"] = "balanced"
    propagationMode: Literal["windowed", "forward", "backward", "bidirectional"] = "windowed"


class VideoCleanupPreviewRequest(BaseModel):
    settings: VideoCleanupSettingsRequest | None = None


class VideoCleanupApplyRequest(BaseModel):
    settings: VideoCleanupSettingsRequest | None = None
    createSegmentGenerationVariant: bool = True

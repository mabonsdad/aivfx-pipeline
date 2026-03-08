export type TaskSummary = {
  taskId: string;
  name: string;
  status: "created" | "ingesting" | "ready" | "error";
  createdAt: string;
  updatedAt: string;
  video?: Record<string, unknown>;
};

export type FrameVariant = {
  variantId: string;
  type: "full" | "patch";
  model: "nano_banana" | "nano_banana_pro" | "chatgpt" | "runware_flux_fill" | "runware_ace_pp";
  promptHash: string;
  createdAt: string;
  outputKey: string;
  imageUrl?: string;
  patchMeta?: {
    patchRect?: { x: number; y: number; width: number; height: number };
    featherPx?: number;
    bleedPx?: number;
    maskKey?: string;
    maskUrl?: string;
    patchOnlyKey?: string;
    patchOnlyUrl?: string;
    referenceImageKey?: string;
    referenceImageUrl?: string;
    [key: string]: unknown;
  };
  generationSettings?: {
    provider?: string;
    workflow?: string;
    inputResolution?: { width: number; height: number };
    outputResolution?: { width: number; height: number };
    compositedResolution?: { width: number; height: number };
    featherPx?: number;
    bleedPx?: number;
    hasMask?: boolean;
    runwareRepaintingScale?: number;
    [key: string]: unknown;
  };
  qualityMatch?: {
    appliedAt?: string;
    analysisId?: string;
    finalMaskKey?: string;
    finalMaskUrl?: string;
    finalKey?: string;
    finalUrl?: string;
    reportJsonKey?: string;
    reportJsonUrl?: string;
    [key: string]: unknown;
  };
};

export type QualityMatchStatus = {
  qcReviewed: boolean;
  qualityMatched: boolean;
  qualityMatchVersion?: string;
  qualityMatchAppliedAt?: string;
  qualityMatchAppliedBy?: string;
  qualityMatchSourceAnalysisId?: string;
  qualityMatchOriginalMaskProvided?: boolean;
  qualityMatchUserEditedMask?: boolean;
  qualityMatchMetrics?: {
    changedPctBefore?: number | null;
    changedPctAfter?: number | null;
    outsideLeakageBefore?: number | null;
    outsideLeakageAfter?: number | null;
    boundarySpillBefore?: number | null;
    boundarySpillAfter?: number | null;
  };
  qualityMatchArtifacts?: {
    alignedGeneratedKey?: string;
    alignedGeneratedUrl?: string;
    diffHeatmapKey?: string;
    diffHeatmapUrl?: string;
    binaryChangeMaskKey?: string;
    binaryChangeMaskUrl?: string;
    proposedMergeMaskKey?: string;
    proposedMergeMaskUrl?: string;
    restorationMapKey?: string;
    restorationMapUrl?: string;
    previewKey?: string;
    previewUrl?: string;
    finalKey?: string;
    finalUrl?: string;
    reportJsonKey?: string;
    reportJsonUrl?: string;
    [key: string]: unknown;
  };
};

export type QualityMatchAnalysis = {
  analysisId: string;
  frameId: string;
  variantId: string;
  createdAt: string;
  updatedAt?: string;
  originalMaskProvided?: boolean;
  userMaskProvided?: boolean;
  warnings?: string[];
  metrics?: Record<string, number | string | null | undefined>;
  settings?: Record<string, unknown>;
  artifacts?: {
    alignedGeneratedKey?: string;
    alignedGeneratedUrl?: string;
    diffHeatmapKey?: string;
    diffHeatmapUrl?: string;
    binaryChangeMaskKey?: string;
    binaryChangeMaskUrl?: string;
    proposedMergeMaskKey?: string;
    proposedMergeMaskUrl?: string;
    restorationMapKey?: string;
    restorationMapUrl?: string;
    previewKey?: string;
    previewUrl?: string;
    finalKey?: string;
    finalUrl?: string;
    reportJsonKey?: string;
    reportJsonUrl?: string;
  };
};

export type FrameRecord = {
  frameId: string;
  frameIndex: number;
  timecode: string;
  captureKey: string;
  createdAt?: string;
  imageUrl?: string;
  variants: FrameVariant[];
  selectedVariantId?: string | null;
  qcReviewed?: boolean;
  qualityMatched?: boolean;
  qualityMatchStatus?: QualityMatchStatus | null;
};

export type SegmentRecord = {
  segmentId: string;
  startFrame: number;
  endFrameExclusive: number;
  durationFrames: number;
  durationSec: number;
  startTimecode: string;
  endTimecode: string;
  startFrameId: string;
  endFrameId: string;
  selectedGenerationId?: string | null;
};

export type SegmentGeneration = {
  genId: string;
  segmentId: string;
  luma: {
    provider?: "luma" | "runway" | "kling" | "runware";
    model:
      | "ray-2"
      | "ray-flash-2"
      | "runway-gen4.5"
      | "kling-2.6"
      | "veo-3.1"
      | "veo-3.1-fast"
      | "wan2.2-a14b"
      | "wan2.2-animate";
    mode: string;
    prompt?: string;
    lumaGenerationId?: string | null;
  };
  status: "queued" | "running" | "complete" | "failed";
  outputKey?: string | null;
  createdAt: string;
  downloadUrl?: string;
  inputMediaKey?: string | null;
  inputMediaUrl?: string;
  inputFirstFrameKey?: string | null;
  inputFirstFrameUrl?: string;
  inputLastFrameKey?: string | null;
  inputLastFrameUrl?: string;
  sourceFirstFrameCaptureKey?: string | null;
  sourceFirstFrameCaptureUrl?: string;
  sourceFirstFrameVariantId?: string | null;
  sourceFirstFrameResolvedKey?: string | null;
  sourceLastFrameCaptureKey?: string | null;
  sourceLastFrameCaptureUrl?: string;
  sourceLastFrameVariantId?: string | null;
  sourceLastFrameResolvedKey?: string | null;
  requestedDurationSec?: number;
  providerDurationSec?: number | null;
  generationSettings?: {
    provider?: string;
    model?: string;
    mode?: string;
    firstFrameResolution?: { width: number; height: number };
    mediaResolution?: { width: number; height: number } | null;
    requestedDurationSec?: number;
    providerDurationSec?: number | null;
    [key: string]: unknown;
  };
  qc?: {
    status: "running" | "complete" | "failed" | "skipped";
    updatedAt?: string;
    analyzedAt?: string;
    error?: string;
    reason?: string;
    frame?: {
      metrics?: Record<string, number | string | null>;
      artifacts?: {
        heatmapKey?: string;
        heatmapUrl?: string;
        overlayKey?: string;
        overlayUrl?: string;
        binaryChangeKey?: string;
        binaryChangeUrl?: string;
        boundaryOverlayKey?: string;
        boundaryOverlayUrl?: string;
        [key: string]: unknown;
      };
    };
    frameByVariant?: Record<
      string,
      {
        metrics?: Record<string, number | string | null>;
        artifacts?: {
          heatmapKey?: string;
          heatmapUrl?: string;
          overlayKey?: string;
          overlayUrl?: string;
          binaryChangeKey?: string;
          binaryChangeUrl?: string;
          boundaryOverlayKey?: string;
          boundaryOverlayUrl?: string;
          [key: string]: unknown;
        };
      }
    >;
    video?: {
      aggregates?: Record<string, number | string | boolean | null | Record<string, number | null>>;
      selectedFrames?: Array<{
        index: number;
        timeSec: number;
        changedPctTotal?: number;
        outsideLeakagePct?: number | null;
        heatmapKey?: string;
        heatmapUrl?: string;
        overlayKey?: string;
        overlayUrl?: string;
        binaryChangeKey?: string;
        binaryChangeUrl?: string;
      }>;
      artifacts?: {
        diffVideoKey?: string;
        diffVideoUrl?: string;
        timelineCsvKey?: string;
        timelineCsvUrl?: string;
        timelineGraphKey?: string;
        timelineGraphUrl?: string;
        reportJsonKey?: string;
        reportJsonUrl?: string;
        [key: string]: unknown;
      };
    };
  };
};

export type ExportRecord = {
  exportId: string;
  outputKey: string;
  createdAt: string;
  downloadUrl?: string;
};

export type CustomReportOutputRef =
  | { assetType: "frame_variant"; frameId: string; variantId: string }
  | { assetType: "segment_generation"; genId: string };

export type CustomReportRecord = {
  reportId: string;
  reportType: "qc_frame" | "qc_video";
  name: string;
  outputRefs: CustomReportOutputRef[];
  createdAt: string;
  updatedAt: string;
};

export type TaskDetail = {
  taskId: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: "created" | "ingesting" | "ready" | "error";
  video: {
    original?: {
      s3Key: string;
      filename: string;
      sizeBytes: number;
      sha256?: string | null;
      downloadUrl?: string;
    };
    editSource?: {
      s3Key: string;
      fps: { num: number; den: number };
      frameCount: number;
      durationSec: number;
      width: number;
      height: number;
      isVfrInput: boolean;
      downloadUrl?: string;
    };
    previewSource?: {
      s3Key: string;
      frameCount: number;
      durationSec: number;
      width: number;
      height: number;
      downloadUrl?: string;
    };
  };
  segments: SegmentRecord[];
  frames: Record<string, FrameRecord>;
  segmentGenerations: Record<string, SegmentGeneration>;
  qualityMatchAnalyses?: Record<string, QualityMatchAnalysis>;
  exports: ExportRecord[];
  customReports?: CustomReportRecord[];
};

export type JobStatus = {
  jobId: string;
  userId: string;
  taskId: string;
  type: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  createdAt?: string;
  updatedAt?: string;
  logs?: Array<{ at: string; message: string }>;
  error?: string;
  resultRefs?: Record<string, unknown>;
};

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
  type: "full" | "patch" | "extension_anchor";
  variantKind?: "edited" | "refined";
  sourceVariantId?: string | null;
  refinedVariantIds?: string[];
  model:
    | "nano_banana"
    | "nano_banana_pro"
    | "chatgpt"
    | "chatgpt_latest"
    | "runware_flux_fill"
    | "runware_ace_pp"
    | "generated_extension_anchor"
    | "manual_upload";
  promptHash: string;
  createdAt: string;
  jobId?: string | null;
  startedAt?: string;
  finishedAt?: string;
  processingDurationSec?: number;
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

export type VideoCleanupSettings = {
  maskFeatherPx: number;
  maskHardness: number;
  restoreStrength: number;
  maskDilatePx: number;
  maskErodePx: number;
  temporalSmoothingRadius: number;
  autoSuggestCorrections: boolean;
  suspiciousFrameThreshold: number;
  previewBurnInMask: boolean;
  previewCheckerOutsideMask: boolean;
  clampToSegmentBounds: boolean;
  trackingDensity: "standard" | "high_motion" | "frame_by_frame";
};

export type VideoCleanupPreviewManifestFrame = {
  frameIndexLocal: number;
  maskKey?: string;
  maskUrl?: string;
  overlayKey?: string;
  overlayUrl?: string;
  checkerKey?: string;
  checkerUrl?: string;
  cleanedKey?: string;
  cleanedUrl?: string;
  generatedFrameKey?: string;
  generatedFrameUrl?: string;
  sourceFrameKey?: string;
  sourceFrameUrl?: string;
  coveragePct?: number | null;
  suspicionScore?: number | null;
  suggestedCorrection?: boolean;
};

export type VideoCleanupTrack = {
  trackId: string;
  taskId: string;
  segmentId: string;
  generationId: string;
  status: "created" | "preparing" | "tracking" | "review_ready" | "applying" | "complete" | "failed";
  error?: string;
  source: {
    editSourceKey: string;
    editSourceUrl?: string;
    generatedSegmentKey: string;
    generatedSegmentUrl?: string;
    startFrameIndex: number;
    endFrameExclusive: number;
    fpsNum: number;
    fpsDen: number;
    width: number;
    height: number;
    frameCount: number;
    sourceFirstFrameVariantId?: string | null;
    sourceFirstFrameId?: string | null;
  };
  seed: {
    firstFrameIndexLocal: number;
    firstMaskKey: string;
    firstMaskUrl?: string;
    lastFrameIndexLocal?: number;
    lastMaskKey?: string;
    lastMaskUrl?: string;
    sourceFrameVariantId?: string | null;
    generatedFirstFrameVariantId?: string | null;
    firstMaskSource?: {
      type: "quality_match_analysis";
      analysisId: string;
    };
  };
  settings: VideoCleanupSettings;
  tracking: {
    samProvider: "fal_sam2";
    propagationRuns: Array<{
      runId: string;
      startFrameLocal: number;
      endFrameLocal: number;
      seedKeyframeIds: string[];
      direction: "forward" | "backward" | "bidirectional" | "windowed" | string;
      outputMasksPrefix?: string;
      status: "queued" | "running" | "complete" | "failed";
      warnings?: string[];
      metrics?: {
        frameCount: number;
        meanAreaPct: number;
        areaVariance: number;
        meanBoundaryMotionPx: number;
        suspiciousFrames: number[];
      };
    }>;
    keyframes: Array<{
      id: string;
      frameIndexLocal: number;
      maskKey: string;
      maskUrl?: string;
      source: "seed_first" | "seed_last" | "user_edit" | "auto_promoted" | string;
      note?: string;
      createdAt: string;
    }>;
    currentMasks?: Array<{
      frameIndexLocal: number;
      maskKey: string;
      maskUrl?: string;
    }>;
    coverageSummary?: {
      meanCoveragePct: number;
      minCoveragePct: number;
      maxCoveragePct: number;
      suspiciousFrames: number[];
    };
    frameDiagnostics?: Array<{
      frameIndexLocal: number;
      coveragePct?: number;
      suspicionScore?: number;
      centroidJumpPx?: number;
      outsideMaskDiff?: number;
      [key: string]: unknown;
    }>;
  };
  review: {
    previewVideoKey?: string;
    previewVideoUrl?: string;
    generatedPreviewKey?: string;
    generatedPreviewUrl?: string;
    cleanedPreviewKey?: string;
    cleanedPreviewUrl?: string;
    previewManifestKey?: string;
    previewManifestUrl?: string;
    overlayStripKey?: string;
    overlayStripUrl?: string;
    checkerVideoKey?: string;
    checkerVideoUrl?: string;
    suggestedCorrectionFrames?: number[];
    approved: boolean;
    approvedAt?: string;
    previewManifest?: {
      frameCount: number;
      frames: VideoCleanupPreviewManifestFrame[];
    };
  };
  apply: {
    outputSegmentKey?: string;
    outputSegmentUrl?: string;
    previewOutputKey?: string;
    previewOutputUrl?: string;
    reportJsonKey?: string;
    reportJsonUrl?: string;
    metrics?: {
      meanGeneratedCoveragePct: number;
      meanOriginalRestorePct: number;
      meanBoundaryWidthPx: number;
      suspiciousFrameCount: number;
      outputDurationSec: number;
    };
  };
  createdAt: string;
  updatedAt: string;
};

export type FrameRecord = {
  frameId: string;
  frameIndex: number;
  timecode: string;
  captureKey: string;
  width?: number;
  height?: number;
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
  segmentClipKey?: string;
  segmentClipUrl?: string;
  internalOnly?: boolean;
  crop?: {
    enabled: boolean;
    aspect: "16:9" | "9:16";
    x: number;
    y: number;
    width: number;
    height: number;
    featherPx?: number;
    outputWidth?: number;
    outputHeight?: number;
  } | null;
};

export type SegmentGeneration = {
  genId: string;
  segmentId: string;
  luma: {
    provider?: "luma" | "runway" | "kling" | "runware" | "replicate" | "fal";
    model:
      | "ray-2"
      | "ray-flash-2"
      | "runway-gen4.5"
      | "runway-gen4-aleph"
      | "kling-2.6"
      | "kling-o1"
      | "kling-v3-omni-video"
      | "seedance-2.0-reference-to-video"
      | "veo-3.1"
      | "veo-3.1-fast"
      | "wan2.2-a14b"
      | "wan2.2-animate"
      | "wan2.7-videoedit";
    mode: string;
    prompt?: string;
    lumaGenerationId?: string | null;
  };
  status: "queued" | "running" | "complete" | "failed";
  isChunkInternal?: boolean;
  chunkedRunId?: string | null;
  chunkRole?: "internal_chunk" | "draft_stitched" | string | null;
  jobId?: string | null;
  error?: string | null;
  outputKey?: string | null;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  processingDurationSec?: number;
  downloadUrl?: string;
  parentGenerationId?: string | null;
  extension?: {
    parentGenerationId?: string;
    alignmentFrameIndex?: number;
    anchorFramesFromEnd?: number;
    anchorVariantId?: string;
    sourceGeneratedFrameIndex?: number;
    previousSegmentId?: string;
    createdAt?: string;
  } | null;
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
  sourceFrameOffset?: number;
  alignment?: {
    sourceFrameOffset?: number;
    confidence?: number;
    score?: number;
    runnerUpScore?: number;
    method?: string;
    anchorFrames?: number[];
    anchorCount?: number;
    sourceFrameSteps?: number[];
    scanFrameCount?: number;
  } | null;
  cleanupTrackId?: string;
  derivedFromGenerationId?: string;
  generationSettings?: {
    provider?: string;
    model?: string;
    mode?: string;
    firstFrameResolution?: { width: number; height: number };
    mediaResolution?: { width: number; height: number } | null;
    requestedDurationSec?: number;
    providerDurationSec?: number | null;
    sourceSegmentTiming?: {
      startFrame?: number;
      endFrameExclusive?: number;
      durationFrames?: number;
      durationSec?: number;
      fps?: { num: number; den: number };
      width?: number;
      height?: number;
    } | null;
    providerInputTiming?: {
      durationSec?: number;
      fps?: { num: number; den: number };
      width?: number;
      height?: number;
    } | null;
    providerOutputRaw?: {
      width?: number;
      height?: number;
      fps?: { num: number; den: number };
      durationSec?: number;
      frameCount?: number;
      isVfr?: boolean;
    } | null;
    storedOutput?: {
      width?: number;
      height?: number;
      fps?: { num: number; den: number };
      durationSec?: number;
      frameCount?: number;
      isVfr?: boolean;
    } | null;
    timelineAlignment?: {
      sourceFrameOffset?: number;
      confidence?: number;
      score?: number;
      runnerUpScore?: number;
      method?: string;
      anchorFrames?: number[];
      anchorCount?: number;
      sourceFrameSteps?: number[];
      scanFrameCount?: number;
    } | null;
    timelineConform?: {
      policy?: string;
      applied?: boolean;
      durationDeltaSec?: number;
      frameDelta?: number;
      fpsConformed?: boolean;
      resolutionConformed?: boolean;
    } | null;
    [key: string]: unknown;
  };
};

export type ChunkedGenerationChunk = {
  chunkIndex: number;
  segmentId: string;
  segmentStartFrame: number;
  segmentEndFrameExclusive: number;
  segmentDurationFrames: number;
  segmentDurationSec: number;
  relativeStartFrame: number;
  relativeEndFrameExclusive: number;
  coverageStartFrame?: number;
  coverageEndFrameExclusive?: number;
  coverageDurationFrames?: number;
  coverageTrimStartFrames?: number;
  coverageTrimEndFrames?: number;
  overlapFrames: number;
  anchorFramesFromPrevious: number;
  alignmentFrameIndex: number;
  anchorSource: "initial_variant" | "previous_generation" | string;
  anchorFrameId?: string | null;
  anchorVariantId?: string | null;
  sourceGeneratedFrameIndex?: number | null;
  actualOutputStartFrame?: number | null;
  actualCoverageTrimStartFrames?: number | null;
  generationId?: string | null;
  jobId?: string | null;
  status: "planned" | "queued" | "running" | "complete" | "failed";
  reviewStatus?: "pending" | "running" | "complete" | "needs_retry" | string;
  prompt?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt?: string;
  queuedAt?: string;
  finishedAt?: string;
};

export type ChunkedGenerationRun = {
  runId: string;
  sourceSegmentId: string;
  status: "created" | "running" | "paused" | "failed" | "complete" | "canceled";
  model:
    | "ray-2"
    | "ray-flash-2"
    | "runway-gen4-aleph"
    | "kling-o1"
    | "kling-v3-omni-video"
    | "seedance-2.0-reference-to-video"
    | "wan2.2-animate"
    | "wan2.7-videoedit";
  mode: string;
  openingPrompt?: string | null;
  continuationPrompt?: string | null;
  firstFrameVariantId?: string | null;
  replicateKlingMode?: "std" | "pro" | null;
  replicateKlingV3Mode?: "standard" | "pro" | null;
  wan27Resolution?: "720p" | "1080p" | null;
  chunkDurationSec: number;
  minimumOverlapFrames: number;
  activeChunkIndex?: number;
  failureChunkIndex?: number;
  pauseRequestedAt?: string;
  pauseReason?: string;
  saveStatus?: "idle" | "queued" | "running" | "complete" | "failed";
  savedGenerationId?: string | null;
  saveJobId?: string | null;
  saveError?: string | null;
  canceledAt?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  chunks: ChunkedGenerationChunk[];
};

export type ExportRecord = {
  exportId: string;
  outputKey: string;
  createdAt: string;
  downloadUrl?: string;
  motionSyncQc?: {
    status: "queued" | "running" | "complete" | "failed";
    updatedAt?: string;
    analyzedAt?: string;
    jobId?: string;
    error?: string;
    metrics?: {
      sampleFps?: number;
      maxLagSec?: number;
      analyzedDurationSec?: number;
      sampleCount?: number;
      baselineCorrelation?: number;
      bestCorrelation?: number;
      correlationGain?: number;
      confidence?: number;
      bestOffsetSamples?: number;
      bestOffsetSec?: number;
      recommendedShiftFrames?: number;
      recommendedShiftSec?: number;
      recommendation?: "no_shift" | "shift_later" | "shift_earlier" | string;
      [key: string]: unknown;
    };
    artifacts?: {
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

export type CustomReportOutputRef =
  | { assetType: "frame_variant"; frameId: string; variantId: string }
  | { assetType: "segment_generation"; genId: string }
  | { assetType: "external_frame_pair"; pairId: string };

export type CustomReportRecord = {
  reportId: string;
  reportType: "qc_frame" | "qc_video" | "video_compare";
  name: string;
  assetRefs: CustomReportOutputRef[];
  tests: string[];
  status: "queued" | "running" | "complete" | "failed";
  jobId?: string;
  resultKey?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type QcReportResult = {
  reportId: string;
  taskId: string;
  reportType: "qc_frame" | "qc_video" | "video_compare";
  name: string;
  tests: string[];
  createdAt: string;
  builtAt: string;
  rowCount: number;
  failureCount: number;
  rows: Array<Record<string, unknown>>;
  videoComparisons?: Array<Record<string, unknown>>;
  videoCompare?: Record<string, unknown> | null;
  failures?: Array<{ assetRef: CustomReportOutputRef; error: string }>;
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
  chunkedGenerationRuns?: ChunkedGenerationRun[];
  videoCleanupTracks?: VideoCleanupTrack[];
  externalQcPairs?: Array<{
    pairId: string;
    originalKey: string;
    editedKey: string;
    originalFilename?: string;
    editedFilename?: string;
    originalUrl?: string;
    editedUrl?: string;
    createdAt: string;
    updatedAt: string;
  }>;
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

export type ApiRequestAssetRecord = {
  key: string;
  url?: string;
  contentType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: { num: number; den: number };
  [key: string]: unknown;
} | null;

export type ApiRequestRecord = {
  requestId: string;
  userId: string;
  workflow: "image_edit_full" | "image_edit_patch" | "video_generation_reference";
  model: string;
  provider?: string;
  status: "queued" | "running" | "complete" | "failed";
  jobId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  processingDurationSec?: number | null;
  request?: Record<string, unknown>;
  inputAssets?: Record<string, ApiRequestAssetRecord>;
  preparedAssets?: Record<string, ApiRequestAssetRecord>;
  outputAssets?: Record<string, ApiRequestAssetRecord>;
  normalization?: Record<string, unknown>;
  warnings?: string[];
  logs?: Array<{ at: string; message: string }>;
  error?: string | { code?: string; message?: string; details?: Record<string, unknown> } | null;
  job?: JobStatus;
};

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";

import { HelpInfoButton, PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import VideoCleanupModal from "../../components/cleanup/VideoCleanupModal";
import { useVideoFrameStrip, type VideoFrameStripItem } from "../../hooks/useVideoFrameStrip";
import { getGenerationModeConfig, type GenerateInputMode } from "../../lib/generationModeRegistry";
import type { ExportRecord, SegmentGeneration, SegmentRecord, TaskDetail } from "../../types/api";

export type MergeTabCtx = {
  onNext: () => void;
  nextDisabled: boolean;
  nextWarning: string | null;
  generationInputMode: GenerateInputMode;
  mergeTargetGeneration: SegmentGeneration | null;
  mergeTargetSegment: SegmentRecord | null;
  completeGenerations: SegmentGeneration[];
  describeGeneration: (generation: SegmentGeneration) => string;
  describeSegment: (segment: SegmentRecord) => string;
  getSegmentForGeneration: (generation: SegmentGeneration) => SegmentRecord | null;
  sourceFrameCount: number;
  mergeMaxFrameIndex: number;
  mergeInsertStartFrame: number;
  setMergeInsertStartFrame: (value: number) => void;
  mergeGeneratedDurationFrames: number;
  mergeTrimStartFrames: number;
  setMergeTrimStartFrames: (value: number) => void;
  mergeTrimEndFrames: number;
  setMergeTrimEndFrames: (value: number) => void;
  temporalFeatherFrames: number;
  setTemporalFeatherFrames: (value: number) => void;
  mergeOriginalStartFrame: number;
  mergeOriginalEndFrameExclusive: number;
  mergeOriginalDurationFrames: number;
  formatFramesAndSeconds: (frames: number, fps: number) => string;
  mergeFps: number;
  mergeVisibleDurationFramesBeforeRetime: number;
  mergeEffectiveDurationFrames: number;
  mergeInsertStartFrameLowerBound: number;
  mergeInsertStartFrameUpperBound: number;
  mergeInsertStartFrameEffective: number;
  mergeEffectiveEndFrameExclusive: number;
  mergeEffectiveEndFrameInclusive: number;
  mergeEndOffsetFrames: number;
  mergeGeneratedStartAnchor: number;
  mergeGeneratedMaxFrameIndex: number;
  mergeFeatherClamped: number;
  mergeTrimStartFramesEffective: number;
  mergeOriginalVideoForPreview: string | null;
  mergeGeneratedVideoForPreview: string | null;
  mergeOriginalSourceCacheKey: string;
  mergeGeneratedSourceCacheKey: string;
  startBoundaryOriginalThumbs: VideoFrameStripItem[];
  startBoundaryGeneratedThumbs: VideoFrameStripItem[];
  MergeBoundaryPreview: ComponentType<{
    title: string;
    actionLabel: string;
    onAction: () => void;
    firstTrack: {
      title: string;
      items: VideoFrameStripItem[];
      anchorFrame: number;
      anchorEdge?: "start" | "end";
      anchorSlotIndex?: number;
      overlapStart?: number;
      overlapEnd?: number;
      prefix: string;
      frameLabelPosition?: "top" | "bottom";
    };
    secondTrack: {
      title: string;
      items: VideoFrameStripItem[];
      anchorFrame: number;
      anchorEdge?: "start" | "end";
      anchorSlotIndex?: number;
      overlapStart?: number;
      overlapEnd?: number;
      prefix: string;
      frameLabelPosition?: "top" | "bottom";
    };
  }>;
  mergeGeneratedEndAnchor: number;
  endBoundaryGeneratedThumbs: VideoFrameStripItem[];
  endBoundaryOriginalThumbs: VideoFrameStripItem[];
  mergeSourceWidth: number;
  mergeSourceHeight: number;
  mergeMutation: {
    isPending: boolean;
    mutate: (options?: { cropEdgeFeather?: CropEdgeFeather | null }) => void;
  };
  mergeApplyRetime: boolean;
  setMergeApplyRetime: (value: boolean) => void;
  mergePlaybackRate: number;
  setMergePlaybackRate: (value: number) => void;
  suggestMergeAlignment: () => void;
  isSuggestingMergeAlignment: boolean;
  reconcileTiming: () => void;
  isReconcilingTiming: boolean;
  mergeAlignmentSuggestion: {
    suggested: {
      startFrameOverride: number;
      trimStartFrames: number;
      trimEndFrames: number;
    };
    analysis: {
      sourceFrameOffset: number;
      sourceOffsetSec: number;
      earlyMedianDriftFrames: number;
      quarterMedianDriftFrames?: number;
      middleMedianDriftFrames?: number;
      threeQuarterMedianDriftFrames?: number;
      lateMedianDriftFrames: number;
      stableBaselineDriftFrames?: number;
      suggestedInsertOffsetFrames?: number;
      startupTrimFrames?: number;
      residualEndFrames: number;
      meanAbsDriftFrames: number;
      residualMeanAbsDriftFrames: number;
      linearFitMaeFrames?: number;
      driftSlopeFramesPerSourceFrame?: number;
      suggestedPlaybackRate: number;
      recommendation: string;
      confidence: number;
      notes: string[];
    };
  } | null;
  mergeAlignmentSuggestionError: string | null;
  reconcileTimingError: string | null;
  extendGeneration: (payload: {
    generationId: string;
    alignmentFrameIndex: number;
    anchorFramesFromEnd: number;
    durationSeconds?: number;
    prompt?: string;
  }) => void;
  isExtendingGeneration: boolean;
  extendGenerationError: string | null;
  sortedExports: ExportRecord[];
  humanizeFilename: (value: string) => string;
  keyBasenameFromS3Key: (key: string) => string;
  formatCompactTimestamp: (iso: string | undefined) => string;
  openMotionSyncModal: (exportId: string) => void;
  task: TaskDetail | undefined;
  hasMultiChunkOutput: boolean;
  onTrackJobId: (jobId: string) => void;
  refreshTask: () => Promise<void>;
};

type MergeTabProps = {
  ctx: MergeTabCtx;
};

type BoundaryZoomPair = {
  originalFrameIndex: number;
  originalImageUrl: string | null;
  generatedFrameIndex: number;
  generatedImageUrl: string | null;
};

type BoundaryZoomModalState = {
  kind: "start" | "end";
  title: string;
  crop: SegmentRecord["crop"] | null;
  frameOffset: number;
};

type CropEdgeFeather = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function frameWindow(centerFrame: number, before: number, after: number, minFrame: number, maxFrame: number): number[] {
  if (maxFrame < minFrame) return [];
  const values: number[] = [];
  for (let frame = centerFrame - before; frame <= centerFrame + after; frame += 1) {
    if (frame < minFrame || frame > maxFrame) continue;
    values.push(frame);
  }
  return values;
}

function generatedOutputFrameToSourceFrame(
  outputFrameIndex: number,
  trimStartFrames: number,
  visibleSourceFrames: number,
  effectiveOutputFrames: number,
): number {
  const safeVisibleSourceFrames = Math.max(1, visibleSourceFrames);
  const safeEffectiveOutputFrames = Math.max(1, effectiveOutputFrames);
  if (safeVisibleSourceFrames <= 1 || safeEffectiveOutputFrames <= 1) {
    return trimStartFrames;
  }
  const clampedOutputFrameIndex = clampInteger(outputFrameIndex, 0, safeEffectiveOutputFrames - 1);
  const sourceOffset =
    safeEffectiveOutputFrames === safeVisibleSourceFrames
      ? clampedOutputFrameIndex
      : Math.round((clampedOutputFrameIndex * (safeVisibleSourceFrames - 1)) / (safeEffectiveOutputFrames - 1));
  return trimStartFrames + clampInteger(sourceOffset, 0, safeVisibleSourceFrames - 1);
}

function remapGeneratedStripItems(
  displayFrameIndices: number[],
  sourceFrameIndices: number[],
  sourceItems: VideoFrameStripItem[],
): VideoFrameStripItem[] {
  const imageBySourceFrame = new Map(sourceItems.map((item) => [item.frameIndex, item.imageUrl ?? null]));
  return displayFrameIndices.map((displayFrameIndex, idx) => {
    const sourceFrameIndex = sourceFrameIndices[idx] ?? sourceFrameIndices[sourceFrameIndices.length - 1] ?? 0;
    return {
      frameIndex: displayFrameIndex,
      sourceFrameIndex,
      imageUrl: imageBySourceFrame.get(sourceFrameIndex) ?? null,
    };
  });
}

function findStripItem(items: VideoFrameStripItem[], frameIndex: number) {
  return items.find((item) => item.frameIndex === frameIndex) ?? null;
}

function buildBoundaryZoomPairs(
  generatedItems: VideoFrameStripItem[],
  generatedAnchor: number,
  originalItems: VideoFrameStripItem[],
  sourceAnchor: number,
): BoundaryZoomPair[] {
  const generatedFocus = generatedItems
    .filter((item) => item.frameIndex >= generatedAnchor - 1 && item.frameIndex <= generatedAnchor + 1)
    .slice(0, 3);

  return generatedFocus.map((generatedItem) => {
    const mappedOriginalFrame = sourceAnchor + (generatedItem.frameIndex - generatedAnchor);
    const originalItem = findStripItem(originalItems, mappedOriginalFrame);
    return {
      originalFrameIndex: mappedOriginalFrame,
      originalImageUrl: originalItem?.imageUrl ?? null,
      generatedFrameIndex: generatedItem.frameIndex,
      generatedImageUrl: generatedItem.imageUrl,
    };
  });
}

function NumberAdjustField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink/85">{label}</p>
          <p className="mt-1 text-[11px] text-ink/60">{hint}</p>
        </div>
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 rounded-md border border-ink/20 px-2 py-2 text-sm"
        />
      </div>
    </div>
  );
}

function CropOverlayPreview({
  originalImageUrl,
  generatedImageUrl,
  crop,
  sourceWidth,
  sourceHeight,
}: {
  originalImageUrl: string | null;
  generatedImageUrl: string | null;
  crop: NonNullable<SegmentRecord["crop"]>;
  sourceWidth: number;
  sourceHeight: number;
}) {
  if (!originalImageUrl || !generatedImageUrl || sourceWidth <= 0 || sourceHeight <= 0) {
    return <div className="flex h-48 items-center justify-center rounded-lg border border-ink/10 bg-bg text-xs text-ink/55">Preview unavailable</div>;
  }

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-ink/10 bg-bg"
      style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
    >
      <img src={originalImageUrl} alt="Source frame" className="h-full w-full object-contain" />
      <div
        className="absolute overflow-hidden rounded-sm border border-teal-500/70 shadow-[0_0_0_1px_rgba(255,255,255,0.8)]"
        style={{
          left: `${(crop.x / sourceWidth) * 100}%`,
          top: `${(crop.y / sourceHeight) * 100}%`,
          width: `${(crop.width / sourceWidth) * 100}%`,
          height: `${(crop.height / sourceHeight) * 100}%`,
        }}
      >
        <img src={generatedImageUrl} alt="Generated crop overlay" className="h-full w-full object-cover" />
      </div>
    </div>
  );
}

function CropEdgeFeatherPreview({
  originalImageUrl,
  generatedImageUrl,
  crop,
  sourceWidth,
  sourceHeight,
  featherTop,
  featherRight,
  featherBottom,
  featherLeft,
}: {
  originalImageUrl: string | null;
  generatedImageUrl: string | null;
  crop: NonNullable<SegmentRecord["crop"]>;
  sourceWidth: number;
  sourceHeight: number;
  featherTop: number;
  featherRight: number;
  featherBottom: number;
  featherLeft: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!originalImageUrl || !generatedImageUrl || sourceWidth <= 0 || sourceHeight <= 0) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const original = new Image();
    const generated = new Image();
    original.crossOrigin = "anonymous";
    generated.crossOrigin = "anonymous";
    original.src = originalImageUrl;
    generated.src = generatedImageUrl;

    const top = Math.max(0, Math.min(crop.height - 1, featherTop));
    const right = Math.max(0, Math.min(crop.width - 1, featherRight));
    const bottom = Math.max(0, Math.min(crop.height - 1, featherBottom));
    const left = Math.max(0, Math.min(crop.width - 1, featherLeft));

    const load = (img: HTMLImageElement) =>
      new Promise<void>((resolve, reject) => {
        if (img.complete && img.naturalWidth > 0) {
          resolve();
          return;
        }
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load preview frame"));
      });

    void Promise.all([load(original), load(generated)])
      .then(() => {
        if (cancelled) return;
        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, sourceWidth, sourceHeight);
        ctx.drawImage(original, 0, 0, sourceWidth, sourceHeight);

        const layerCanvas = document.createElement("canvas");
        layerCanvas.width = crop.width;
        layerCanvas.height = crop.height;
        const layerCtx = layerCanvas.getContext("2d");
        if (!layerCtx) return;
        layerCtx.drawImage(generated, 0, 0, crop.width, crop.height);
        const imageData = layerCtx.getImageData(0, 0, crop.width, crop.height);
        const px = imageData.data;
        for (let y = 0; y < crop.height; y += 1) {
          for (let x = 0; x < crop.width; x += 1) {
            const idx = (y * crop.width + x) * 4 + 3;
            const leftAlpha = left > 0 && x < left ? (x + 1) / (left + 1) : 1;
            const rightDistance = crop.width - 1 - x;
            const rightAlpha = right > 0 && rightDistance < right ? (rightDistance + 1) / (right + 1) : 1;
            const topAlpha = top > 0 && y < top ? (y + 1) / (top + 1) : 1;
            const bottomDistance = crop.height - 1 - y;
            const bottomAlpha = bottom > 0 && bottomDistance < bottom ? (bottomDistance + 1) / (bottom + 1) : 1;
            const edgeAlpha = Math.min(leftAlpha, rightAlpha, topAlpha, bottomAlpha);
            px[idx] = Math.max(0, Math.min(255, Math.round(px[idx] * edgeAlpha)));
          }
        }
        layerCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(layerCanvas, crop.x, crop.y, crop.width, crop.height);
        setRenderError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setRenderError(error instanceof Error ? error.message : "Unable to render feather preview");
      });

    return () => {
      cancelled = true;
    };
  }, [
    crop.height,
    crop.width,
    crop.x,
    crop.y,
    featherBottom,
    featherLeft,
    featherRight,
    featherTop,
    generatedImageUrl,
    originalImageUrl,
    sourceHeight,
    sourceWidth,
  ]);

  if (!originalImageUrl || !generatedImageUrl || sourceWidth <= 0 || sourceHeight <= 0) {
    return <div className="flex h-48 items-center justify-center rounded-lg border border-ink/10 bg-bg text-xs text-ink/55">Preview unavailable</div>;
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-ink/10 bg-bg" style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}>
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
      </div>
      {renderError ? <p className="text-[11px] text-ink/55">Feather preview fallback: {renderError}</p> : null}
    </div>
  );
}

export default function MergeTab({ ctx }: MergeTabProps) {
  const {
    onNext,
    nextDisabled,
    nextWarning,
    generationInputMode,
    mergeTargetGeneration,
    mergeTargetSegment,
    completeGenerations,
    describeGeneration,
    describeSegment,
    getSegmentForGeneration,
    sourceFrameCount,
    mergeInsertStartFrame,
    setMergeInsertStartFrame,
    mergeGeneratedDurationFrames,
    mergeTrimStartFrames,
    setMergeTrimStartFrames,
    mergeTrimEndFrames,
    setMergeTrimEndFrames,
    temporalFeatherFrames,
    setTemporalFeatherFrames,
    mergeOriginalStartFrame,
    mergeOriginalEndFrameExclusive,
    mergeOriginalDurationFrames,
    formatFramesAndSeconds,
    mergeFps,
    mergeVisibleDurationFramesBeforeRetime,
    mergeEffectiveDurationFrames,
    mergeInsertStartFrameLowerBound,
    mergeInsertStartFrameUpperBound,
    mergeInsertStartFrameEffective,
    mergeEffectiveEndFrameExclusive,
    mergeEffectiveEndFrameInclusive,
    mergeEndOffsetFrames,
    mergeGeneratedStartAnchor,
    mergeGeneratedMaxFrameIndex,
    mergeFeatherClamped,
    mergeTrimStartFramesEffective,
    mergeOriginalVideoForPreview,
    mergeGeneratedVideoForPreview,
    mergeOriginalSourceCacheKey,
    mergeGeneratedSourceCacheKey,
    startBoundaryOriginalThumbs,
    startBoundaryGeneratedThumbs,
    MergeBoundaryPreview,
    mergeGeneratedEndAnchor,
    endBoundaryGeneratedThumbs,
    endBoundaryOriginalThumbs,
    mergeSourceWidth,
    mergeSourceHeight,
    mergeMutation,
    mergeApplyRetime,
    setMergeApplyRetime,
    mergePlaybackRate,
    setMergePlaybackRate,
    suggestMergeAlignment,
    isSuggestingMergeAlignment,
    reconcileTiming,
    isReconcilingTiming,
    mergeAlignmentSuggestion,
    mergeAlignmentSuggestionError,
    reconcileTimingError,
    extendGeneration,
    isExtendingGeneration,
    extendGenerationError,
    sortedExports,
    humanizeFilename,
    keyBasenameFromS3Key,
    formatCompactTimestamp,
    openMotionSyncModal,
    task,
    hasMultiChunkOutput,
    onTrackJobId,
    refreshTask,
  } = ctx;
  const [selectedToolId, setSelectedToolId] = useState<"extend" | "align_retime" | "cleanup" | "merge" | null>(null);
  const [extendGenerationId, setExtendGenerationId] = useState("");
  const [extendAlignmentFrame, setExtendAlignmentFrame] = useState("");
  const [extendAnchorFramesFromEnd, setExtendAnchorFramesFromEnd] = useState("5");
  const [extendDurationSeconds, setExtendDurationSeconds] = useState("");
  const [extendPrompt, setExtendPrompt] = useState("");
  const [boundaryZoomModal, setBoundaryZoomModal] = useState<BoundaryZoomModalState | null>(null);
  const selectedExtendGeneration = useMemo(
    () => completeGenerations.find((generation) => generation.genId === extendGenerationId) ?? null,
    [completeGenerations, extendGenerationId],
  );
  const selectedExtendSegment = selectedExtendGeneration ? getSegmentForGeneration(selectedExtendGeneration) : null;
  const parsedAlignmentFrame = Number(extendAlignmentFrame);
  const parsedAnchorFramesFromEnd = Number(extendAnchorFramesFromEnd);
  const parsedDurationSeconds = extendDurationSeconds.trim() ? Number(extendDurationSeconds) : undefined;
  const canSubmitExtension =
    Boolean(selectedExtendGeneration) &&
    Number.isInteger(parsedAlignmentFrame) &&
    parsedAlignmentFrame >= 0 &&
    (sourceFrameCount <= 0 || parsedAlignmentFrame < sourceFrameCount) &&
    Number.isInteger(parsedAnchorFramesFromEnd) &&
    parsedAnchorFramesFromEnd >= 1 &&
    parsedAnchorFramesFromEnd <= 60 &&
    (parsedDurationSeconds === undefined || (Number.isInteger(parsedDurationSeconds) && parsedDurationSeconds >= 1 && parsedDurationSeconds <= 15));
  const generationModeConfig = useMemo(() => getGenerationModeConfig(generationInputMode), [generationInputMode]);
  const showExtendTool = generationModeConfig.postProcessTools.extend;
  const showReconcileTimingTool = generationModeConfig.postProcessTools.reconcileTiming;
  const showTrackedCleanupTool = generationModeConfig.postProcessTools.trackedCleanup;
  const showMergeIntoSourceTool = generationModeConfig.postProcessTools.mergeIntoSource;
  const cleanupEligibleGeneration =
    showTrackedCleanupTool && mergeTargetGeneration?.status === "complete" && Boolean(mergeTargetGeneration.downloadUrl)
      ? mergeTargetGeneration
      : null;
  const hasReconciledOutput = Boolean(
    mergeTargetGeneration?.derivedFromGenerationId ||
      mergeTargetGeneration?.timingReconcile?.resultGenId ||
      mergeTargetGeneration?.timingReconcile?.status === "complete",
  );
  const generationLengthDiffersFromSource = mergeGeneratedDurationFrames !== mergeOriginalDurationFrames;
  const cleanupBlockedByTiming = Boolean(generationLengthDiffersFromSource && !hasReconciledOutput);
  const cleanupToolDisabled = !cleanupEligibleGeneration || cleanupBlockedByTiming;
  const needsExtension = Boolean(
    showExtendTool &&
      mergeTargetGeneration &&
      mergeGeneratedDurationFrames < mergeOriginalDurationFrames &&
      !hasMultiChunkOutput,
  );
  const shouldShowExtendAlert = needsExtension;
  const currentGenerationFrameDifference = mergeEffectiveDurationFrames - mergeOriginalDurationFrames;
  const suggestedInsertOffset =
    mergeAlignmentSuggestion && mergeTargetSegment
      ? mergeAlignmentSuggestion.suggested.startFrameOverride - (mergeTargetSegment.startFrame ?? 0)
      : null;
  const actionableSuggestionNotes = useMemo(() => {
    if (!mergeAlignmentSuggestion) return [];
    return mergeAlignmentSuggestion.analysis.notes.filter(
      (note) =>
        !note.startsWith("Alignment was analysed against") &&
        !note.startsWith("Alignment and drift were measured against") &&
        !note.startsWith("No usable edit mask was available"),
    );
  }, [mergeAlignmentSuggestion]);
  const mergeTargetCrop = useMemo(() => {
    const crop = mergeTargetSegment?.crop;
    if (!crop || !crop.enabled) return null;
    return crop;
  }, [mergeTargetSegment]);
  const cropPreviewSourceFrameMin = mergeInsertStartFrameEffective;
  const cropPreviewSourceFrameMax = Math.max(mergeInsertStartFrameEffective, mergeEffectiveEndFrameInclusive);
  const [cropPreviewSourceFrame, setCropPreviewSourceFrame] = useState(mergeInsertStartFrameEffective);
  const [cropEdgeFeather, setCropEdgeFeather] = useState<CropEdgeFeather>({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
  const effectiveCropEdgeFeather = useMemo(() => {
    const maxHorizontal = mergeTargetCrop ? Math.max(0, mergeTargetCrop.width - 1) : 0;
    const maxVertical = mergeTargetCrop ? Math.max(0, mergeTargetCrop.height - 1) : 0;
    return {
      top: clampInteger(cropEdgeFeather.top, 0, maxVertical),
      right: clampInteger(cropEdgeFeather.right, 0, maxHorizontal),
      bottom: clampInteger(cropEdgeFeather.bottom, 0, maxVertical),
      left: clampInteger(cropEdgeFeather.left, 0, maxHorizontal),
    };
  }, [cropEdgeFeather.bottom, cropEdgeFeather.left, cropEdgeFeather.right, cropEdgeFeather.top, mergeTargetCrop]);

  useEffect(() => {
    setCropPreviewSourceFrame((previous) =>
      clampInteger(previous, cropPreviewSourceFrameMin, cropPreviewSourceFrameMax),
    );
  }, [cropPreviewSourceFrameMax, cropPreviewSourceFrameMin]);

  useEffect(() => {
    setCropPreviewSourceFrame(clampInteger(mergeInsertStartFrameEffective, cropPreviewSourceFrameMin, cropPreviewSourceFrameMax));
  }, [cropPreviewSourceFrameMax, cropPreviewSourceFrameMin, mergeInsertStartFrameEffective, mergeTargetGeneration?.genId]);

  useEffect(() => {
    const defaultFeather = mergeTargetCrop ? clampInteger(mergeTargetCrop.featherPx ?? 0, 0, 200) : 0;
    setCropEdgeFeather({
      top: defaultFeather,
      right: defaultFeather,
      bottom: defaultFeather,
      left: defaultFeather,
    });
  }, [mergeTargetCrop]);

  const cropPreviewDisplayFrame = useMemo(
    () => clampInteger(cropPreviewSourceFrame - mergeInsertStartFrameEffective, 0, Math.max(0, mergeEffectiveDurationFrames - 1)),
    [cropPreviewSourceFrame, mergeEffectiveDurationFrames, mergeInsertStartFrameEffective],
  );
  const cropPreviewGeneratedSourceFrame = useMemo(
    () =>
      generatedOutputFrameToSourceFrame(
        cropPreviewDisplayFrame,
        mergeTrimStartFramesEffective,
        mergeVisibleDurationFramesBeforeRetime,
        mergeEffectiveDurationFrames,
      ),
    [cropPreviewDisplayFrame, mergeEffectiveDurationFrames, mergeTrimStartFramesEffective, mergeVisibleDurationFramesBeforeRetime],
  );
  const cropPreviewOriginalFrame = useVideoFrameStrip({
    videoUrl: selectedToolId === "merge" && mergeTargetCrop ? mergeOriginalVideoForPreview : null,
    fps: mergeFps,
    frameIndices: selectedToolId === "merge" && mergeTargetCrop ? [cropPreviewSourceFrame] : [],
    cachePrefix: "merge:crop-feather:source",
    sourceCacheKey: mergeOriginalSourceCacheKey,
  });
  const cropPreviewGeneratedFrame = useVideoFrameStrip({
    videoUrl: selectedToolId === "merge" && mergeTargetCrop ? mergeGeneratedVideoForPreview : null,
    fps: mergeFps,
    frameIndices: selectedToolId === "merge" && mergeTargetCrop ? [cropPreviewGeneratedSourceFrame] : [],
    cachePrefix: "merge:crop-feather:generated",
    sourceCacheKey: mergeGeneratedSourceCacheKey,
  });
  const cropPreviewOriginalImageUrl = cropPreviewOriginalFrame[0]?.imageUrl ?? null;
  const cropPreviewGeneratedImageUrl = cropPreviewGeneratedFrame[0]?.imageUrl ?? null;

  const resetExtensionFormForGeneration = useCallback((generation: SegmentGeneration | null) => {
    const segment = generation ? getSegmentForGeneration(generation) : null;
    const defaultAlignment = Math.max(0, (segment?.endFrameExclusive ?? 1) - 6);
    const defaultDuration = Math.max(1, Math.ceil(segment?.durationSec ?? 5));
    setExtendGenerationId(generation?.genId ?? "");
    setExtendAlignmentFrame(String(defaultAlignment));
    setExtendAnchorFramesFromEnd("5");
    setExtendDurationSeconds(String(defaultDuration));
    setExtendPrompt(generation?.luma.prompt ?? "");
  }, [getSegmentForGeneration]);

  function handleExtendGenerationChange(genId: string) {
    const generation = completeGenerations.find((item) => item.genId === genId) ?? null;
    resetExtensionFormForGeneration(generation);
  }

  function submitExtension() {
    if (!canSubmitExtension || !selectedExtendGeneration) return;
    extendGeneration({
      generationId: selectedExtendGeneration.genId,
      alignmentFrameIndex: parsedAlignmentFrame,
      anchorFramesFromEnd: parsedAnchorFramesFromEnd,
      durationSeconds: parsedDurationSeconds,
      prompt: extendPrompt.trim() || undefined,
    });
  }

  const visibleToolSequence = useMemo(() => {
    const tools: Array<{
      id: "extend" | "align_retime" | "cleanup" | "merge";
      title: string;
      description: string;
      disabled?: boolean;
      alert?: string | null;
    }> = [];
    if (showExtendTool) {
      tools.push({
        id: "extend",
        title: "Extend generation",
        description: "Continue from an existing output",
        alert: shouldShowExtendAlert ? "Extend the generation to match the current working range" : null,
      });
    }
    if (showReconcileTimingTool) {
      tools.push({
        id: "align_retime",
        title: "Align & Retime",
        description: "Create frame accurate alignment with the source to allow comping and seamless merge",
      });
    }
    if (showTrackedCleanupTool) {
      tools.push({
        id: "cleanup",
        title: "Comp / clean-up",
        description: "Create tracked mask to comp the generated regions back onto source to recover original fidelity",
        disabled: cleanupToolDisabled,
      });
    }
    if (showMergeIntoSourceTool) {
      tools.push({
        id: "merge",
        title: "Merge into source",
        description: "Blend and place the generation back into the source clip",
      });
    }
    return tools;
  }, [
    cleanupToolDisabled,
    shouldShowExtendAlert,
    showExtendTool,
    showMergeIntoSourceTool,
    showReconcileTimingTool,
    showTrackedCleanupTool,
  ]);

  useEffect(() => {
    const defaultTool = needsExtension
      ? "extend"
      : showReconcileTimingTool
        ? "align_retime"
        : showMergeIntoSourceTool
          ? "merge"
          : showTrackedCleanupTool
            ? "cleanup"
            : showExtendTool
              ? "extend"
              : null;
    const selectedStillValid = visibleToolSequence.some((tool) => tool.id === selectedToolId && !tool.disabled);
    if (!selectedStillValid) {
      setSelectedToolId(defaultTool);
    }
    if (!selectedExtendGeneration && completeGenerations.length) {
      resetExtensionFormForGeneration(mergeTargetGeneration ?? completeGenerations[0] ?? null);
    }
  }, [
    completeGenerations,
    mergeTargetGeneration,
    needsExtension,
    selectedExtendGeneration,
    selectedToolId,
    showExtendTool,
    showMergeIntoSourceTool,
    showReconcileTimingTool,
    showTrackedCleanupTool,
    visibleToolSequence,
    resetExtensionFormForGeneration,
  ]);

  function openStartBoundaryZoom() {
    setBoundaryZoomModal({
      kind: "start",
      title: "Start merge zoom",
      crop: mergeTargetSegment?.crop ?? null,
      frameOffset: 0,
    });
  }

  function openEndBoundaryZoom() {
    setBoundaryZoomModal({
      kind: "end",
      title: "End merge zoom",
      crop: mergeTargetSegment?.crop ?? null,
      frameOffset: 0,
    });
  }

  const boundaryZoomDisplayAnchor = useMemo(() => {
    if (!boundaryZoomModal) return null;
    const anchorBase = boundaryZoomModal.kind === "start" ? mergeGeneratedStartAnchor : mergeGeneratedEndAnchor;
    return clampInteger(anchorBase + boundaryZoomModal.frameOffset, 0, mergeGeneratedMaxFrameIndex);
  }, [boundaryZoomModal, mergeGeneratedEndAnchor, mergeGeneratedMaxFrameIndex, mergeGeneratedStartAnchor]);
  const boundaryZoomSourceAnchor = useMemo(() => {
    if (!boundaryZoomModal) return null;
    const anchorBase = boundaryZoomModal.kind === "start" ? mergeInsertStartFrameEffective : mergeEffectiveEndFrameInclusive;
    return clampInteger(anchorBase + boundaryZoomModal.frameOffset, 0, Math.max(0, sourceFrameCount - 1));
  }, [boundaryZoomModal, mergeEffectiveEndFrameInclusive, mergeInsertStartFrameEffective, sourceFrameCount]);
  const boundaryZoomDisplayFrames = useMemo(
    () =>
      boundaryZoomDisplayAnchor == null ? [] : frameWindow(boundaryZoomDisplayAnchor, 1, 1, 0, mergeGeneratedMaxFrameIndex),
    [boundaryZoomDisplayAnchor, mergeGeneratedMaxFrameIndex],
  );
  const boundaryZoomGeneratedSourceFrames = useMemo(
    () =>
      boundaryZoomDisplayFrames.map((frameIndex) =>
        generatedOutputFrameToSourceFrame(
          frameIndex,
          mergeTrimStartFramesEffective,
          mergeVisibleDurationFramesBeforeRetime,
          mergeEffectiveDurationFrames,
        ),
      ),
    [boundaryZoomDisplayFrames, mergeEffectiveDurationFrames, mergeTrimStartFramesEffective, mergeVisibleDurationFramesBeforeRetime],
  );
  const boundaryZoomSourceFrames = useMemo(
    () => (boundaryZoomSourceAnchor == null ? [] : frameWindow(boundaryZoomSourceAnchor, 1, 1, 0, Math.max(0, sourceFrameCount - 1))),
    [boundaryZoomSourceAnchor, sourceFrameCount],
  );
  const boundaryZoomGeneratedThumbs = useVideoFrameStrip({
    videoUrl: boundaryZoomModal ? mergeGeneratedVideoForPreview : null,
    fps: mergeFps,
    frameIndices: boundaryZoomGeneratedSourceFrames,
    cachePrefix: boundaryZoomModal ? `merge:zoom:${boundaryZoomModal.kind}:generated` : "merge:zoom:generated",
    sourceCacheKey: mergeGeneratedSourceCacheKey,
  });
  const boundaryZoomGeneratedDisplayThumbs = useMemo(
    () => remapGeneratedStripItems(boundaryZoomDisplayFrames, boundaryZoomGeneratedSourceFrames, boundaryZoomGeneratedThumbs),
    [boundaryZoomDisplayFrames, boundaryZoomGeneratedSourceFrames, boundaryZoomGeneratedThumbs],
  );
  const boundaryZoomSourceThumbs = useVideoFrameStrip({
    videoUrl: boundaryZoomModal ? mergeOriginalVideoForPreview : null,
    fps: mergeFps,
    frameIndices: boundaryZoomSourceFrames,
    cachePrefix: boundaryZoomModal ? `merge:zoom:${boundaryZoomModal.kind}:source` : "merge:zoom:source",
    sourceCacheKey: mergeOriginalSourceCacheKey,
  });
  const boundaryZoomPairs = useMemo(
    () =>
      boundaryZoomModal && boundaryZoomDisplayAnchor != null && boundaryZoomSourceAnchor != null
        ? buildBoundaryZoomPairs(
            boundaryZoomGeneratedDisplayThumbs,
            boundaryZoomDisplayAnchor,
            boundaryZoomSourceThumbs,
            boundaryZoomSourceAnchor,
          )
        : [],
    [
      boundaryZoomDisplayAnchor,
      boundaryZoomGeneratedDisplayThumbs,
      boundaryZoomModal,
      boundaryZoomSourceAnchor,
      boundaryZoomSourceThumbs,
    ],
  );
  const boundaryZoomCanStepBackward = useMemo(() => {
    if (!boundaryZoomModal) return false;
    const anchorBase = boundaryZoomModal.kind === "start" ? mergeGeneratedStartAnchor : mergeGeneratedEndAnchor;
    return anchorBase + boundaryZoomModal.frameOffset > 0;
  }, [boundaryZoomModal, mergeGeneratedEndAnchor, mergeGeneratedStartAnchor]);
  const boundaryZoomCanStepForward = useMemo(() => {
    if (!boundaryZoomModal) return false;
    const anchorBase = boundaryZoomModal.kind === "start" ? mergeGeneratedStartAnchor : mergeGeneratedEndAnchor;
    return anchorBase + boundaryZoomModal.frameOffset < mergeGeneratedMaxFrameIndex;
  }, [boundaryZoomModal, mergeGeneratedEndAnchor, mergeGeneratedMaxFrameIndex, mergeGeneratedStartAnchor]);

  function nudgeBoundaryZoomFrameOffset(delta: number) {
    setBoundaryZoomModal((previous) => {
      if (!previous) return previous;
      const anchorBase = previous.kind === "start" ? mergeGeneratedStartAnchor : mergeGeneratedEndAnchor;
      const nextFrameOffset = previous.frameOffset + delta;
      const nextAnchor = clampInteger(anchorBase + nextFrameOffset, 0, mergeGeneratedMaxFrameIndex);
      return { ...previous, frameOffset: nextAnchor - anchorBase };
    });
  }

  function nudgeMergeInsertStart(delta: number) {
    setMergeInsertStartFrame(mergeInsertStartFrame + delta);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ink/15 bg-bg p-3">
        <div className="flex items-stretch overflow-x-auto py-1">
          {visibleToolSequence.map((tool, index) => {
            const isActive = selectedToolId === tool.id;
            const isDisabled = Boolean(tool.disabled);
            return (
              <div key={tool.id} className="flex min-w-[15.5rem] max-w-[19rem] flex-none items-center">
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    setSelectedToolId(tool.id);
                  }}
                  className={`w-full rounded-lg border px-3 py-3 text-left transition ${
                    isDisabled
                      ? "cursor-not-allowed border-ink/10 bg-ink/5 text-ink/40"
                      : isActive
                        ? "border-teal-500 bg-teal-50 text-ink shadow-sm"
                        : "border-ink/15 bg-white text-ink hover:border-ink/30"
                  }`}
                >
                  <p className="text-sm font-semibold">{tool.title}</p>
                  <p className="mt-1 text-xs leading-snug opacity-85">{tool.description}</p>
                  {tool.alert ? (
                    <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-900">
                      {tool.alert}
                    </p>
                  ) : null}
                  {tool.id === "cleanup" && cleanupBlockedByTiming ? (
                    <p className="mt-2 text-[11px] text-ink/55">
                      Requires an aligned/retimed output when generation and source frame lengths differ.
                    </p>
                  ) : null}
                </button>
                {index < visibleToolSequence.length - 1 ? (
                  <div className="-mx-1 z-10 flex h-full items-center">
                    <div className="rounded-full border border-ink/15 bg-white px-1.5 py-0.5 text-[11px] text-ink/65">&#8594;</div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {selectedToolId === "extend" ? (
        <div className="rounded-lg border border-ink/15 bg-bg p-4">
          <div className="space-y-3">
            <div>
              <h4 className="text-base font-semibold">Extend generation</h4>
              <p className="mt-1 text-sm text-ink/60">Creates the next working-range continuation from an existing output.</p>
            </div>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Previous output</span>
              <select
                className="w-full rounded-md border border-ink/20 px-2 py-2"
                value={extendGenerationId}
                onChange={(event) => handleExtendGenerationChange(event.target.value)}
              >
                {completeGenerations.map((generation) => {
                  const segment = getSegmentForGeneration(generation);
                  return (
                    <option key={generation.genId} value={generation.genId}>
                      {describeGeneration(generation)}
                      {segment ? ` · ${describeSegment(segment)}` : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="block font-medium">Alignment source frame</span>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, sourceFrameCount - 1)}
                  className="w-full rounded-md border border-ink/20 px-2 py-2"
                  value={extendAlignmentFrame}
                  onChange={(event) => setExtendAlignmentFrame(event.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="block font-medium">Anchor offset from end</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  className="w-full rounded-md border border-ink/20 px-2 py-2"
                  value={extendAnchorFramesFromEnd}
                  onChange={(event) => setExtendAnchorFramesFromEnd(event.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="block font-medium">Next range seconds</span>
                <input
                  type="number"
                  min={1}
                  max={15}
                  className="w-full rounded-md border border-ink/20 px-2 py-2"
                  value={extendDurationSeconds}
                  onChange={(event) => setExtendDurationSeconds(event.target.value)}
                />
              </label>
            </div>
            {selectedExtendSegment ? (
              <p className="rounded-md bg-white p-2 text-xs text-ink/70">
                Previous working range: {describeSegment(selectedExtendSegment)}. The next continuation will start at source f
                {Number.isFinite(parsedAlignmentFrame) ? parsedAlignmentFrame : 0}.
              </p>
            ) : null}
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Prompt for next continuation</span>
              <textarea
                rows={4}
                className="w-full rounded-md border border-ink/20 px-2 py-2"
                value={extendPrompt}
                onChange={(event) => setExtendPrompt(event.target.value)}
              />
            </label>
            <div className="flex justify-end">
              <button
                type="button"
                className="rounded bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canSubmitExtension || isExtendingGeneration}
                onClick={submitExtension}
              >
                <PendingButtonLabel isPending={isExtendingGeneration} idle="Queue next continuation" pending="Queueing continuation..." />
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {selectedToolId === "cleanup" ? (
        cleanupEligibleGeneration ? (
          <VideoCleanupModal
            embedded
            isOpen
            task={task}
            generation={cleanupEligibleGeneration}
            onClose={() => undefined}
            onTrackJobId={onTrackJobId}
            refreshTask={refreshTask}
          />
        ) : (
          <StatusNotice variant="warning">
            <p className="text-xs">Select a completed generation output in Generate before using Comp / clean-up.</p>
          </StatusNotice>
        )
      ) : null}
      {showMergeIntoSourceTool && (selectedToolId === "align_retime" || selectedToolId === "merge") ? (
      <>
      <div className="rounded-lg border border-ink/15 bg-bg p-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">{selectedToolId === "align_retime" ? "Align & Retime" : "Merge into source"}</p>
          <HelpInfoButton
            title={selectedToolId === "align_retime" ? "Alignment and retime" : "Merge composition"}
            lines={
              selectedToolId === "align_retime"
                ? [
                    "Use this step to align generated timing with the source segment before compositing.",
                    "Suggest alignment analyses source-vs-generation drift and proposes insert/trim offsets.",
                    "Apply retime when drift builds steadily through the segment.",
                    "Use the preview timelines to inspect start and end boundary placement.",
                  ]
                : [
                    "Use this step to blend and place the generated segment back into the source clip.",
                    "Temporal feather controls overlap blending at the merge boundaries.",
                    "When crop is active, crop-edge feather controls let you soften each edge independently before overlay.",
                    "Use the preview timelines and crop overlay preview to verify boundary quality.",
                  ]
            }
          />
        </div>
      </div>
      <div className="space-y-3">
        {mergeTargetGeneration && mergeTargetSegment ? (
          <>
            <div className="space-y-3 rounded-lg border border-ink/10 p-3">
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">Current Alignment</p>
                <div className="grid gap-2 rounded-lg border border-ink/10 bg-white p-3 md:grid-cols-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink/50">Source frame length</p>
                    <p className="mt-1 text-lg font-semibold text-ink">{mergeOriginalDurationFrames}f</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink/50">Generation frame length</p>
                    <p className="mt-1 text-lg font-semibold text-ink">{mergeEffectiveDurationFrames}f</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink/50">Generation frame difference</p>
                    <p className={`mt-1 text-lg font-semibold ${currentGenerationFrameDifference === 0 ? "text-ink" : currentGenerationFrameDifference > 0 ? "text-orange-700" : "text-teal-700"}`}>
                      {currentGenerationFrameDifference >= 0 ? "+" : ""}
                      {currentGenerationFrameDifference}f
                    </p>
                  </div>
                </div>
              </div>
              {selectedToolId === "align_retime" ? (
                <>
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-ink">Suggested Merge Alignment</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isSuggestingMergeAlignment}
                            onClick={suggestMergeAlignment}
                          >
                            <PendingButtonLabel
                              isPending={isSuggestingMergeAlignment}
                              idle="Suggest alignment"
                              pending="Analysing alignment..."
                            />
                          </button>
                          {mergeAlignmentSuggestion ? (
                            <p className="text-xs text-ink/65">
                              Confidence <span className="font-medium text-ink">{mergeAlignmentSuggestion.analysis.confidence.toFixed(2)}</span>
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="max-w-xl rounded-lg border border-ink/10 bg-bg px-3 py-2 text-[11px] leading-5 text-ink/65">
                        Alignment and drift analysis uses pixel comparisons to match frames, and where feasible focuses on unedited regions outside of the mask and matching any cropping.
                      </div>
                    </div>
                  </div>
                  {mergeAlignmentSuggestion ? (
                    <StatusNotice
                      variant={
                        mergeAlignmentSuggestion.analysis.recommendation === "rerender_recommended"
                          ? "error"
                          : mergeAlignmentSuggestion.analysis.recommendation === "retime_recommended" ||
                              mergeAlignmentSuggestion.analysis.recommendation === "piecewise_reconcile_recommended"
                            ? "warning"
                            : "info"
                      }
                    >
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-3 rounded-lg border border-ink/10 bg-white p-3">
                      <p className="text-sm font-medium text-ink">Alignment</p>
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <p className="text-[11px] text-ink/55">Source insert start</p>
                          <p className="text-xl font-semibold text-ink">
                            {suggestedInsertOffset != null && suggestedInsertOffset >= 0 ? "+" : ""}
                            {suggestedInsertOffset ?? 0}f
                          </p>
                        </div>
                        <p className="text-[11px] text-ink/60">positive values start generation later</p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-[11px] text-ink/55">Trim generation start</p>
                          <p className="text-xl font-semibold text-ink">{mergeAlignmentSuggestion.suggested.trimStartFrames}f</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Trim generation end</p>
                          <p className="text-xl font-semibold text-ink">{mergeAlignmentSuggestion.suggested.trimEndFrames}f</p>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-[11px] text-ink/55">Source offset</p>
                          <p className="text-lg font-semibold text-ink">{mergeAlignmentSuggestion.analysis.sourceFrameOffset}f</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Settled baseline drift</p>
                          <p className="text-lg font-semibold text-ink">
                            {(mergeAlignmentSuggestion.analysis.stableBaselineDriftFrames ?? 0) >= 0 ? "+" : ""}
                            {mergeAlignmentSuggestion.analysis.stableBaselineDriftFrames ?? 0}f
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-3 rounded-lg border border-ink/10 bg-white p-3">
                      <p className="text-sm font-medium text-ink">Calculated drift</p>
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        <div>
                          <p className="text-[11px] text-ink/55">Early drift</p>
                          <p className="text-xl font-semibold text-ink">
                            {mergeAlignmentSuggestion.analysis.earlyMedianDriftFrames >= 0 ? "+" : ""}
                            {mergeAlignmentSuggestion.analysis.earlyMedianDriftFrames}f
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Quarter drift</p>
                          <p className="text-xl font-semibold text-ink">
                            {(mergeAlignmentSuggestion.analysis.quarterMedianDriftFrames ?? 0) >= 0 ? "+" : ""}
                            {mergeAlignmentSuggestion.analysis.quarterMedianDriftFrames ?? 0}f
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Middle drift</p>
                          <p className="text-xl font-semibold text-ink">
                            {(mergeAlignmentSuggestion.analysis.middleMedianDriftFrames ?? 0) >= 0 ? "+" : ""}
                            {mergeAlignmentSuggestion.analysis.middleMedianDriftFrames ?? 0}f
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Late drift</p>
                          <p className="text-xl font-semibold text-ink">
                            {mergeAlignmentSuggestion.analysis.lateMedianDriftFrames >= 0 ? "+" : ""}
                            {mergeAlignmentSuggestion.analysis.lateMedianDriftFrames}f
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Residual end drift</p>
                          <p className="text-xl font-semibold text-ink">
                            {mergeAlignmentSuggestion.analysis.residualEndFrames >= 0 ? "+" : ""}
                            {mergeAlignmentSuggestion.analysis.residualEndFrames}f
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Estimated retime</p>
                          <p className="text-xl font-semibold text-ink">{mergeAlignmentSuggestion.analysis.suggestedPlaybackRate.toFixed(4)}x</p>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-[11px] text-ink/55">Drift slope</p>
                          <p className="text-lg font-semibold text-ink">{(mergeAlignmentSuggestion.analysis.driftSlopeFramesPerSourceFrame ?? 0).toFixed(4)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-ink/55">Residual fit error</p>
                          <p className="text-lg font-semibold text-ink">{(mergeAlignmentSuggestion.analysis.linearFitMaeFrames ?? 0).toFixed(2)}f</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  {actionableSuggestionNotes.length ? (
                    <div className="mt-3 space-y-1 text-xs text-ink/75">
                      {actionableSuggestionNotes.slice(0, 2).map((note) => (
                        <p key={note}>{note}</p>
                      ))}
                    </div>
                  ) : null}
                    </StatusNotice>
                  ) : null}
                  {mergeAlignmentSuggestionError ? (
                    <StatusNotice variant="error">
                      <p className="text-xs">{mergeAlignmentSuggestionError}</p>
                    </StatusNotice>
                  ) : null}
                  {reconcileTimingError ? (
                    <StatusNotice variant="error">
                      <p className="text-xs">{reconcileTimingError}</p>
                    </StatusNotice>
                  ) : null}
                  <div className="rounded-lg border border-ink/10 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-ink/85">Uniform retime before merge</p>
                    <p className="mt-1 text-[11px] text-ink/60">
                      Use this when drift builds steadily through the clip after the opening frames have been trimmed. It rescales the generated segment timing before merge.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={mergeApplyRetime}
                      onChange={(event) => setMergeApplyRetime(event.target.checked)}
                    />
                    Apply retime
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="space-y-1 text-xs text-ink/70">
                    <span className="block font-medium text-ink/80">Playback rate</span>
                    <input
                      type="number"
                      min={0.05}
                      max={20}
                      step={0.0001}
                      value={mergePlaybackRate}
                      onChange={(e) => setMergePlaybackRate(Number(e.target.value) || 1)}
                      disabled={!mergeApplyRetime}
                      className="w-28 rounded-md border border-ink/20 px-2 py-2 text-sm disabled:cursor-not-allowed disabled:bg-bg disabled:opacity-60"
                    />
                  </label>
                  <p className="text-[11px] text-ink/60">
                    `1.0` keeps original timing. Values above `1.0` speed the generated clip up; below `1.0` slow it down.
                  </p>
                </div>
                <div className="mt-3 grid gap-3 text-[11px] text-ink/65 md:grid-cols-2">
                  <div className="px-1 py-1">
                    <p className="text-[11px] text-ink/55">Frames before retime</p>
                    <p className="mt-1 text-xl font-semibold text-ink">{mergeVisibleDurationFramesBeforeRetime}f</p>
                    <p>{(mergeVisibleDurationFramesBeforeRetime / Math.max(1, mergeFps)).toFixed(2)}s</p>
                  </div>
                  <div className="px-1 py-1">
                    <p className="text-[11px] text-ink/55">Frames after retime</p>
                    <p className="mt-1 text-xl font-semibold text-ink">{mergeEffectiveDurationFrames}f</p>
                    <p>{(mergeEffectiveDurationFrames / Math.max(1, mergeFps)).toFixed(2)}s</p>
                  </div>
                </div>
                  </div>
                </>
              ) : null}
              <div className={`grid gap-3 ${selectedToolId === "align_retime" ? "xl:grid-cols-2" : ""}`}>
                <div className="space-y-3 rounded-lg border border-ink/10 bg-bg p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink/55">Start alignment</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <NumberAdjustField
                      label="Source insert start"
                      hint="Offset the generated insert relative to the original working-range start. Negative values move it earlier when source frames exist before the cut."
                      value={mergeInsertStartFrame}
                      min={mergeInsertStartFrameLowerBound}
                      max={mergeInsertStartFrameUpperBound}
                      onChange={setMergeInsertStartFrame}
                    />
                    <NumberAdjustField
                      label="Trim generation start"
                      hint="Hide inconsistent opening generated frames after the insert point is aligned."
                      value={mergeTrimStartFrames}
                      min={0}
                      max={Math.max(0, mergeGeneratedDurationFrames - 1)}
                      onChange={setMergeTrimStartFrames}
                    />
                  </div>
                </div>
                <div className="space-y-3 rounded-lg border border-ink/10 bg-bg p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink/55">
                    {selectedToolId === "align_retime" ? "End alignment" : "Merge blend"}
                  </p>
                  <div className="grid gap-3">
                    {selectedToolId === "align_retime" ? (
                      <NumberAdjustField
                        label="Trim generation end"
                        hint="Hide inconsistent generated tail frames at the end of the insert."
                        value={mergeTrimEndFrames}
                        min={0}
                        max={Math.max(0, mergeGeneratedDurationFrames - 1)}
                        onChange={setMergeTrimEndFrames}
                      />
                    ) : null}
                    {selectedToolId === "merge" ? (
                      <NumberAdjustField
                        label="Temporal feather"
                        hint="Blend a small overlap at the start and end merge boundaries."
                        value={temporalFeatherFrames}
                        min={0}
                        max={30}
                        onChange={setTemporalFeatherFrames}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="grid gap-2 rounded-md bg-bg p-2 text-xs text-ink/70 md:grid-cols-2">
                <p>
                  Original cut: <span className="font-medium text-ink">f{mergeOriginalStartFrame}</span> to{" "}
                  <span className="font-medium text-ink">f{Math.max(mergeOriginalStartFrame, mergeOriginalEndFrameExclusive - 1)}</span> (
                  {formatFramesAndSeconds(mergeOriginalDurationFrames, mergeFps)})
                </p>
                <p>
                  Generated in merge: <span className="font-medium text-ink">{formatFramesAndSeconds(mergeEffectiveDurationFrames, mergeFps)}</span>{" "}
                  (from source {formatFramesAndSeconds(mergeGeneratedDurationFrames, mergeFps)})
                </p>
                <p>
                  Insert offset: <span className="font-medium text-ink">{mergeInsertStartFrame >= 0 ? "+" : ""}{mergeInsertStartFrame}f</span>
                </p>
                <p>
                  Insert window now: <span className="font-medium text-ink">f{mergeInsertStartFrameEffective}</span> to{" "}
                  <span className="font-medium text-ink">f{Math.max(mergeInsertStartFrameEffective, mergeEffectiveEndFrameExclusive - 1)}</span>
                </p>
                <p className={mergeEndOffsetFrames !== 0 ? "font-semibold text-orange-700" : ""}>
                  End shift from original cut: {mergeEndOffsetFrames >= 0 ? "+" : ""}
                  {mergeEndOffsetFrames} frames ({(mergeEndOffsetFrames / Math.max(1, mergeFps)).toFixed(2)}s)
                </p>
              </div>
              {selectedToolId === "merge" && mergeTargetCrop ? (
                <div className="space-y-3 rounded-lg border border-ink/10 bg-white p-3">
                  <div>
                    <p className="text-sm font-medium text-ink">Crop edge feather</p>
                    <p className="mt-1 text-[11px] text-ink/60">
                      Feather is measured inward from each crop edge. Edge alpha uses `edgeOpacity = edgeDistancePx / (featherPx + 1)`.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <label className="space-y-1 text-xs text-ink/70">
                      <span className="block font-medium text-ink/80">Top (px)</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, mergeTargetCrop.height - 1)}
                        value={effectiveCropEdgeFeather.top}
                        onChange={(event) =>
                          setCropEdgeFeather((previous) => ({
                            ...previous,
                            top: clampInteger(Number(event.target.value) || 0, 0, Math.max(0, mergeTargetCrop.height - 1)),
                          }))
                        }
                        className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-ink/70">
                      <span className="block font-medium text-ink/80">Right (px)</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, mergeTargetCrop.width - 1)}
                        value={effectiveCropEdgeFeather.right}
                        onChange={(event) =>
                          setCropEdgeFeather((previous) => ({
                            ...previous,
                            right: clampInteger(Number(event.target.value) || 0, 0, Math.max(0, mergeTargetCrop.width - 1)),
                          }))
                        }
                        className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-ink/70">
                      <span className="block font-medium text-ink/80">Bottom (px)</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, mergeTargetCrop.height - 1)}
                        value={effectiveCropEdgeFeather.bottom}
                        onChange={(event) =>
                          setCropEdgeFeather((previous) => ({
                            ...previous,
                            bottom: clampInteger(Number(event.target.value) || 0, 0, Math.max(0, mergeTargetCrop.height - 1)),
                          }))
                        }
                        className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-ink/70">
                      <span className="block font-medium text-ink/80">Left (px)</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, mergeTargetCrop.width - 1)}
                        value={effectiveCropEdgeFeather.left}
                        onChange={(event) =>
                          setCropEdgeFeather((previous) => ({
                            ...previous,
                            left: clampInteger(Number(event.target.value) || 0, 0, Math.max(0, mergeTargetCrop.width - 1)),
                          }))
                        }
                        className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                      />
                    </label>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
                    <label className="space-y-1 text-xs text-ink/70">
                      <span className="block font-medium text-ink/80">Preview source frame</span>
                      <input
                        type="number"
                        min={cropPreviewSourceFrameMin}
                        max={cropPreviewSourceFrameMax}
                        value={cropPreviewSourceFrame}
                        onChange={(event) =>
                          setCropPreviewSourceFrame(
                            clampInteger(Number(event.target.value) || cropPreviewSourceFrameMin, cropPreviewSourceFrameMin, cropPreviewSourceFrameMax),
                          )
                        }
                        className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                      />
                      <p className="text-[11px] text-ink/60">
                        Source f{cropPreviewSourceFrame} aligned to generated g{cropPreviewDisplayFrame}.
                      </p>
                    </label>
                    <div>
                      <CropEdgeFeatherPreview
                        originalImageUrl={cropPreviewOriginalImageUrl}
                        generatedImageUrl={cropPreviewGeneratedImageUrl}
                        crop={mergeTargetCrop}
                        sourceWidth={mergeSourceWidth}
                        sourceHeight={mergeSourceHeight}
                        featherTop={effectiveCropEdgeFeather.top}
                        featherRight={effectiveCropEdgeFeather.right}
                        featherBottom={effectiveCropEdgeFeather.bottom}
                        featherLeft={effectiveCropEdgeFeather.left}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <MergeBoundaryPreview
                title="Start merge point preview"
                actionLabel="Zoom start boundary"
                onAction={openStartBoundaryZoom}
                firstTrack={{
                  title: "Source track",
                  items: startBoundaryOriginalThumbs,
                  anchorFrame: mergeInsertStartFrameEffective,
                  anchorEdge: "start",
                  anchorSlotIndex: 3,
                  overlapStart: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeInsertStartFrameEffective : undefined,
                  overlapEnd: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeInsertStartFrameEffective + mergeFeatherClamped - 1 : undefined,
                  prefix: "f",
                  frameLabelPosition: "top",
                }}
                secondTrack={{
                  title: "Generated track",
                  items: startBoundaryGeneratedThumbs,
                  anchorFrame: mergeGeneratedStartAnchor,
                  anchorEdge: "start",
                  anchorSlotIndex: 3,
                  overlapStart: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor : undefined,
                  overlapEnd: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor + mergeFeatherClamped - 1 : undefined,
                  prefix: "g",
                }}
              />
            </div>

            <div className="space-y-2">
              <MergeBoundaryPreview
                title="End merge point preview"
                actionLabel="Zoom end boundary"
                onAction={openEndBoundaryZoom}
                firstTrack={{
                  title: "Generated track",
                  items: endBoundaryGeneratedThumbs,
                  anchorFrame: mergeGeneratedEndAnchor,
                  anchorEdge: "end",
                  anchorSlotIndex: 2,
                  overlapStart: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor - mergeFeatherClamped + 1 : undefined,
                  overlapEnd: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor : undefined,
                  prefix: "g",
                }}
                secondTrack={{
                  title: "Source track",
                  items: endBoundaryOriginalThumbs,
                  anchorFrame: mergeEffectiveEndFrameExclusive,
                  anchorEdge: "start",
                  anchorSlotIndex: 3,
                  overlapStart: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive - mergeFeatherClamped : undefined,
                  overlapEnd: selectedToolId === "merge" && mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive - 1 : undefined,
                  prefix: "f",
                  frameLabelPosition: "top",
                }}
              />
            </div>
          </>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {selectedToolId === "align_retime" ? (
            <button
              type="button"
              className="rounded-md bg-teal-600 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!mergeTargetGeneration || isReconcilingTiming}
              onClick={reconcileTiming}
            >
              <PendingButtonLabel isPending={isReconcilingTiming} idle="Create aligned/retimed output" pending="Reconciling timing..." />
            </button>
          ) : null}
          <button
            className={`rounded-md px-4 py-2 disabled:cursor-not-allowed disabled:opacity-60 ${
              selectedToolId === "merge" ? "bg-accent2 text-white" : "border border-ink/20 bg-white text-ink"
            }`}
            disabled={!mergeTargetGeneration || mergeMutation.isPending}
            onClick={() =>
              mergeMutation.mutate(
                selectedToolId === "merge" && mergeTargetCrop
                  ? {
                      cropEdgeFeather: effectiveCropEdgeFeather,
                    }
                  : undefined,
              )
            }
          >
            <PendingButtonLabel isPending={mergeMutation.isPending} idle="Merge generated output" pending="Merging..." />
          </button>
        </div>
        {extendGenerationError ? (
          <StatusNotice variant="error">
            <p>{extendGenerationError}</p>
          </StatusNotice>
        ) : null}
      </div>
      </>
      ) : null}
      {showMergeIntoSourceTool && selectedToolId === "merge" ? (
      <div className="space-y-2">
        <p className="text-sm font-medium text-ink/80">Merged exports</p>
        {!sortedExports.length ? <p className="text-sm text-ink/60">No merged exports yet.</p> : null}
        {sortedExports.map((exp) => (
          <div key={exp.exportId} className="rounded border border-ink/10 p-3">
            <p className="font-medium">{humanizeFilename(keyBasenameFromS3Key(exp.outputKey || `${exp.exportId}.mp4`))}</p>
            <p className="text-xs text-ink/60">
              {exp.exportId} · {formatCompactTimestamp(exp.createdAt)}
            </p>
            {exp.motionSyncQc?.status ? (
              <p
                className={`text-xs ${
                  exp.motionSyncQc.status === "failed"
                    ? "text-red-700"
                    : exp.motionSyncQc.status === "complete"
                      ? "text-teal-700"
                      : "text-amber-700"
                }`}
              >
                Motion QA: {exp.motionSyncQc.status}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {exp.downloadUrl ? (
                <a
                  className="rounded border border-ink/20 bg-white px-3 py-1.5 text-sm text-ink"
                  href={exp.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download merged video
                </a>
              ) : null}
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-sm text-white"
                onClick={() => openMotionSyncModal(exp.exportId)}
              >
                Motion QA
              </button>
            </div>
          </div>
        ))}
      </div>
      ) : null}
      {nextWarning && (selectedToolId === "align_retime" || selectedToolId === "merge") ? (
        <StatusNotice variant="warning">
          <p className="text-xs">{nextWarning}</p>
        </StatusNotice>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={nextDisabled}
          onClick={onNext}
        >
          Next
        </button>
      </div>
      {boundaryZoomModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4">
          <div className="max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-lg font-semibold">{boundaryZoomModal.title}</h4>
              </div>
              <button
                type="button"
                className="rounded border border-ink/20 px-2 py-1 text-sm"
                onClick={() => setBoundaryZoomModal(null)}
              >
                Close
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink/10 bg-bg px-3 py-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded border border-ink/20 px-2 py-1 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!boundaryZoomCanStepBackward}
                    onClick={() => nudgeBoundaryZoomFrameOffset(-1)}
                  >
                    &#8249;
                  </button>
                  <p className="text-xs text-ink/65">Step through boundary frames</p>
                  <button
                    type="button"
                    className="rounded border border-ink/20 px-2 py-1 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!boundaryZoomCanStepForward}
                    onClick={() => nudgeBoundaryZoomFrameOffset(1)}
                  >
                    &#8250;
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-xs text-ink/65">Source insert start</p>
                  <button
                    type="button"
                    className="rounded border border-ink/20 px-2 py-1 text-sm text-ink"
                    onClick={() => nudgeMergeInsertStart(-1)}
                  >
                    -1
                  </button>
                  <p className="min-w-12 text-center text-sm font-medium text-ink">
                    {mergeInsertStartFrame >= 0 ? "+" : ""}
                    {mergeInsertStartFrame}f
                  </p>
                  <button
                    type="button"
                    className="rounded border border-ink/20 px-2 py-1 text-sm text-ink"
                    onClick={() => nudgeMergeInsertStart(1)}
                  >
                    +1
                  </button>
                </div>
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                {boundaryZoomPairs.map((pair) => (
                  <div key={`${pair.originalFrameIndex}:${pair.generatedFrameIndex}`} className="space-y-2 rounded-lg border border-ink/10 p-3">
                    {boundaryZoomModal.crop?.enabled ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-xs font-medium text-ink/80">Source f{pair.originalFrameIndex}</p>
                          {pair.originalImageUrl ? (
                            <img src={pair.originalImageUrl} alt={`Source frame ${pair.originalFrameIndex}`} className="h-44 w-full rounded-lg border border-ink/10 object-contain bg-bg" />
                          ) : (
                            <div className="flex h-44 items-center justify-center rounded-lg border border-ink/10 bg-bg text-xs text-ink/55">Source unavailable</div>
                          )}
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-ink/80">Generated g{pair.generatedFrameIndex}</p>
                          {pair.generatedImageUrl ? (
                            <img src={pair.generatedImageUrl} alt={`Generated frame ${pair.generatedFrameIndex}`} className="h-44 w-full rounded-lg border border-ink/10 object-contain bg-bg" />
                          ) : (
                            <div className="flex h-44 items-center justify-center rounded-lg border border-ink/10 bg-bg text-xs text-ink/55">Generated unavailable</div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <p className="mb-1 text-xs font-medium text-ink/80">Source f{pair.originalFrameIndex}</p>
                          {pair.originalImageUrl ? (
                            <img src={pair.originalImageUrl} alt={`Source frame ${pair.originalFrameIndex}`} className="h-56 w-full rounded-lg border border-ink/10 object-contain bg-bg" />
                          ) : (
                            <div className="flex h-56 items-center justify-center rounded-lg border border-ink/10 bg-bg text-xs text-ink/55">Source unavailable</div>
                          )}
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-ink/80">Generated g{pair.generatedFrameIndex}</p>
                          {pair.generatedImageUrl ? (
                            <img src={pair.generatedImageUrl} alt={`Generated frame ${pair.generatedFrameIndex}`} className="h-56 w-full rounded-lg border border-ink/10 object-contain bg-bg" />
                          ) : (
                            <div className="flex h-56 items-center justify-center rounded-lg border border-ink/10 bg-bg text-xs text-ink/55">Generated unavailable</div>
                          )}
                        </div>
                      </div>
                    )}
                    {boundaryZoomModal.crop?.enabled ? (
                      <div>
                        <p className="mb-1 text-xs font-medium text-ink/80">Crop merged back into source frame</p>
                        <CropOverlayPreview
                          originalImageUrl={pair.originalImageUrl}
                          generatedImageUrl={pair.generatedImageUrl}
                          crop={boundaryZoomModal.crop}
                          sourceWidth={mergeSourceWidth}
                          sourceHeight={mergeSourceHeight}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

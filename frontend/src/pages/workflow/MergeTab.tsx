import { useMemo, useState, type ComponentType } from "react";

import { HelpInfoButton, PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import { useVideoFrameStrip, type VideoFrameStripItem } from "../../hooks/useVideoFrameStrip";
import { getGenerationModeConfig, type GenerateInputMode } from "../../lib/generationModeRegistry";
import type { ExportRecord, SegmentGeneration, SegmentRecord } from "../../types/api";

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
  mergeMutation: { isPending: boolean; mutate: () => void };
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
  openVideoCleanupModal: (generation: SegmentGeneration) => void;
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
    openVideoCleanupModal,
  } = ctx;
  const [isExtendModalOpen, setIsExtendModalOpen] = useState(false);
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
  const visibleToolCount = [
    showExtendTool,
    showReconcileTimingTool,
    showTrackedCleanupTool,
    showMergeIntoSourceTool,
  ].filter(Boolean).length;
  const toolGridClass =
    visibleToolCount <= 1
      ? "grid gap-3"
      : visibleToolCount === 2
        ? "grid gap-3 lg:grid-cols-2"
        : visibleToolCount === 3
          ? "grid gap-3 lg:grid-cols-3"
          : "grid gap-3 lg:grid-cols-4";
  const cleanupEligibleGeneration =
    showTrackedCleanupTool && mergeTargetGeneration?.status === "complete" && Boolean(mergeTargetGeneration.downloadUrl)
      ? mergeTargetGeneration
      : null;
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

  function resetExtendModalForGeneration(generation: SegmentGeneration | null) {
    const segment = generation ? getSegmentForGeneration(generation) : null;
    const defaultAlignment = Math.max(0, (segment?.endFrameExclusive ?? 1) - 6);
    const defaultDuration = Math.max(1, Math.ceil(segment?.durationSec ?? 5));
    setExtendGenerationId(generation?.genId ?? "");
    setExtendAlignmentFrame(String(defaultAlignment));
    setExtendAnchorFramesFromEnd("5");
    setExtendDurationSeconds(String(defaultDuration));
    setExtendPrompt(generation?.luma.prompt ?? "");
  }

  function openExtendModal() {
    resetExtendModalForGeneration(mergeTargetGeneration ?? completeGenerations[0] ?? null);
    setIsExtendModalOpen(true);
  }

  function handleExtendGenerationChange(genId: string) {
    const generation = completeGenerations.find((item) => item.genId === genId) ?? null;
    resetExtendModalForGeneration(generation);
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
    setIsExtendModalOpen(false);
  }

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
        <div className={toolGridClass}>
          {showExtendTool ? (
            <div className="rounded-lg border border-ink/10 bg-white p-3">
              <p className="text-sm font-medium text-ink">Extend long outputs</p>
              <p className="mt-1 text-xs text-ink/65">
                Continue from an existing output by selecting an anchor near its end and creating the next working-range continuation.
              </p>
              <button
                type="button"
                className="mt-3 rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!completeGenerations.length || isExtendingGeneration}
                onClick={openExtendModal}
              >
                <PendingButtonLabel isPending={isExtendingGeneration} idle="Extend output" pending="Queueing extension..." />
              </button>
            </div>
          ) : null}
          {showReconcileTimingTool ? (
            <div className="rounded-lg border border-ink/10 bg-white p-3">
              <p className="text-sm font-medium text-ink">Reconcile timing</p>
              <p className="mt-1 text-xs text-ink/65">
                Create a new derived output using the current opening trim, tail trim, and optional uniform retime settings below.
              </p>
              <button
                type="button"
                className="mt-3 rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!cleanupEligibleGeneration || isReconcilingTiming}
                onClick={reconcileTiming}
              >
                <PendingButtonLabel isPending={isReconcilingTiming} idle="Create reconciled output" pending="Reconciling timing..." />
              </button>
              {!cleanupEligibleGeneration ? (
                <p className="mt-2 text-[11px] text-ink/55">Select a successful first frame + video output in Generate before reconciling timing.</p>
              ) : (
                <p className="mt-2 text-[11px] text-ink/55">This creates a new working-range output for cleanup or merge. It does not merge into source yet.</p>
              )}
            </div>
          ) : null}
          {showTrackedCleanupTool ? (
            <div className="rounded-lg border border-ink/10 bg-white p-3">
              <p className="text-sm font-medium text-ink">Tracked keep-mask cleanup</p>
              <p className="mt-1 text-xs text-ink/65">
                Best used after extension or stitch review, once timing is close enough, and before the final merge into source.
              </p>
              <button
                type="button"
                className="mt-3 rounded-md border border-accent/25 bg-white px-3 py-2 text-sm font-medium text-accent disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!cleanupEligibleGeneration}
                onClick={() => {
                  if (!cleanupEligibleGeneration) return;
                  openVideoCleanupModal(cleanupEligibleGeneration);
                }}
              >
                Open cleanup
              </button>
              {!cleanupEligibleGeneration ? (
                <p className="mt-2 text-[11px] text-ink/55">Select a successful first frame + video output in Generate before opening cleanup.</p>
              ) : null}
            </div>
          ) : null}
          {showMergeIntoSourceTool ? (
            <div className="rounded-lg border border-teal-500 bg-teal-50 p-3">
              <p className="text-sm font-medium text-ink">Merge into source</p>
              <p className="mt-1 text-xs text-ink/70">
                Align the chosen working-range output against the original timeline, trim if needed, then create a merged export below.
              </p>
              <p className="mt-3 text-xs font-semibold text-teal-700">
                {mergeTargetGeneration ? "Current output ready for merge review below." : "Choose an output in Outputs first."}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      {showMergeIntoSourceTool ? (
      <>
      <div className="rounded-lg border border-ink/15 bg-bg p-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Merge into source</p>
          <HelpInfoButton
            title="Merge into source video"
            lines={[
              "This step takes the chosen output from Outputs and re-inserts it into the original timeline.",
              "Many models drop or reinterpret the first few generated frames. Use trim start and insert start together to bring the generated clip back into sync.",
              "Trim end lets you shorten the generated tail before reinserting it. Use feather only after timing looks right.",
              "Use the zoom buttons on the start and end previews to inspect three generated frames around each merge line.",
              "Solid teal lines show the cut points. Dashed amber lines show blend boundaries from temporal feathering.",
              "When a crop is active, zoom preview also shows the generated crop overlaid back onto the original full frame at the stored crop position.",
            ]}
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
              <div className="grid gap-3 xl:grid-cols-2">
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink/55">End alignment and blend</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <NumberAdjustField
                      label="Trim generation end"
                      hint="Hide inconsistent generated tail frames at the end of the insert."
                      value={mergeTrimEndFrames}
                      min={0}
                      max={Math.max(0, mergeGeneratedDurationFrames - 1)}
                      onChange={setMergeTrimEndFrames}
                    />
                    <NumberAdjustField
                      label="Temporal feather"
                      hint="Blend a small overlap only after the timing looks right."
                      value={temporalFeatherFrames}
                      min={0}
                      max={30}
                      onChange={setTemporalFeatherFrames}
                    />
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
                  overlapStart: mergeFeatherClamped > 0 ? mergeInsertStartFrameEffective : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeInsertStartFrameEffective + mergeFeatherClamped - 1 : undefined,
                  prefix: "f",
                  frameLabelPosition: "top",
                }}
                secondTrack={{
                  title: "Generated track",
                  items: startBoundaryGeneratedThumbs,
                  anchorFrame: mergeGeneratedStartAnchor,
                  anchorEdge: "start",
                  anchorSlotIndex: 3,
                  overlapStart: mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor + mergeFeatherClamped - 1 : undefined,
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
                  overlapStart: mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor - mergeFeatherClamped + 1 : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor : undefined,
                  prefix: "g",
                }}
                secondTrack={{
                  title: "Source track",
                  items: endBoundaryOriginalThumbs,
                  anchorFrame: mergeEffectiveEndFrameExclusive,
                  anchorEdge: "start",
                  anchorSlotIndex: 3,
                  overlapStart: mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive - mergeFeatherClamped : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive - 1 : undefined,
                  prefix: "f",
                  frameLabelPosition: "top",
                }}
              />
            </div>
          </>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-md bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!mergeTargetGeneration || mergeMutation.isPending}
            onClick={() => mergeMutation.mutate()}
          >
            <PendingButtonLabel isPending={mergeMutation.isPending} idle="Merge chosen output" pending="Merging..." />
          </button>
          <button
            type="button"
            className="rounded-md border border-ink/20 bg-white px-4 py-2 text-ink disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!completeGenerations.length || isExtendingGeneration}
            onClick={openExtendModal}
          >
            <PendingButtonLabel isPending={isExtendingGeneration} idle="Extend output" pending="Queueing extension..." />
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
      {showMergeIntoSourceTool ? (
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
      {nextWarning ? (
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
      {isExtendModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-lg font-semibold">Extend output</h4>
                <p className="mt-1 text-sm text-ink/60">
                  Creates the next working-range continuation and uses an anchor frame from the previous output as the new first-frame edit.
                </p>
              </div>
              <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm" onClick={() => setIsExtendModalOpen(false)}>
                Close
              </button>
            </div>
            <div className="mt-4 space-y-3">
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
              <p className="text-xs text-ink/60">
                Default alignment is five frames before the previous range's last source frame. Adjust it to the original frame that visually matches the
                chosen anchor. The default offset uses frame five before the output ends.
              </p>
              {selectedExtendSegment ? (
                <p className="rounded-md bg-bg p-2 text-xs text-ink/70">
                  Previous working range: {describeSegment(selectedExtendSegment)}. The next continuation will start at source f{Number.isFinite(parsedAlignmentFrame) ? parsedAlignmentFrame : 0}.
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
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className="rounded border border-ink/20 px-4 py-2" onClick={() => setIsExtendModalOpen(false)}>
                  Cancel
                </button>
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
        </div>
      ) : null}
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

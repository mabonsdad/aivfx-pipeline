import { useMemo, useState, type ComponentType } from "react";

import { HelpInfoButton, PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import type { ExportRecord, SegmentGeneration, SegmentRecord } from "../../types/api";

type VideoFrameStripItem = {
  frameIndex: number;
  imageUrl: string | null;
};

export type MergeTabCtx = {
  onNext: () => void;
  nextDisabled: boolean;
  nextWarning: string | null;
  generationInputMode: "start_video" | "start_end" | "start_only";
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
  mergeEffectiveDurationFrames: number;
  mergeInsertStartFrameClamped: number;
  mergeEffectiveEndFrameExclusive: number;
  mergeEndOffsetFrames: number;
  mergeGeneratedStartAnchor: number;
  mergeFeatherClamped: number;
  startBoundaryOriginalThumbs: VideoFrameStripItem[];
  startBoundaryGeneratedThumbs: VideoFrameStripItem[];
  MergeBoundaryPreview: ComponentType<{
    title: string;
    subtitle: string;
    firstTrack: {
      title: string;
      items: VideoFrameStripItem[];
      anchorFrame: number;
      overlapStart?: number;
      overlapEnd?: number;
      prefix: string;
    };
    secondTrack: {
      title: string;
      items: VideoFrameStripItem[];
      anchorFrame: number;
      overlapStart?: number;
      overlapEnd?: number;
      prefix: string;
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
      lateMedianDriftFrames: number;
      residualEndFrames: number;
      meanAbsDriftFrames: number;
      residualMeanAbsDriftFrames: number;
      suggestedPlaybackRate: number;
      recommendation: string;
      confidence: number;
      notes: string[];
    };
  } | null;
  mergeAlignmentSuggestionError: string | null;
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
  title: string;
  subtitle: string;
  pairs: BoundaryZoomPair[];
  crop: SegmentRecord["crop"] | null;
};

function clampInt(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
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

function NudgeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px] text-ink/80 transition hover:border-teal-500 hover:text-teal-700"
      onClick={onClick}
    >
      {label}
    </button>
  );
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
      <div className="mt-3 flex flex-wrap gap-1.5">
        <NudgeButton label="-5" onClick={() => onChange(clampInt(value - 5, min, max))} />
        <NudgeButton label="-1" onClick={() => onChange(clampInt(value - 1, min, max))} />
        <NudgeButton label="+1" onClick={() => onChange(clampInt(value + 1, min, max))} />
        <NudgeButton label="+5" onClick={() => onChange(clampInt(value + 5, min, max))} />
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
    mergeMaxFrameIndex,
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
    mergeEffectiveDurationFrames,
    mergeInsertStartFrameClamped,
    mergeEffectiveEndFrameExclusive,
    mergeEndOffsetFrames,
    mergeGeneratedStartAnchor,
    mergeFeatherClamped,
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
    mergeAlignmentSuggestion,
    mergeAlignmentSuggestionError,
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
  const cleanupEligibleGeneration =
    generationInputMode === "start_video" &&
    mergeTargetGeneration?.status === "complete" &&
    Boolean(mergeTargetGeneration.downloadUrl) &&
    mergeTargetGeneration.luma.provider === "luma" &&
    !mergeTargetGeneration.derivedFromGenerationId
      ? mergeTargetGeneration
      : null;

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
      title: "Start merge zoom",
      subtitle: `source f${mergeInsertStartFrameClamped} aligned to generated g${mergeGeneratedStartAnchor}`,
      pairs: buildBoundaryZoomPairs(
        startBoundaryGeneratedThumbs,
        mergeGeneratedStartAnchor,
        startBoundaryOriginalThumbs,
        mergeInsertStartFrameClamped,
      ),
      crop: mergeTargetSegment?.crop ?? null,
    });
  }

  function openEndBoundaryZoom() {
    setBoundaryZoomModal({
      title: "End merge zoom",
      subtitle: `generated g${mergeGeneratedEndAnchor} resolving back to source f${mergeEffectiveEndFrameExclusive}`,
      pairs: buildBoundaryZoomPairs(
        endBoundaryGeneratedThumbs,
        mergeGeneratedEndAnchor,
        endBoundaryOriginalThumbs,
        mergeEffectiveEndFrameExclusive,
      ),
      crop: mergeTargetSegment?.crop ?? null,
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ink/15 bg-bg p-3">
        <div className="grid gap-3 lg:grid-cols-3">
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
          {generationInputMode === "start_video" ? (
            <div className="rounded-lg border border-ink/10 bg-white p-3">
              <p className="text-sm font-medium text-ink">Refine generated video</p>
              <p className="mt-1 text-xs text-ink/65">
                Use tracked keep-mask cleanup on a generated working-range output before final merge. This is currently available for successful Luma generations.
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
                Refine chosen output
              </button>
              {!cleanupEligibleGeneration ? (
                <p className="mt-2 text-[11px] text-ink/55">Select a successful Luma output in Outputs to refine it here.</p>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg border border-ink/10 bg-white p-3">
              <p className="text-sm font-medium text-ink">Refine generated video</p>
              <p className="mt-1 text-xs text-ink/65">
                Hidden by default on this route. Keep-mask video refine is primarily used for first frame + video source-motion generations.
              </p>
            </div>
          )}
          <div className="rounded-lg border border-teal-500 bg-teal-50 p-3">
            <p className="text-sm font-medium text-ink">Merge into source</p>
            <p className="mt-1 text-xs text-ink/70">
              Align the chosen working-range output against the original timeline, trim if needed, then create a merged export below.
            </p>
            <p className="mt-3 text-xs font-semibold text-teal-700">
              {mergeTargetGeneration ? "Current output ready for merge review below." : "Choose an output in Outputs first."}
            </p>
          </div>
        </div>
      </div>
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
        <div className="space-y-2 rounded-lg border border-ink/10 p-3">
          <p className="text-sm font-medium">Chosen output in use</p>
          {!mergeTargetGeneration ? (
            <p className="text-sm text-ink/60">No output selected in Outputs yet.</p>
          ) : (
            <div className="rounded border border-teal-500 bg-teal-50 p-2">
              <p className="text-sm font-semibold">{describeGeneration(mergeTargetGeneration)}</p>
              <p className="text-xs text-ink/50">{mergeTargetGeneration.genId}</p>
            </div>
          )}
          {mergeTargetSegment ? <p className="text-xs text-ink/60">Current working range: {describeSegment(mergeTargetSegment)}</p> : null}
        </div>

        {mergeTargetGeneration && mergeTargetSegment ? (
          <>
            <div className="space-y-3 rounded-lg border border-ink/10 p-3">
              <p className="text-sm font-medium">Advanced merge alignment</p>
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
                    Suggestion: <span className="font-medium text-ink">{mergeAlignmentSuggestion.analysis.recommendation.split("_").join(" ")}</span> ·
                    confidence {mergeAlignmentSuggestion.analysis.confidence.toFixed(2)}
                  </p>
                ) : null}
              </div>
              {mergeAlignmentSuggestion ? (
                <StatusNotice
                  variant={
                    mergeAlignmentSuggestion.analysis.recommendation === "rerender_recommended"
                      ? "error"
                      : mergeAlignmentSuggestion.analysis.recommendation === "retime_recommended"
                        ? "warning"
                        : "info"
                  }
                >
                  <div className="space-y-1 text-xs">
                    <p>
                      Suggested controls: insert at f{mergeAlignmentSuggestion.suggested.startFrameOverride}, trim opening{" "}
                      {mergeAlignmentSuggestion.suggested.trimStartFrames}f, trim tail {mergeAlignmentSuggestion.suggested.trimEndFrames}f.
                    </p>
                    <p>
                      Start offset {mergeAlignmentSuggestion.analysis.sourceFrameOffset}f · residual end drift{" "}
                      {mergeAlignmentSuggestion.analysis.residualEndFrames >= 0 ? "+" : ""}
                      {mergeAlignmentSuggestion.analysis.residualEndFrames}f · estimated retime {mergeAlignmentSuggestion.analysis.suggestedPlaybackRate.toFixed(4)}x
                    </p>
                    {mergeAlignmentSuggestion.analysis.notes.map((note) => (
                      <p key={note}>{note}</p>
                    ))}
                  </div>
                </StatusNotice>
              ) : null}
              {mergeAlignmentSuggestionError ? (
                <StatusNotice variant="error">
                  <p className="text-xs">{mergeAlignmentSuggestionError}</p>
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
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                <div className="space-y-3 rounded-lg border border-ink/10 bg-bg p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink/55">Start alignment</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <NumberAdjustField
                      label="Source insert start"
                      hint="Move where the generated clip begins on the source timeline."
                      value={mergeInsertStartFrame}
                      min={0}
                      max={mergeMaxFrameIndex}
                      onChange={setMergeInsertStartFrame}
                    />
                    <NumberAdjustField
                      label="Trim generated opening"
                      hint="Drop opening generated frames if the model loses sync at the start."
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
                      label="Trim generated tail"
                      hint="Shorten the generated end if it drifts or overruns the source cut."
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
                  Insert window now: <span className="font-medium text-ink">f{mergeInsertStartFrameClamped}</span> to{" "}
                  <span className="font-medium text-ink">f{Math.max(mergeInsertStartFrameClamped, mergeEffectiveEndFrameExclusive - 1)}</span>
                </p>
                <p className={mergeEndOffsetFrames !== 0 ? "font-semibold text-orange-700" : ""}>
                  End shift from original cut: {mergeEndOffsetFrames >= 0 ? "+" : ""}
                  {mergeEndOffsetFrames} frames ({(mergeEndOffsetFrames / Math.max(1, mergeFps)).toFixed(2)}s)
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-end">
                <button
                  type="button"
                  className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-xs text-ink transition hover:border-teal-500 hover:text-teal-700"
                  onClick={openStartBoundaryZoom}
                >
                  Zoom start boundary
                </button>
              </div>
              <MergeBoundaryPreview
                title="Start merge point preview"
                subtitle={`original f${mergeInsertStartFrameClamped} -> generated g${mergeGeneratedStartAnchor}`}
                firstTrack={{
                  title: "Original track around start cut",
                  items: startBoundaryOriginalThumbs,
                  anchorFrame: mergeInsertStartFrameClamped,
                  overlapStart: mergeFeatherClamped > 0 ? mergeInsertStartFrameClamped : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeInsertStartFrameClamped + mergeFeatherClamped - 1 : undefined,
                  prefix: "f",
                }}
                secondTrack={{
                  title: "Generated track around start cut",
                  items: startBoundaryGeneratedThumbs,
                  anchorFrame: mergeGeneratedStartAnchor,
                  overlapStart: mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor + mergeFeatherClamped - 1 : undefined,
                  prefix: "g",
                }}
              />
            </div>

            <div className="space-y-2">
              <div className="flex justify-end">
                <button
                  type="button"
                  className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-xs text-ink transition hover:border-teal-500 hover:text-teal-700"
                  onClick={openEndBoundaryZoom}
                >
                  Zoom end boundary
                </button>
              </div>
              <MergeBoundaryPreview
                title="End merge point preview"
                subtitle={`generated g${mergeGeneratedEndAnchor} -> original f${mergeEffectiveEndFrameExclusive}`}
                firstTrack={{
                  title: "Generated track around end cut",
                  items: endBoundaryGeneratedThumbs,
                  anchorFrame: mergeGeneratedEndAnchor,
                  overlapStart: mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor - mergeFeatherClamped + 1 : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor : undefined,
                  prefix: "g",
                }}
                secondTrack={{
                  title: "Original track after generated segment",
                  items: endBoundaryOriginalThumbs,
                  anchorFrame: mergeEffectiveEndFrameExclusive,
                  overlapStart: mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive : undefined,
                  overlapEnd: mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive + mergeFeatherClamped - 1 : undefined,
                  prefix: "f",
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
                <a className="rounded border border-ink/20 bg-white px-3 py-1.5 text-sm text-ink" href={exp.downloadUrl}>
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
                <p className="mt-1 text-sm text-ink/60">{boundaryZoomModal.subtitle}</p>
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
              <div className={`grid gap-4 ${boundaryZoomModal.crop?.enabled ? "xl:grid-cols-3" : "lg:grid-cols-3"}`}>
                {boundaryZoomModal.pairs.map((pair) => (
                  <div key={`${pair.originalFrameIndex}:${pair.generatedFrameIndex}`} className="space-y-2 rounded-lg border border-ink/10 p-3">
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
              <p className="text-xs text-ink/60">
                Use trim generated opening if the AI output starts late. Use source insert start to move the whole generated clip on the source timeline, then trim tail if the end overruns.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

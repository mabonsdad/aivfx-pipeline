import { useMemo, useState, type ComponentType } from "react";

import type { ExportRecord, SegmentGeneration, SegmentRecord } from "../../types/api";

type VideoFrameStripItem = {
  frameIndex: number;
  imageUrl: string | null;
};

export type MergeTabCtx = {
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
  mergeMutation: { isPending: boolean; mutate: () => void };
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
};

type MergeTabProps = {
  ctx: MergeTabCtx;
};

export default function MergeTab({ ctx }: MergeTabProps) {
  const {
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
    mergeMutation,
    extendGeneration,
    isExtendingGeneration,
    extendGenerationError,
    sortedExports,
    humanizeFilename,
    keyBasenameFromS3Key,
    formatCompactTimestamp,
    openMotionSyncModal,
  } = ctx;
  const [isExtendModalOpen, setIsExtendModalOpen] = useState(false);
  const [extendGenerationId, setExtendGenerationId] = useState("");
  const [extendAlignmentFrame, setExtendAlignmentFrame] = useState("");
  const [extendAnchorFramesFromEnd, setExtendAnchorFramesFromEnd] = useState("5");
  const [extendDurationSeconds, setExtendDurationSeconds] = useState("");
  const [extendPrompt, setExtendPrompt] = useState("");
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

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Merge Video</h3>
      <div className="rounded-lg border border-ink/15 bg-bg p-3">
        <p className="text-sm font-semibold">Merge step guide</p>
        <div className="mt-2 space-y-2 text-xs text-ink/70">
          <p>The step takes the generated video (segment) selected in Generate Video, and re-inserts it into the original timeline.</p>
          <p>By default the generated clip starts at the original cut start. If it is longer, the end lands later in the timeline.</p>
          <p>Use trim start/end and insert start controls, then review the stacked track previews before merging.</p>
          <p>Solid teal lines show the cut points. Dashed amber lines show blend boundaries from temporal feathering.</p>
          <p className="font-semibold uppercase tracking-wide text-orange-700">
            This is an experiment to highlight the challenges merging AI and real content!
          </p>
        </div>
      </div>
      <div className="space-y-3">
        <div className="space-y-2 rounded-lg border border-ink/10 p-3">
          <p className="text-sm font-medium">Generation in use</p>
          {!mergeTargetGeneration ? (
            <p className="text-sm text-ink/60">No generation selected in Generate Video yet.</p>
          ) : (
            <div className="rounded border border-teal-500 bg-teal-50 p-2">
              <p className="text-sm font-semibold">{describeGeneration(mergeTargetGeneration)}</p>
              <p className="text-xs text-ink/50">{mergeTargetGeneration.genId}</p>
            </div>
          )}
          {mergeTargetSegment ? <p className="text-xs text-ink/60">Current segment reference: {describeSegment(mergeTargetSegment)}</p> : null}
        </div>

        {mergeTargetGeneration && mergeTargetSegment ? (
          <>
            <div className="space-y-3 rounded-lg border border-ink/10 p-3">
              <p className="text-sm font-medium">Advanced merge alignment</p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1 text-xs text-ink/70">
                  <span className="block font-medium text-ink/80">Insert start frame</span>
                  <input
                    type="number"
                    min={0}
                    max={mergeMaxFrameIndex}
                    value={mergeInsertStartFrame}
                    onChange={(e) => setMergeInsertStartFrame(Number(e.target.value))}
                    className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-xs text-ink/70">
                  <span className="block font-medium text-ink/80">Trim generated start (frames)</span>
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, mergeGeneratedDurationFrames - 1)}
                    value={mergeTrimStartFrames}
                    onChange={(e) => setMergeTrimStartFrames(Number(e.target.value))}
                    className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-xs text-ink/70">
                  <span className="block font-medium text-ink/80">Trim generated end (frames)</span>
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, mergeGeneratedDurationFrames - 1)}
                    value={mergeTrimEndFrames}
                    onChange={(e) => setMergeTrimEndFrames(Number(e.target.value))}
                    className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-xs text-ink/70">
                  <span className="block font-medium text-ink/80">Temporal feather (frames)</span>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={temporalFeatherFrames}
                    onChange={(e) => setTemporalFeatherFrames(Number(e.target.value))}
                    className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                  />
                </label>
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
          </>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-md bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!mergeTargetGeneration || mergeMutation.isPending}
            onClick={() => mergeMutation.mutate()}
          >
            {mergeMutation.isPending ? "Merging..." : "Merge generation"}
          </button>
          <button
            type="button"
            className="rounded-md border border-ink/20 bg-white px-4 py-2 text-ink disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!completeGenerations.length || isExtendingGeneration}
            onClick={openExtendModal}
          >
            {isExtendingGeneration ? "Queueing extension..." : "Extend generation"}
          </button>
        </div>
        {extendGenerationError ? <p className="text-sm text-red-700">{extendGenerationError}</p> : null}
      </div>
      <div className="space-y-2">
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
      {isExtendModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-lg font-semibold">Extend generation</h4>
                <p className="mt-1 text-sm text-ink/60">
                  Creates the next source segment and uses a generated anchor frame from the previous result as the new first-frame edit.
                </p>
              </div>
              <button type="button" className="rounded border border-ink/20 px-2 py-1 text-sm" onClick={() => setIsExtendModalOpen(false)}>
                Close
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block space-y-1 text-sm">
                <span className="font-medium">Previous generated video</span>
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
                  <span className="block font-medium">Generated anchor offset</span>
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
                  <span className="block font-medium">Next segment seconds</span>
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
                Default alignment is five frames before the previous segment's last source frame. Adjust it to the original frame that visually matches the
                generated anchor. The anchor offset default uses frame five before the generated clip end.
              </p>
              {selectedExtendSegment ? (
                <p className="rounded-md bg-bg p-2 text-xs text-ink/70">
                  Previous segment: {describeSegment(selectedExtendSegment)}. New source segment will start at f{Number.isFinite(parsedAlignmentFrame) ? parsedAlignmentFrame : 0}.
                </p>
              ) : null}
              <label className="block space-y-1 text-sm">
                <span className="font-medium">Prompt for next segment</span>
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
                  Queue next segment
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

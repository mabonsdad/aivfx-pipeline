import { ReactCompareSlider } from "react-compare-slider";
import { useEffect, useRef, type RefObject } from "react";

import type { SegmentGeneration, SegmentRecord, TaskDetail } from "../../types/api";

type GenerateInputMode = "start_video" | "start_end" | "start_only";
type VideoModel =
  | "ray-2"
  | "ray-flash-2"
  | "runway-gen4.5"
  | "kling-2.6"
  | "veo-3.1"
  | "veo-3.1-fast"
  | "wan2.2-a14b"
  | "wan2.2-animate";

export type GenerateTabCtx = {
  setGenerationInputMode: (mode: GenerateInputMode) => void;
  setLumaModel: (model: VideoModel) => void;
  generationModelByInput: Record<GenerateInputMode, VideoModel>;
  generationInputMode: GenerateInputMode;
  selectedSegment: SegmentRecord | null;
  describeSegment: (segment: SegmentRecord) => string;
  lumaModel: VideoModel;
  setGenerationModelByInput: (
    update:
      | Record<GenerateInputMode, VideoModel>
      | ((previous: Record<GenerateInputMode, VideoModel>) => Record<GenerateInputMode, VideoModel>),
  ) => void;
  generationModelOptions: Array<{ value: VideoModel; label: string }>;
  advancedMode: string;
  setAdvancedMode: (value: string) => void;
  lumaPrompt: string;
  setLumaPrompt: (value: string) => void;
  generationInputNote: string;
  generationHelp: { title: string; lines: string[] };
  selectedSegmentOverLimit: boolean;
  lumaHardLimitSeconds: number;
  selectedSegmentId: string | null;
  generateSegmentMutation: { mutate: () => void };
  segmentWindow: { startSec: number; endSec: number; startLabel: string; endLabel: string } | null;
  originalSegmentPreviewUrl: string | null;
  selectedPreviewGeneration: SegmentGeneration | null;
  task: TaskDetail | undefined;
  compareOriginalRef: RefObject<HTMLVideoElement>;
  keepOriginalWithinSegment: (video: HTMLVideoElement) => void;
  compareVariantRef: RefObject<HTMLVideoElement>;
  syncOriginalToGenerated: (generatedVideo: HTMLVideoElement) => void;
  originalPreviewIsSegmentClip: boolean;
  selectedSegmentGenerations: SegmentGeneration[];
  generationCardsVisible: number;
  truncateIdentifier: (value: string, maxLength?: number) => string;
  selectSegmentGeneration: (genId: string) => void;
  describeGeneration: (generation: SegmentGeneration) => string;
  generationThumbnailUrl: (generation: SegmentGeneration) => string | null;
  formatCompactTimestamp: (iso: string | undefined) => string;
  setVideoPreviewModal: (value: { url: string; label: string } | null) => void;
  onAssetError: () => void;
  handleDeleteAsset: (item: {
    id: string;
    taskId: string;
    title: string;
    subtitle: string;
    createdAt: string;
    previewUrl: string;
    downloadUrl: string;
    mediaType: "image" | "video";
    deletePayload: { assetType: "segment_generation"; genId: string };
  }) => Promise<void>;
  setGenerationCardsVisible: (update: number | ((count: number) => number)) => void;
};

type GenerateTabProps = {
  ctx: GenerateTabCtx;
};

export default function GenerateTab({ ctx }: GenerateTabProps) {
  const {
    setGenerationInputMode,
    setLumaModel,
    generationModelByInput,
    generationInputMode,
    selectedSegment,
    describeSegment,
    lumaModel,
    setGenerationModelByInput,
    generationModelOptions,
    advancedMode,
    setAdvancedMode,
    lumaPrompt,
    setLumaPrompt,
    generationInputNote,
    generationHelp,
    selectedSegmentOverLimit,
    lumaHardLimitSeconds,
    selectedSegmentId,
    generateSegmentMutation,
    segmentWindow,
    originalSegmentPreviewUrl,
    selectedPreviewGeneration,
    task,
    compareOriginalRef,
    keepOriginalWithinSegment,
    compareVariantRef,
    syncOriginalToGenerated,
    originalPreviewIsSegmentClip,
    selectedSegmentGenerations,
    generationCardsVisible,
    truncateIdentifier,
    selectSegmentGeneration,
    describeGeneration,
    generationThumbnailUrl,
    formatCompactTimestamp,
    setVideoPreviewModal,
    onAssetError,
    handleDeleteAsset,
    setGenerationCardsVisible,
  } = ctx;
  const syncRafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (syncRafRef.current !== null) {
        window.cancelAnimationFrame(syncRafRef.current);
        syncRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const generated = compareVariantRef.current;
    const original = compareOriginalRef.current;
    if (!generated || !original) return;

    const stopSyncLoop = () => {
      if (syncRafRef.current !== null) {
        window.cancelAnimationFrame(syncRafRef.current);
        syncRafRef.current = null;
      }
    };

    const loopSync = () => {
      if (generated.paused || generated.ended) {
        stopSyncLoop();
        return;
      }
      syncOriginalToGenerated(generated);
      syncRafRef.current = window.requestAnimationFrame(loopSync);
    };

    const startSync = () => {
      syncOriginalToGenerated(generated);
      original.playbackRate = generated.playbackRate || 1;
      if (original.paused) {
        original.play().catch(() => undefined);
      }
      if (syncRafRef.current === null) {
        syncRafRef.current = window.requestAnimationFrame(loopSync);
      }
    };

    const pauseSync = () => {
      stopSyncLoop();
      original.pause();
    };

    const seekSync = () => {
      syncOriginalToGenerated(generated);
    };

    const onRateChange = () => {
      original.playbackRate = generated.playbackRate || 1;
      syncOriginalToGenerated(generated);
    };

    pauseSync();
    try {
      generated.currentTime = 0;
      if (segmentWindow) {
        original.currentTime = originalPreviewIsSegmentClip ? 0 : segmentWindow.startSec;
      }
    } catch {
      // no-op: browsers may reject seek before metadata is ready
    }
    seekSync();

    generated.addEventListener("play", startSync);
    generated.addEventListener("playing", startSync);
    generated.addEventListener("pause", pauseSync);
    generated.addEventListener("ended", pauseSync);
    generated.addEventListener("seeking", seekSync);
    generated.addEventListener("ratechange", onRateChange);

    return () => {
      generated.removeEventListener("play", startSync);
      generated.removeEventListener("playing", startSync);
      generated.removeEventListener("pause", pauseSync);
      generated.removeEventListener("ended", pauseSync);
      generated.removeEventListener("seeking", seekSync);
      generated.removeEventListener("ratechange", onRateChange);
      stopSyncLoop();
    };
  }, [
    compareOriginalRef,
    compareVariantRef,
    originalPreviewIsSegmentClip,
    segmentWindow,
    selectedPreviewGeneration?.genId,
    syncOriginalToGenerated,
  ]);

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Generate Video</h3>
      <div className="rounded-xl border border-ink/15 bg-white">
        <div className="flex items-end gap-1 border-b border-ink/15 px-2 pt-2">
          {[
            { id: "start_video" as const, label: "start frame + video" },
            { id: "start_end" as const, label: "start frame + end frame" },
            { id: "start_only" as const, label: "start frame only" },
          ].map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setGenerationInputMode(entry.id);
                setLumaModel(generationModelByInput[entry.id]);
              }}
              className={`rounded-t-md border px-3 py-2 text-xs ${
                generationInputMode === entry.id
                  ? "-mb-px border-ink/25 border-b-white bg-white font-semibold text-ink"
                  : "border-ink/10 bg-bg text-ink/65"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 p-3 lg:grid-cols-[1.65fr_1fr]">
          <div className="space-y-3">
            <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/70">
              Segment in use: {selectedSegment ? describeSegment(selectedSegment) : "No segment selected. Go to Pick Frame first."}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <select
                value={lumaModel}
                onChange={(e) => {
                  const nextModel = e.target.value as VideoModel;
                  setGenerationModelByInput((previous) => ({ ...previous, [generationInputMode]: nextModel }));
                  setLumaModel(nextModel);
                }}
                className="rounded-md border border-ink/20 px-3 py-2"
              >
                {generationModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {lumaModel === "ray-2" || lumaModel === "ray-flash-2" ? (
                <select value={advancedMode} onChange={(e) => setAdvancedMode(e.target.value)} className="rounded-md border border-ink/20 px-3 py-2">
                  {[
                    "adhere_1",
                    "adhere_2",
                    "adhere_3",
                    "flex_1",
                    "flex_2",
                    "flex_3",
                    "reimagine_1",
                    "reimagine_2",
                    "reimagine_3",
                  ].map((mode) => (
                    <option key={mode} value={mode}>
                      mode: {mode}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                  Mode dropdown is only used by Luma models.
                </div>
              )}
            </div>
            {lumaModel === "wan2.2-animate" ? (
              <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                Text prompt is unavailable for Wan2.2 Animate in this flow. Generation uses the selected start frame plus source segment motion.
              </div>
            ) : (
              <textarea
                value={lumaPrompt}
                onChange={(e) => setLumaPrompt(e.target.value)}
                placeholder="Optional generation prompt"
                className="h-20 w-full rounded-md border border-ink/20 p-2"
              />
            )}
            <p className="text-xs text-ink/60">{generationInputNote}</p>
          </div>
          <div className="rounded-lg border border-ink/15 bg-bg p-3">
            <p className="text-sm font-semibold">{generationHelp.title}</p>
            <div className="mt-2 space-y-2 text-xs text-ink/70">
              {generationHelp.lines.map((line: string) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        </div>
      </div>

      {selectedSegmentOverLimit ? (
        <p className="text-xs text-red-600">
          Selected segment is {selectedSegment?.durationSec.toFixed(2)}s, exceeding the {lumaModel} limit of {lumaHardLimitSeconds}s.
        </p>
      ) : null}

      <button
        className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!selectedSegmentId || selectedSegmentOverLimit}
        onClick={() => generateSegmentMutation.mutate()}
      >
        Generate Segment Variant
      </button>

      <div className="space-y-2 rounded-lg border border-ink/10 p-3">
        <p className="font-medium">Video Comparison</p>
        {segmentWindow ? (
          <p className="text-xs text-ink/70">Showing selected segment only: {segmentWindow.startLabel}s to {segmentWindow.endLabel}s.</p>
        ) : null}
        {originalSegmentPreviewUrl && selectedPreviewGeneration?.downloadUrl ? (
          <div
            className="overflow-hidden rounded-md border border-ink/10 bg-bg"
            style={{
              aspectRatio:
                task?.video?.editSource?.width && task?.video?.editSource?.height
                  ? `${task.video.editSource.width} / ${task.video.editSource.height}`
                  : undefined,
            }}
          >
            <ReactCompareSlider
              className="h-full w-full"
              itemOne={
                <video
                  key={`orig-${originalSegmentPreviewUrl ?? "none"}-${originalPreviewIsSegmentClip ? "segment" : "full"}`}
                  ref={compareOriginalRef}
                  src={originalSegmentPreviewUrl}
                  muted
                  playsInline
                  preload="auto"
                  className="h-full w-full object-contain"
                  onLoadedMetadata={(e) => {
                    if (segmentWindow) {
                      e.currentTarget.currentTime = originalPreviewIsSegmentClip ? 0 : segmentWindow.startSec;
                    }
                  }}
                  onTimeUpdate={(e) => keepOriginalWithinSegment(e.currentTarget)}
                  onError={onAssetError}
                />
              }
              itemTwo={
                <video
                  key={`gen-${selectedPreviewGeneration.genId}`}
                  ref={compareVariantRef}
                  src={selectedPreviewGeneration.downloadUrl}
                  controls
                  playsInline
                  preload="metadata"
                  poster={generationThumbnailUrl(selectedPreviewGeneration) ?? undefined}
                  className="h-full w-full object-contain"
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = 0;
                    syncOriginalToGenerated(e.currentTarget);
                  }}
                  onLoadedData={(e) => {
                    syncOriginalToGenerated(e.currentTarget);
                  }}
                  onSeeking={(e) => syncOriginalToGenerated(e.currentTarget)}
                  onError={onAssetError}
                />
              }
            />
          </div>
        ) : (
          <p className="text-sm text-ink/60">Select a segment and generated variant to compare.</p>
        )}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {selectedSegmentGenerations.slice(0, generationCardsVisible).map((gen, index) => (
            <div
              key={gen.genId}
              className={`rounded border p-2 ${
                gen.status === "failed"
                  ? "border-orange-400 bg-orange-50"
                  : selectedPreviewGeneration?.genId === gen.genId
                    ? "border-teal-500 bg-teal-50"
                    : "border-ink/10"
              }`}
            >
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className={`uppercase text-ink/60 ${index === 0 ? "font-semibold" : ""}`}>{gen.status}</span>
                <span className="text-[11px] text-ink/50">{truncateIdentifier(gen.genId, 14)}</span>
              </div>
              <button
                type="button"
                className="block w-full disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!gen.downloadUrl}
                onClick={() => selectSegmentGeneration(gen.genId)}
                title={gen.downloadUrl ? `Use ${describeGeneration(gen)}` : "Video unavailable"}
              >
                {generationThumbnailUrl(gen) ? (
                  <img
                    src={generationThumbnailUrl(gen) as string}
                    alt={describeGeneration(gen)}
                    className="aspect-video w-full rounded-md bg-bg object-contain"
                    onError={onAssetError}
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                    Video thumbnail unavailable
                  </div>
                )}
              </button>
              <p className="mt-2 text-xs font-medium text-ink/80">{gen.luma.model} / {gen.luma.mode}</p>
              <p className="text-[11px] text-ink/60">{formatCompactTimestamp(gen.createdAt)}</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded border border-ink/20 bg-white p-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!gen.downloadUrl}
                  title="Preview"
                  onClick={() => {
                    if (!gen.downloadUrl) return;
                    setVideoPreviewModal({ url: gen.downloadUrl, label: describeGeneration(gen) });
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                {gen.downloadUrl ? (
                  <a
                    href={gen.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    download
                    className="rounded border border-ink/20 bg-white p-2 text-xs"
                    title="Download full quality video"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 3v12" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M4 21h16" />
                    </svg>
                  </a>
                ) : null}
                <button
                  type="button"
                  className="rounded border border-red-200 bg-white p-2 text-xs text-red-700"
                  title="Delete generated video"
                  disabled={!task?.taskId}
                  onClick={() =>
                    handleDeleteAsset({
                      id: `generation:${task?.taskId ?? ""}:${gen.genId}`,
                      taskId: task?.taskId ?? "",
                      title: describeGeneration(gen),
                      subtitle: `${gen.luma.model}/${gen.luma.mode}`,
                      createdAt: gen.createdAt,
                      previewUrl: gen.downloadUrl ?? "",
                      downloadUrl: gen.downloadUrl ?? "",
                      mediaType: "video",
                      deletePayload: { assetType: "segment_generation", genId: gen.genId },
                    })
                  }
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="m6 6 1 14h10l1-14" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
        {generationCardsVisible < selectedSegmentGenerations.length ? (
          <button className="text-sm text-accent underline" onClick={() => setGenerationCardsVisible((count) => count + 6)}>
            More...
          </button>
        ) : null}
        {selectedSegmentGenerations.length === 0 ? <p className="text-sm text-ink/60">No generated variants for this segment yet.</p> : null}
      </div>
    </div>
  );
}

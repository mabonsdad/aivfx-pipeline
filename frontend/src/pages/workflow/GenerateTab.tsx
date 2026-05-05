import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { CompareIcon, DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import FrameLimitInfoButton from "../../components/workflow/FrameLimitInfoButton";
import type { ChunkedGenerationRun, CustomReportOutputRef, SegmentGeneration, SegmentRecord, TaskDetail } from "../../types/api";

type GenerateInputMode = "start_video" | "start_end" | "start_only";
type VideoModel =
  | "ray-2"
  | "ray-flash-2"
  | "runway-gen4.5"
  | "sora-2-image-to-video"
  | "happy-horse-video-edit"
  | "happy-horse-image-to-video"
  | "runway-gen4-aleph"
  | "kling-2.6"
  | "kling-o1"
  | "kling-v3-omni-video"
  | "seedance-2.0-reference-to-video"
  | "veo-3.1"
  | "veo-3.1-fast"
  | "wan2.2-a14b"
  | "wan2.2-animate"
  | "wan2.7-videoedit"
  | "wan2.7-i2v";

export type GenerateTabCtx = {
  viewMode: "create" | "outputs";
  onNext: () => void;
  nextDisabled: boolean;
  nextWarning: string | null;
  generationModelByInput: Record<GenerateInputMode, VideoModel>;
  generationInputMode: GenerateInputMode;
  selectedSegment: SegmentRecord | null;
  isWholeVideoSelection: boolean;
  wholeVideoNeedsChunking: boolean;
  wholeVideoSinglePassLimitSeconds: number;
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
  replicateKlingMode: "std" | "pro";
  setReplicateKlingMode: (value: "std" | "pro") => void;
  replicateKlingV3Mode: "standard" | "pro";
  setReplicateKlingV3Mode: (value: "standard" | "pro") => void;
  wan27Resolution: "720p" | "1080p";
  setWan27Resolution: (value: "720p" | "1080p") => void;
  happyHorseResolution: "720p" | "1080p";
  setHappyHorseResolution: (value: "720p" | "1080p") => void;
  wan27NegativePrompt: string;
  setWan27NegativePrompt: (value: string) => void;
  sora2Resolution: "auto" | "720p" | "1080p";
  setSora2Resolution: (value: "auto" | "720p" | "1080p") => void;
  preserveFrames: boolean;
  setPreserveFrames: (value: boolean) => void;
  lumaPrompt: string;
  setLumaPrompt: (value: string) => void;
  lumaContinuationPrompt: string;
  setLumaContinuationPrompt: (value: string) => void;
  generationPromptPlaceholder: string;
  generationPromptError: string | null;
  missingRouteInputsMessage: string | null;
  generationInputNote: string;
  generationHelp: { title: string; lines: string[] };
  selectedStartSourceLabel: string;
  selectedEndSourceLabel: string | null;
  selectedSegmentOverLimit: boolean;
  selectedSegmentLimitMessage: string | null;
  selectedSegmentId: string | null;
  generateSegmentMutation: { mutate: () => void; isPending?: boolean };
  generateChunkedSegmentMutation: { mutate: () => void; isPending?: boolean };
  selectedSegmentChunkedGenerationRuns: ChunkedGenerationRun[];
  pauseChunkedGeneration: (payload: { runId: string; reason?: string }) => void;
  resumeChunkedGeneration: (payload: { runId: string }) => void;
  restartChunkedGeneration: (payload: { runId: string; fromChunkIndex: number; prompt?: string }) => void;
  saveChunkedGenerationDraft: (payload: { runId: string }) => void;
  cancelChunkedGeneration: (payload: { runId: string; reason?: string }) => void;
  isChunkedGenerationMutationPending: boolean;
  frameVariantImageUrl: (frameId: string | null | undefined, variantId: string | null | undefined) => string | null;
  segmentWindow: { startSec: number; endSec: number; startLabel: string; endLabel: string } | null;
  originalSegmentPreviewUrl: string | null;
  uploadManualGeneratedVideo: (file: File) => Promise<string>;
  selectedPreviewGeneration: SegmentGeneration | null;
  task: TaskDetail | undefined;
  originalPreviewIsSegmentClip: boolean;
  selectedSegmentGenerations: SegmentGeneration[];
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  generationCardsVisible: number;
  truncateIdentifier: (value: string, maxLength?: number) => string;
  selectSegmentGeneration: (genId: string) => void;
  describeGeneration: (generation: SegmentGeneration) => string;
  generationThumbnailUrl: (generation: SegmentGeneration) => string | null;
  formatCompactTimestamp: (iso: string | undefined) => string;
  setVideoPreviewModal: (value: { url: string; label: string } | null) => void;
  setVideoCompareModal: (value: {
    originalUrl: string;
    compareUrl: string;
    label: string;
    posterUrl?: string | null;
    segmentStartSec?: number;
    originalIsSegmentClip?: boolean;
  } | null) => void;
  openVideoCleanupModal: (generation: SegmentGeneration) => void;
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
    onNext,
    nextDisabled,
    nextWarning,
    generationInputMode,
    wholeVideoNeedsChunking,
    lumaModel,
    setGenerationModelByInput,
    generationModelOptions,
    advancedMode,
    setAdvancedMode,
    replicateKlingMode,
    setReplicateKlingMode,
    replicateKlingV3Mode,
    setReplicateKlingV3Mode,
    wan27Resolution,
    setWan27Resolution,
    happyHorseResolution,
    setHappyHorseResolution,
    wan27NegativePrompt,
    setWan27NegativePrompt,
    sora2Resolution,
    setSora2Resolution,
    preserveFrames,
    setPreserveFrames,
    lumaPrompt,
    setLumaPrompt,
    lumaContinuationPrompt,
    setLumaContinuationPrompt,
    generationPromptPlaceholder,
    generationPromptError,
    missingRouteInputsMessage,
    generationHelp,
    selectedSegmentOverLimit,
    selectedSegmentLimitMessage,
    selectedSegmentId,
    generateSegmentMutation,
    generateChunkedSegmentMutation,
    selectedSegmentChunkedGenerationRuns,
    pauseChunkedGeneration,
    resumeChunkedGeneration,
    restartChunkedGeneration,
    saveChunkedGenerationDraft,
    cancelChunkedGeneration,
    isChunkedGenerationMutationPending,
    frameVariantImageUrl,
    segmentWindow,
    originalSegmentPreviewUrl,
    uploadManualGeneratedVideo,
    selectedPreviewGeneration,
    task,
    originalPreviewIsSegmentClip,
    selectedSegmentGenerations,
    generationCardsVisible,
    truncateIdentifier,
    selectSegmentGeneration,
    describeGeneration,
    generationThumbnailUrl,
    formatCompactTimestamp,
    setVideoPreviewModal,
    setVideoCompareModal,
    onAssetError,
    handleDeleteAsset,
    setGenerationCardsVisible,
  } = ctx;
  const latestChunkedRun = selectedSegmentChunkedGenerationRuns[0] ?? null;
  const [isChunkSessionOpen, setIsChunkSessionOpen] = useState(false);
  const [chunkPromptDrafts, setChunkPromptDrafts] = useState<Record<number, string>>({});
  const [manualUploadPending, setManualUploadPending] = useState(false);
  const [manualUploadError, setManualUploadError] = useState<string | null>(null);
  const lastSavedRunRef = useRef<string | null>(null);
  const promptDraftRunIdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const isPreparingChunkPlan = Boolean(generateChunkedSegmentMutation.isPending);
  const canStartChunkedGeneration =
    Boolean(selectedSegmentId) &&
    !generationPromptError &&
    generationInputMode === "start_video" &&
    ["ray-2", "ray-flash-2", "kling-o1", "kling-v3-omni-video", "seedance-2.0-reference-to-video", "wan2.7-videoedit"].includes(lumaModel);
  const canStartSinglePassGeneration =
    Boolean(selectedSegmentId) &&
    !selectedSegmentOverLimit &&
    !wholeVideoNeedsChunking &&
    !generationPromptError;

  useEffect(() => {
    if (!latestChunkedRun) return;
    if (promptDraftRunIdRef.current !== latestChunkedRun.runId) {
      promptDraftRunIdRef.current = latestChunkedRun.runId;
      const seededPrompts = Object.fromEntries(
        latestChunkedRun.chunks.map((chunk) => [chunk.chunkIndex, chunk.prompt ?? ""]),
      ) as Record<number, string>;
      setChunkPromptDrafts(seededPrompts);
      return;
    }
    setChunkPromptDrafts((previous) => {
      const next = { ...previous };
      for (const chunk of latestChunkedRun.chunks) {
        if (typeof next[chunk.chunkIndex] !== "string") {
          next[chunk.chunkIndex] = chunk.prompt ?? "";
        }
      }
      return next;
    });
  }, [latestChunkedRun?.chunks, latestChunkedRun?.runId]);

  useEffect(() => {
    if (!latestChunkedRun?.runId || latestChunkedRun.saveStatus !== "complete" || !latestChunkedRun.savedGenerationId) return;
    const saveMarker = `${latestChunkedRun.runId}:${latestChunkedRun.savedGenerationId}`;
    if (lastSavedRunRef.current === saveMarker) return;
    lastSavedRunRef.current = saveMarker;
    selectSegmentGeneration(latestChunkedRun.savedGenerationId);
    setIsChunkSessionOpen(false);
  }, [latestChunkedRun?.runId, latestChunkedRun?.saveStatus, latestChunkedRun?.savedGenerationId, selectSegmentGeneration]);

  function triggerDirectDownload(url: string, filename?: string) {
    const link = document.createElement("a");
    link.href = url;
    if (filename) link.download = filename;
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function handleManualGeneratedVideoUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setManualUploadPending(true);
    setManualUploadError(null);
    try {
      await uploadManualGeneratedVideo(file);
    } catch (error) {
      setManualUploadError(error instanceof Error ? error.message : "Failed to upload generated video");
    } finally {
      setManualUploadPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <input ref={uploadInputRef} type="file" accept="video/*" className="hidden" onChange={(event) => void handleManualGeneratedVideoUpload(event)} />
      <div className="rounded-xl border border-ink/15 bg-white">
        <div className="grid gap-3 p-3 lg:grid-cols-[1.65fr_1fr]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!originalSegmentPreviewUrl}
                onClick={() => {
                  if (!originalSegmentPreviewUrl) return;
                  triggerDirectDownload(originalSegmentPreviewUrl);
                }}
              >
                Download Source Video
              </button>
              <button
                type="button"
                className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedSegmentId || manualUploadPending}
                onClick={() => uploadInputRef.current?.click()}
              >
                <PendingButtonLabel isPending={manualUploadPending} idle="Upload Generated Video" pending="Uploading video..." />
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <select
                value={lumaModel}
                onChange={(e) => {
                  const nextModel = e.target.value as VideoModel;
                  setGenerationModelByInput((previous) => ({ ...previous, [generationInputMode]: nextModel }));
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
              ) : lumaModel === "kling-o1" ? (
                <select
                  value={replicateKlingMode}
                  onChange={(e) => setReplicateKlingMode(e.target.value as "std" | "pro")}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="std">Kling mode: std</option>
                  <option value="pro">Kling mode: pro</option>
                </select>
              ) : lumaModel === "kling-v3-omni-video" ? (
                <select
                  value={replicateKlingV3Mode}
                  onChange={(e) => setReplicateKlingV3Mode(e.target.value as "standard" | "pro")}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="standard">Kling mode: standard</option>
                  <option value="pro">Kling mode: pro</option>
                </select>
              ) : lumaModel === "wan2.7-videoedit" || lumaModel === "wan2.7-i2v" ? (
                <select
                  value={wan27Resolution}
                  onChange={(e) => setWan27Resolution(e.target.value as "720p" | "1080p")}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="720p">Resolution: 720p</option>
                  <option value="1080p">Resolution: 1080p</option>
                </select>
              ) : lumaModel === "happy-horse-video-edit" || lumaModel === "happy-horse-image-to-video" ? (
                <select
                  value={happyHorseResolution}
                  onChange={(e) => setHappyHorseResolution(e.target.value as "720p" | "1080p")}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="720p">Resolution: 720p</option>
                  <option value="1080p">Resolution: 1080p</option>
                </select>
              ) : lumaModel === "sora-2-image-to-video" ? (
                <select
                  value={sora2Resolution}
                  onChange={(e) => setSora2Resolution(e.target.value as "auto" | "720p" | "1080p")}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="auto">Resolution: auto</option>
                  <option value="720p">Resolution: 720p</option>
                  <option value="1080p">Resolution: 1080p</option>
                </select>
              ) : (
                <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                  Extra mode controls are only used by selected models.
                </div>
              )}
            </div>
            {lumaModel === "wan2.2-animate" ? (
              <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                Text prompt is unavailable for Wan2.2 Animate in this flow. Generation uses the selected start frame plus motion from the current working range.
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-ink/75">Opening prompt</span>
                  <textarea
                    value={lumaPrompt}
                    onChange={(e) => setLumaPrompt(e.target.value)}
                    placeholder={generationPromptPlaceholder}
                    className="h-20 w-full rounded-md border border-ink/20 p-2"
                  />
                </label>
                {lumaModel === "wan2.7-i2v" ? (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink/75">Negative prompt (optional)</span>
                    <textarea
                      value={wan27NegativePrompt}
                      onChange={(e) => setWan27NegativePrompt(e.target.value)}
                      placeholder="Optional. Describe content or artifacts to avoid."
                      className="h-16 w-full rounded-md border border-ink/20 p-2"
                    />
                  </label>
                ) : null}
                {wholeVideoNeedsChunking ? (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink/75">Continuation prompt for later chunks (optional)</span>
                    <textarea
                      value={lumaContinuationPrompt}
                      onChange={(e) => setLumaContinuationPrompt(e.target.value)}
                      placeholder="Optional. If left blank, later chunks reuse the opening prompt. Use this to soften the edit once the transformation is established."
                      className="h-20 w-full rounded-md border border-ink/20 p-2"
                    />
                  </label>
                ) : null}
              </div>
            )}
            {generationPromptError ? (
              <StatusNotice variant="error">
                <p className="text-xs">{generationPromptError}</p>
              </StatusNotice>
            ) : null}
            {missingRouteInputsMessage ? (
              <StatusNotice variant="warning">
                <p className="text-xs">{missingRouteInputsMessage}</p>
              </StatusNotice>
            ) : null}
            {manualUploadError ? (
              <StatusNotice variant="error">
                <p className="text-xs">{manualUploadError}</p>
              </StatusNotice>
            ) : null}
          </div>
          <div className="rounded-lg border border-ink/15 bg-bg p-3">
            <p className="text-sm font-semibold">{generationHelp.title}</p>
            <div className="mt-2 space-y-2 text-xs text-ink/70">
              {generationHelp.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            {generationInputMode === "start_video" ? (
              <label className="mt-3 flex items-start gap-3 rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink/80">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={preserveFrames}
                  onChange={(e) => setPreserveFrames(e.target.checked)}
                />
                <span>
                  <span className="block font-medium text-ink">Preserve source frames</span>
                  <span className="block text-xs text-ink/65">
                    Change source fps to match AI model, to avoid dropping or resampling frames, then revert fps after generation.
                  </span>
                </span>
              </label>
            ) : null}
          </div>
        </div>
      </div>

      {selectedSegmentOverLimit && selectedSegmentLimitMessage ? (
        <StatusNotice variant="warning">
          <div className="flex items-start gap-2">
            <p className="text-xs">{selectedSegmentLimitMessage}</p>
            {generationInputMode === "start_video" ? <FrameLimitInfoButton label="Frame limits for video generation" mode={generationInputMode} /> : null}
          </div>
        </StatusNotice>
      ) : null}

      {wholeVideoNeedsChunking ? (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-950">Chunked Whole-Video Generation</p>
              <p className="text-xs text-amber-900">The app will split this range into overlapping chunks and reuse the continuation prompt unless you override it in the session.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !canStartChunkedGeneration ||
                  isChunkedGenerationMutationPending
                }
                onClick={() => {
                  setIsChunkSessionOpen(true);
                  generateChunkedSegmentMutation.mutate();
                }}
              >
                <PendingButtonLabel
                  isPending={isChunkedGenerationMutationPending}
                  idle="Start Chunked Generation"
                  pending="Starting chunked generation..."
                />
              </button>
              {latestChunkedRun ? (
                <button
                  type="button"
                  className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm"
                  onClick={() => setIsChunkSessionOpen(true)}
                >
                  Open Chunk Session
                </button>
              ) : null}
            </div>
          </div>
          {isPreparingChunkPlan ? (
            <StatusNotice variant="loading" title="Preparing chunked generation">
              <p className="text-sm">Preparing chunk plan and creating the first chunk. This can take a short while before the chunk list appears.</p>
            </StatusNotice>
          ) : null}
          {generationInputMode !== "start_video" ? (
            <StatusNotice variant="warning">
              <p className="text-xs">Switch to `start frame + video` for the long-video chunked flow.</p>
            </StatusNotice>
          ) : null}
          {!["ray-2", "ray-flash-2", "kling-o1", "kling-v3-omni-video", "seedance-2.0-reference-to-video", "wan2.7-videoedit"].includes(lumaModel) ? (
            <StatusNotice variant="warning">
              <p className="text-xs">This model is not in the first chunked-release set. Use one of the first-frame + source-video models for whole-video generation.</p>
            </StatusNotice>
          ) : null}

          {latestChunkedRun ? (
            <div className="rounded-md border border-amber-300 bg-white/70 p-3 text-xs text-ink/75">
              Latest run: {latestChunkedRun.model} · {latestChunkedRun.chunks.length} chunks · status {latestChunkedRun.status.toUpperCase()}
              {latestChunkedRun.savedGenerationId ? " · stitched draft saved to grid" : ""}
            </div>
          ) : null}
        </div>
      ) : null}

      {isChunkSessionOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-5 py-4">
              <div className="space-y-1">
                <p className="text-lg font-semibold text-ink">Chunked Generation Session</p>
                <p className="text-sm text-ink/65">
                  {latestChunkedRun
                    ? `${latestChunkedRun.model} · ${latestChunkedRun.chunks.length} chunks · status ${latestChunkedRun.status.toUpperCase()}`
                    : "Preparing chunk plan and first chunk"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {latestChunkedRun ? (
                  <>
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.status !== "running" || isChunkedGenerationMutationPending}
                      onClick={() => pauseChunkedGeneration({ runId: latestChunkedRun.runId, reason: "Paused from chunk session" })}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.status !== "paused" && latestChunkedRun.status !== "failed"}
                      onClick={() => resumeChunkedGeneration({ runId: latestChunkedRun.runId })}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.status !== "complete" || latestChunkedRun.saveStatus === "queued" || latestChunkedRun.saveStatus === "running"}
                      onClick={() => saveChunkedGenerationDraft({ runId: latestChunkedRun.runId })}
                    >
                      <PendingButtonLabel
                        isPending={latestChunkedRun.saveStatus === "queued" || latestChunkedRun.saveStatus === "running"}
                        idle="Save Draft To Grid"
                        pending="Saving draft..."
                      />
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.saveStatus === "queued" || latestChunkedRun.saveStatus === "running"}
                      onClick={() => {
                        cancelChunkedGeneration({ runId: latestChunkedRun.runId, reason: "Canceled from chunk session" });
                        setIsChunkSessionOpen(false);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : null}
                <button type="button" className="rounded-md border border-ink/20 px-3 py-2 text-sm" onClick={() => setIsChunkSessionOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="space-y-3 overflow-y-auto px-5 py-4">
              {!latestChunkedRun ? (
                <StatusNotice variant="loading" title="Preparing chunk session" className="px-4 py-5">
                  <p className="text-sm">Preparing the chunk plan and queuing the first chunk. This can take a short while before the timeline appears.</p>
                </StatusNotice>
              ) : (
                <>
                  <StatusNotice variant="info" title="Chunk session output">
                    <p className="text-sm">Save only creates one stitched draft video back in Outputs. Individual chunks stay inside this session.</p>
                  </StatusNotice>
                  {latestChunkedRun.saveError ? (
                    <StatusNotice variant="error">
                      <p className="text-sm">Save failed: {latestChunkedRun.saveError}</p>
                    </StatusNotice>
                  ) : null}
                  <div className="overflow-x-auto pb-2">
                    <div className="flex min-w-max gap-4">
                      {latestChunkedRun.chunks.map((chunk) => {
                        const anchorUrl = frameVariantImageUrl(chunk.anchorFrameId, chunk.anchorVariantId);
                        const chunkGeneration = chunk.generationId ? task?.segmentGenerations?.[chunk.generationId] ?? null : null;
                        const chunkThumbnail = chunkGeneration ? generationThumbnailUrl(chunkGeneration) : null;
                        const promptValue = chunkPromptDrafts[chunk.chunkIndex] ?? chunk.prompt ?? "";
                        const providerInputTiming = chunkGeneration?.generationSettings?.providerInputTiming ?? null;
                        const storedOutputTiming = chunkGeneration?.generationSettings?.storedOutput ?? null;
                        const sourceClipLabel =
                          providerInputTiming?.fps && providerInputTiming?.durationSec
                            ? `${providerInputTiming.fps.num}/${providerInputTiming.fps.den} fps · ${providerInputTiming.durationSec.toFixed?.(2) ?? providerInputTiming.durationSec}s`
                            : null;
                        const storedClipLabel =
                          storedOutputTiming?.fps && storedOutputTiming?.durationSec
                            ? `${storedOutputTiming.fps.num}/${storedOutputTiming.fps.den} fps · ${storedOutputTiming.durationSec.toFixed?.(2) ?? storedOutputTiming.durationSec}s`
                            : null;
                        return (
                          <div
                            key={`${latestChunkedRun.runId}-${chunk.chunkIndex}`}
                            className="flex w-[320px] shrink-0 flex-col rounded-xl border border-ink/15 bg-white p-4"
                          >
                            <div className="mb-3 flex items-start justify-between gap-3">
                              <p className="text-sm font-semibold text-ink">
                                Chunk {chunk.chunkIndex + 1} (f{chunk.segmentStartFrame} - f{Math.max(chunk.segmentStartFrame, chunk.segmentEndFrameExclusive - 1)})
                              </p>
                              <span className="rounded-full bg-bg px-2 py-1 text-[11px] uppercase tracking-wide text-ink/60">{chunk.status}</span>
                            </div>
                            {chunk.coverageStartFrame != null && chunk.coverageEndFrameExclusive != null ? (
                              <p className="mb-2 text-xs text-ink/60">
                                Keeps f{chunk.coverageStartFrame} - f{Math.max(chunk.coverageStartFrame, chunk.coverageEndFrameExclusive - 1)}
                              </p>
                            ) : null}
                            {chunk.actualOutputStartFrame != null ? (
                              <p className="mb-2 text-xs text-ink/55">Returned video appears to start at source f{chunk.actualOutputStartFrame}</p>
                            ) : null}
                        {anchorUrl ? (
                              <img src={anchorUrl} alt={`Chunk ${chunk.chunkIndex + 1} anchor`} className="aspect-video w-full rounded-md bg-bg object-contain" loading="lazy" decoding="async" />
                            ) : (
                              <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/55">
                                Anchor frame pending
                              </div>
                            )}
                            <label className="mt-3 block space-y-1">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/55">Prompt</span>
                              <textarea
                                value={promptValue}
                                onChange={(e) =>
                                  setChunkPromptDrafts((previous) => ({ ...previous, [chunk.chunkIndex]: e.target.value }))
                                }
                                className="h-28 w-full rounded-md border border-ink/15 p-2 text-sm"
                              />
                            </label>
                            <div className="mt-3 rounded-md border border-ink/10 bg-bg p-2">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink/55">Exact media sent</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {chunkGeneration?.inputMediaUrl ? (
                                  <button
                                    type="button"
                                    className="rounded border border-ink/20 bg-white px-3 py-2 text-xs"
                                    onClick={() =>
                                      setVideoPreviewModal({
                                        url: chunkGeneration.inputMediaUrl as string,
                                        label: `Chunk ${chunk.chunkIndex + 1} source clip sent to model`,
                                      })
                                    }
                                  >
                                    Preview source clip
                                  </button>
                                ) : null}
                                {chunkGeneration?.inputMediaUrl ? (
                                  <a
                                    href={chunkGeneration.inputMediaUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    download
                                    className="rounded border border-ink/20 bg-white px-3 py-2 text-xs"
                                  >
                                    Download source clip
                                  </a>
                                ) : null}
                              </div>
                              {chunkGeneration?.inputFirstFrameUrl ? (
                                <img
                                  src={chunkGeneration.inputFirstFrameUrl}
                                  alt={`Chunk ${chunk.chunkIndex + 1} prepared first frame`}
                                  className="mt-2 aspect-video w-full rounded-md bg-white object-contain"
                                  loading="lazy"
                                  decoding="async"
                                  onError={onAssetError}
                                />
                              ) : null}
                              <div className="mt-2 space-y-1 text-[11px] text-ink/60">
                                {sourceClipLabel ? <p>Prepared input: {sourceClipLabel}</p> : null}
                                {storedClipLabel ? <p>Stored output: {storedClipLabel}</p> : null}
                              </div>
                            </div>
                            <div className="mt-3 rounded-md border border-ink/10 bg-bg p-2">
                              {chunkGeneration?.downloadUrl ? (
                                <>
                                  {chunkThumbnail ? (
                                    <img
                                      src={chunkThumbnail}
                                      alt={`Chunk ${chunk.chunkIndex + 1} generated preview`}
                                      className="aspect-video w-full rounded-md bg-white object-contain"
                                      loading="lazy"
                                      decoding="async"
                                      onError={onAssetError}
                                    />
                                  ) : (
                                    <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-ink/20 bg-white text-xs text-ink/55">
                                      Video thumbnail unavailable
                                    </div>
                                  )}
                                  <div className="mt-2 flex items-center gap-2">
                                    <IconActionButton
                                      title="Preview chunk"
                                      onClick={() =>
                                        setVideoPreviewModal({
                                          url: chunkGeneration.downloadUrl as string,
                                          label: `Chunk ${chunk.chunkIndex + 1} · ${chunkGeneration.luma.model}`,
                                        })
                                      }
                                    >
                                      <PreviewIcon />
                                    </IconActionButton>
                                    <IconActionButton href={chunkGeneration.downloadUrl} download title="Download chunk">
                                      <DownloadIcon />
                                    </IconActionButton>
                                    <button
                                      type="button"
                                      className="ml-auto rounded-md border border-ink/20 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                                      disabled={isChunkedGenerationMutationPending}
                                      onClick={() =>
                                        restartChunkedGeneration({
                                          runId: latestChunkedRun.runId,
                                          fromChunkIndex: chunk.chunkIndex,
                                          prompt: promptValue.trim() || undefined,
                                        })
                                      }
                                    >
                                      Restart From Here
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <div className="space-y-2">
                                  <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-ink/20 bg-white text-xs text-ink/55">
                                    {chunk.status === "failed"
                                      ? "No output was produced for this chunk."
                                      : chunk.status === "complete"
                                        ? "Preview URLs are still being prepared."
                                        : "Generated video will appear here when this chunk completes."}
                                  </div>
                                  <button
                                    type="button"
                                    className="w-full rounded-md border border-ink/20 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={isChunkedGenerationMutationPending}
                                    onClick={() =>
                                      restartChunkedGeneration({
                                        runId: latestChunkedRun.runId,
                                        fromChunkIndex: chunk.chunkIndex,
                                        prompt: promptValue.trim() || undefined,
                                      })
                                    }
                                  >
                                    Restart From Here
                                  </button>
                                </div>
                              )}
                            </div>
                            {chunk.error ? (
                              <div className="mt-2">
                                <StatusNotice variant="error">
                                  <p className="text-xs">{chunk.error}</p>
                                </StatusNotice>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <button
        className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!canStartSinglePassGeneration || Boolean(generateSegmentMutation.isPending)}
        onClick={() => generateSegmentMutation.mutate()}
      >
        <PendingButtonLabel
          isPending={Boolean(generateSegmentMutation.isPending)}
          idle="Generate Output"
          pending="Starting generation..."
        />
      </button>

      <div className="space-y-2 rounded-lg border border-ink/10 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">Generated outputs</p>
            <p className="text-xs text-ink/60">
              Select the output to carry forward. Use the compare action on any thumbnail to open source vs output review.
            </p>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {selectedSegmentGenerations.slice(0, generationCardsVisible).map((gen, index) => {
              const isSelected = selectedPreviewGeneration?.genId === gen.genId;
              return (
            <div
              key={gen.genId}
              className={`rounded border p-2 ${
                gen.status === "failed"
                  ? "border-red-200 bg-red-50"
                  : isSelected
                    ? "border-teal-500 bg-teal-50"
                    : "border-ink/10"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className={`uppercase text-ink/60 ${index === 0 ? "font-semibold" : ""}`}>{gen.status}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-ink/50">{truncateIdentifier(gen.genId, 14)}</span>
                </div>
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
                    loading="lazy"
                    decoding="async"
                    onError={onAssetError}
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                    Video thumbnail unavailable
                  </div>
                )}
              </button>
              <p className="mt-2 text-xs font-medium text-ink/80">{gen.luma.model} / {gen.luma.mode}</p>
              {gen.manualUpload ? <p className="text-[11px] text-teal-700">Manual upload</p> : null}
              <p className="text-[11px] text-ink/60">{formatCompactTimestamp(gen.finishedAt ?? gen.createdAt)}</p>
              {gen.status === "failed" && gen.error ? (
                <p className="mt-1 line-clamp-3 text-[11px] text-red-700" title={gen.error}>
                  {gen.error}
                </p>
              ) : null}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className={`rounded border px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
                    isSelected ? "border-teal-500 bg-teal-50 text-ink" : "border-ink/20 bg-white text-ink"
                  }`}
                  disabled={!gen.downloadUrl}
                  onClick={() => selectSegmentGeneration(gen.genId)}
                >
                  {isSelected ? "Selected" : "Select"}
                </button>
                <IconActionButton
                  title="Preview"
                  disabled={!gen.downloadUrl}
                  onClick={() => {
                    if (!gen.downloadUrl) return;
                    setVideoPreviewModal({ url: gen.downloadUrl, label: describeGeneration(gen) });
                  }}
                >
                  <PreviewIcon />
                </IconActionButton>
                <IconActionButton
                  title={!originalSegmentPreviewUrl || !gen.downloadUrl ? "Compare is unavailable until both source and output previews are ready" : "Compare against source"}
                  disabled={!originalSegmentPreviewUrl || !gen.downloadUrl}
                  onClick={() => {
                    if (!originalSegmentPreviewUrl || !gen.downloadUrl) return;
                    setVideoCompareModal({
                      originalUrl: originalSegmentPreviewUrl,
                      compareUrl: gen.downloadUrl,
                      label: describeGeneration(gen),
                      posterUrl: generationThumbnailUrl(gen),
                      segmentStartSec: segmentWindow?.startSec,
                      originalIsSegmentClip: originalPreviewIsSegmentClip,
                    });
                  }}
                >
                  <CompareIcon />
                </IconActionButton>
                {gen.downloadUrl ? (
                  <IconActionButton href={gen.downloadUrl} download title="Download full quality video">
                    <DownloadIcon />
                  </IconActionButton>
                ) : null}
                <IconActionButton
                  title="Delete output"
                  tone="danger"
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
                  <DeleteIcon />
                </IconActionButton>
              </div>
            </div>
              );
            }
          )}
        </div>
        {generationCardsVisible < selectedSegmentGenerations.length ? (
          <button className="text-sm text-accent underline" onClick={() => setGenerationCardsVisible((count) => count + 6)}>
            More...
          </button>
        ) : null}
        {selectedSegmentGenerations.length === 0 ? <p className="text-sm text-ink/60">No generated outputs for this working range yet.</p> : null}
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
      </div>
    </div>
  );
}

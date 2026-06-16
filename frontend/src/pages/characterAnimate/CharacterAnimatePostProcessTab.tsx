import { useEffect, useMemo, useState } from "react";

import { DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, Spinner, StatusNotice } from "../../components/layout/UiFeedback";
import type { ExportRecord, SegmentGeneration, SegmentRecord } from "../../types/api";

type TopazUpscaleSettings = {
  preset: "balanced" | "recover_detail" | "fast_sharpen";
  model: string;
  upscaleFactor: number;
  h264Output: boolean;
};

type CharacterAnimatePostProcessTabProps = {
  generations: SegmentGeneration[];
  topazItems: Array<{
    sourceGeneration: SegmentGeneration;
    sourceExport: ExportRecord;
    topazState: ExportRecord["topazUpscale"];
    resultExport: ExportRecord | null;
  }>;
  describeGeneration: (generation: SegmentGeneration) => string;
  describeSegment: (segment: SegmentRecord) => string;
  getSegmentForGeneration: (generation: SegmentGeneration) => SegmentRecord | null;
  generationThumbnailUrl: (generation: SegmentGeneration) => string | null;
  formatCompactTimestamp: (iso: string | undefined) => string;
  onPreviewGeneration: (generation: SegmentGeneration) => void;
  onPreviewTopazExport: (exportItem: ExportRecord, sourceGeneration: SegmentGeneration) => void;
  onDeleteGeneration: (generation: SegmentGeneration) => void;
  onDeleteTopazExport: (exportItem: ExportRecord, sourceGeneration: SegmentGeneration) => void;
  onAssetError: (url?: string) => void;
  onLengthenGeneration: (payload: {
    generationId: string;
    model: string;
    direction: "start" | "end";
    durationSeconds: number;
    prompt: string;
    inputMode: "start_end";
    selectedReferenceIds?: string[];
  }) => void;
  isLengtheningGeneration: boolean;
  lengthenGenerationError: string | null;
  onUpscaleGeneration: (payload: {
    generationId: string;
    preset: "balanced" | "recover_detail" | "fast_sharpen";
    model: string;
    upscaleFactor: number;
    h264Output: boolean;
    force?: boolean;
  }) => void;
  isUpscalingGeneration: boolean;
  topazUpscalePendingGenerationId: string | null;
  topazUpscaleError: string | null;
  topazStateByGenerationId: Record<string, ExportRecord["topazUpscale"] | undefined>;
  labels?: {
    sectionTitle?: string;
    sectionDescription?: string;
    emptyState?: string;
    extendModalTitle?: string;
    upscaleModalTitle?: string;
    fallbackGenerationLabel?: string;
  };
};

type LengthenModalState = {
  generation: SegmentGeneration;
};

type UpscaleModalState = {
  generation: SegmentGeneration;
};

type PostProcessGridItem =
  | {
      kind: "generation";
      itemId: string;
      sortTimestamp: number;
      generation: SegmentGeneration;
    }
  | {
      kind: "topaz";
      itemId: string;
      sortTimestamp: number;
      sourceGeneration: SegmentGeneration;
      sourceExport: ExportRecord;
      topazState: ExportRecord["topazUpscale"];
      resultExport: ExportRecord | null;
    };

const CLIP_LENGTHEN_MODEL_OPTIONS: Record<"start" | "end", Array<{ value: string; label: string }>> = {
  start: [
    { value: "ltx-2.3-pro", label: "LTX 2.3 Pro" },
    { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video" },
  ],
  end: [
    { value: "ltx-2.3-pro", label: "LTX 2.3 Pro" },
    { value: "wan2.7-i2v", label: "Wan 2.7 I2V" },
    { value: "veo-3.1", label: "Veo 3.1" },
    { value: "veo-3.1-fast", label: "Veo 3.1 Fast" },
  ],
};

const DEFAULT_TOPAZ_SETTINGS: TopazUpscaleSettings = {
  preset: "balanced",
  model: "Proteus",
  upscaleFactor: 1,
  h264Output: false,
};

function asFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function generationDurationSeconds(generation: SegmentGeneration): number {
  return (
    asFiniteNumber(generation.generationSettings?.storedOutput?.durationSec) ??
    asFiniteNumber(generation.providerDurationSec) ??
    asFiniteNumber(generation.generationSettings?.providerDurationSec) ??
    asFiniteNumber(generation.requestedDurationSec) ??
    0
  );
}

function formatModelLabel(generation: SegmentGeneration, fallbackLabel: string) {
  const rawLabel =
    generation.characterAnimation?.modelLabel ??
    generation.characterAnimation?.model ??
    generation.generationSettings?.requestedModel ??
    generation.generationSettings?.model ??
    generation.luma.model;
  return typeof rawLabel === "string" && rawLabel.trim() ? rawLabel : fallbackLabel;
}

const DEFAULT_LABELS = {
  sectionTitle: "Character post-process",
  sectionDescription:
    "Review all completed character-animation outputs across this task. Extend uses the shared clip-lengthen flow and Upscale uses the shared Topaz path.",
  emptyState: "No completed character videos yet.",
  extendModalTitle: "Extend character video",
  upscaleModalTitle: "Upscale character video",
  fallbackGenerationLabel: "Character animation",
};

export default function CharacterAnimatePostProcessTab({
  generations,
  topazItems,
  describeGeneration,
  describeSegment,
  getSegmentForGeneration,
  generationThumbnailUrl,
  formatCompactTimestamp,
  onPreviewGeneration,
  onPreviewTopazExport,
  onDeleteGeneration,
  onDeleteTopazExport,
  onAssetError,
  onLengthenGeneration,
  isLengtheningGeneration,
  lengthenGenerationError,
  onUpscaleGeneration,
  isUpscalingGeneration,
  topazUpscalePendingGenerationId,
  topazUpscaleError,
  topazStateByGenerationId,
  labels,
}: CharacterAnimatePostProcessTabProps) {
  const [lengthenModal, setLengthenModal] = useState<LengthenModalState | null>(null);
  const [upscaleModal, setUpscaleModal] = useState<UpscaleModalState | null>(null);
  const [clipLengthenDirection, setClipLengthenDirection] = useState<"start" | "end">("end");
  const [clipLengthenModel, setClipLengthenModel] = useState("ltx-2.3-pro");
  const [clipLengthenDurationSeconds, setClipLengthenDurationSeconds] = useState("6");
  const [clipLengthenPrompt, setClipLengthenPrompt] = useState("");
  const [topazSettings, setTopazSettings] = useState<TopazUpscaleSettings>(DEFAULT_TOPAZ_SETTINGS);
  const resolvedLabels = { ...DEFAULT_LABELS, ...(labels ?? {}) };

  const lengthenGeneration = lengthenModal?.generation ?? null;
  const lengthenGenerationId = lengthenGeneration?.genId ?? null;
  const lengthenGenerationPromptDefault = lengthenGeneration?.luma.prompt ?? "";
  const upscaleGenerationId = upscaleModal?.generation.genId ?? null;
  const clipLengthenModelOptions = useMemo(
    () => CLIP_LENGTHEN_MODEL_OPTIONS[clipLengthenDirection],
    [clipLengthenDirection],
  );
  const currentClipDurationSeconds = useMemo(
    () => (lengthenGeneration ? generationDurationSeconds(lengthenGeneration) : 0),
    [lengthenGeneration],
  );
  const clipLengthenModelConfig = useMemo(() => {
    if (clipLengthenModel === "ltx-2.3-pro") {
      return {
        fixedDuration: null as number | null,
        maxAdditionalSeconds: 20,
        disabledReason: null as string | null,
        note:
          clipLengthenDirection === "start"
            ? "LTX can prepend new motion before the current clip."
            : "LTX can add new duration to the end of the current clip.",
      };
    }
    if (clipLengthenModel === "wan2.7-i2v") {
      if (currentClipDurationSeconds < 2 || currentClipDurationSeconds > 10) {
        return {
          fixedDuration: null,
          maxAdditionalSeconds: 0,
          disabledReason: "Wan 2.7 continuation needs the current clip to be between 2 and 10 seconds.",
          note: "Wan 2.7 continues the clip forward from the current end.",
        };
      }
      return {
        fixedDuration: null,
        maxAdditionalSeconds: Math.max(0, 15 - Math.ceil(currentClipDurationSeconds)),
        disabledReason: null,
        note: "Wan 2.7 continues the clip forward from the current end.",
      };
    }
    if (clipLengthenModel === "seedance-2.0-reference-to-video") {
      if (currentClipDurationSeconds <= 0 || currentClipDurationSeconds > 15) {
        return {
          fixedDuration: null,
          maxAdditionalSeconds: 0,
          disabledReason: "Seedance continuation needs the current clip to be 15 seconds or shorter.",
          note:
            clipLengthenDirection === "start"
              ? "Seedance can generate a clip that leads naturally into the current video."
              : "Seedance continues from the current clip.",
        };
      }
      return {
        fixedDuration: null,
        maxAdditionalSeconds: Math.max(0, 15 - Math.ceil(currentClipDurationSeconds)),
        disabledReason: null,
        note:
          clipLengthenDirection === "start"
            ? "Seedance can generate a clip that leads naturally into the current video."
            : "Seedance continues from the current clip.",
      };
    }
    if (clipLengthenModel === "veo-3.1" || clipLengthenModel === "veo-3.1-fast") {
      return {
        fixedDuration: 7,
        maxAdditionalSeconds: 7,
        disabledReason: clipLengthenDirection === "start" ? "Veo currently supports end-only extension." : null,
        note: "Veo extension adds a fixed 7 second continuation at the end.",
      };
    }
    return {
      fixedDuration: null,
      maxAdditionalSeconds: 0,
      disabledReason: "Model is not available for clip lengthening.",
      note: null,
    };
  }, [clipLengthenDirection, clipLengthenModel, currentClipDurationSeconds]);
  const clipLengthenPromptAdvice = useMemo(() => {
    if (clipLengthenModel === "ltx-2.3-pro") {
      return clipLengthenDirection === "start"
        ? "Prompt the motion and camera state immediately before the current clip so it can flow into the existing first frame."
        : "Prompt the action and camera movement that should continue naturally after the current last frame.";
    }
    if (clipLengthenModel === "seedance-2.0-reference-to-video") {
      return clipLengthenDirection === "start"
        ? "Describe the moment just before @Video1 and say it should transition seamlessly into @Video1 without restarting the scene."
        : "Describe what happens after @Video1 and say it should continue naturally from @Video1 without restarting the scene.";
    }
    if (clipLengthenModel === "wan2.7-i2v") {
      return "Describe the next beat after the current clip and keep the motion/camera continuation explicit.";
    }
    if (clipLengthenModel === "veo-3.1" || clipLengthenModel === "veo-3.1-fast") {
      return "Describe the next 7 seconds after the current clip and keep the continuation of motion and camera explicit.";
    }
    return null;
  }, [clipLengthenDirection, clipLengthenModel]);
  const gridItems = useMemo<PostProcessGridItem[]>(
    () =>
      [
        ...generations.map((generation) => ({
          kind: "generation" as const,
          itemId: `generation:${generation.genId}`,
          sortTimestamp: new Date(generation.finishedAt ?? generation.updatedAt ?? generation.createdAt).getTime(),
          generation,
        })),
        ...topazItems.map((item) => ({
          kind: "topaz" as const,
          itemId: `topaz:${item.topazState?.resultExportId ?? item.sourceGeneration.genId}`,
          sortTimestamp: new Date(
            item.resultExport?.createdAt ??
              item.topazState?.updatedAt ??
              item.sourceGeneration.finishedAt ??
              item.sourceGeneration.updatedAt ??
              item.sourceGeneration.createdAt,
          ).getTime(),
          sourceGeneration: item.sourceGeneration,
          sourceExport: item.sourceExport,
          topazState: item.topazState,
          resultExport: item.resultExport,
        })),
      ].sort((left, right) => right.sortTimestamp - left.sortTimestamp),
    [generations, topazItems],
  );

  useEffect(() => {
    const fallbackModel = clipLengthenModelOptions[0]?.value ?? "ltx-2.3-pro";
    if (!clipLengthenModelOptions.some((option) => option.value === clipLengthenModel)) {
      setClipLengthenModel(fallbackModel);
      return;
    }
    if (clipLengthenModelConfig.fixedDuration != null) {
      const fixedValue = String(clipLengthenModelConfig.fixedDuration);
      if (clipLengthenDurationSeconds !== fixedValue) {
        setClipLengthenDurationSeconds(fixedValue);
      }
      return;
    }
    if (!clipLengthenDurationSeconds.trim()) {
      setClipLengthenDurationSeconds(String(Math.min(6, Math.max(1, clipLengthenModelConfig.maxAdditionalSeconds || 1))));
      return;
    }
    const numeric = Number(clipLengthenDurationSeconds);
    if (!Number.isFinite(numeric) || numeric < 1) {
      setClipLengthenDurationSeconds("1");
      return;
    }
    if (clipLengthenModelConfig.maxAdditionalSeconds > 0 && numeric > clipLengthenModelConfig.maxAdditionalSeconds) {
      setClipLengthenDurationSeconds(String(clipLengthenModelConfig.maxAdditionalSeconds));
    }
  }, [clipLengthenDurationSeconds, clipLengthenModel, clipLengthenModelConfig.fixedDuration, clipLengthenModelConfig.maxAdditionalSeconds, clipLengthenModelOptions]);

  useEffect(() => {
    if (!lengthenGenerationId) return;
    setClipLengthenDirection("end");
    setClipLengthenModel("ltx-2.3-pro");
    setClipLengthenDurationSeconds("6");
    setClipLengthenPrompt(lengthenGenerationPromptDefault);
  }, [lengthenGenerationId, lengthenGenerationPromptDefault]);

  useEffect(() => {
    if (!upscaleGenerationId) return;
    setTopazSettings(DEFAULT_TOPAZ_SETTINGS);
  }, [upscaleGenerationId]);

  const parsedClipLengthenDuration = clipLengthenModelConfig.fixedDuration ?? Number(clipLengthenDurationSeconds);
  const clipLengthenDurationIsValid =
    clipLengthenModelConfig.fixedDuration != null
      ? true
      : Number.isFinite(parsedClipLengthenDuration) &&
        parsedClipLengthenDuration >= 1 &&
        parsedClipLengthenDuration <= clipLengthenModelConfig.maxAdditionalSeconds;
  const canSubmitClipLengthen =
    Boolean(lengthenGeneration) &&
    clipLengthenModelOptions.some((option) => option.value === clipLengthenModel) &&
    !clipLengthenModelConfig.disabledReason &&
    clipLengthenDurationIsValid &&
    Boolean(clipLengthenPrompt.trim());

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink/15 bg-white p-4">
        <p className="text-sm font-semibold text-ink">{resolvedLabels.sectionTitle}</p>
        <p className="mt-1 text-sm text-ink/70">{resolvedLabels.sectionDescription}</p>
        {!gridItems.length ? (
          <div className="mt-4 rounded-xl border border-dashed border-ink/20 bg-white p-6 text-sm text-ink/60">
            {resolvedLabels.emptyState}
          </div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {gridItems.map((item) => {
              if (item.kind === "topaz") {
                const topazState = item.topazState;
                const resultExport = item.resultExport;
                const sourceGeneration = item.sourceGeneration;
                const thumbnailUrl = generationThumbnailUrl(sourceGeneration);
                const status = topazState?.status ?? "queued";
                const isReady = status === "complete" && Boolean(resultExport?.downloadUrl);
                return (
                  <article
                    key={item.itemId}
                    className={`space-y-3 rounded-xl border p-3 ${
                      status === "failed"
                        ? "border-red-200 bg-red-50"
                        : status === "queued" || status === "running"
                          ? "border-amber-200 bg-amber-50"
                          : "border-ink/10 bg-white"
                    }`}
                  >
                    <div className="block w-full overflow-hidden rounded-lg border border-ink/10 bg-bg aspect-video">
                      {thumbnailUrl ? (
                        <img
                          src={thumbnailUrl}
                          alt={`Topaz upscale of ${describeGeneration(sourceGeneration)}`}
                          className={`h-full w-full ${isReady ? "object-cover" : "object-contain opacity-75"}`}
                          loading="lazy"
                          decoding="async"
                          onError={() => onAssetError(thumbnailUrl)}
                        />
                      ) : status === "queued" || status === "running" ? (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-amber-800">
                          <Spinner className="h-5 w-5" />
                          <p className="text-xs font-medium uppercase tracking-wide">{status}</p>
                          <p className="text-xs text-amber-900/80">Waiting for processed video...</p>
                        </div>
                      ) : status === "failed" ? (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center text-red-700">
                          <p className="text-xs font-medium uppercase tracking-wide">Failed</p>
                          <p className="text-xs">Video post-process failed.</p>
                        </div>
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-4 text-xs text-ink/55">Preview unavailable</div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-ink">Topaz upscale</p>
                      <p className="text-xs text-ink/60">{describeGeneration(sourceGeneration)}</p>
                      <p className="text-[11px] text-ink/45">
                        {resultExport?.exportId ?? topazState?.resultExportId ?? item.sourceExport.exportId} ·{" "}
                        {formatCompactTimestamp(resultExport?.createdAt ?? topazState?.updatedAt ?? sourceGeneration.createdAt)}
                      </p>
                      <p className="text-xs text-ink/60">
                        {status === "complete"
                          ? `${topazState?.model ?? "Topaz"}${typeof topazState?.upscaleFactor === "number" ? ` · ${topazState.upscaleFactor}x` : ""}`
                          : status}
                      </p>
                    </div>
                    {topazState?.error ? <p className="text-[11px] text-rose-700">{topazState.error}</p> : null}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <IconActionButton
                        title="Preview"
                        onClick={() => {
                          if (!resultExport) return;
                          onPreviewTopazExport(resultExport, sourceGeneration);
                        }}
                        disabled={!resultExport?.downloadUrl}
                      >
                        <PreviewIcon />
                      </IconActionButton>
                      <IconActionButton title="Download" href={resultExport?.downloadUrl ?? undefined} download disabled={!resultExport?.downloadUrl}>
                        <DownloadIcon />
                      </IconActionButton>
                      <IconActionButton
                        title="Delete"
                        tone="danger"
                        onClick={() => {
                          if (!resultExport) return;
                          onDeleteTopazExport(resultExport, sourceGeneration);
                        }}
                        disabled={!resultExport}
                      >
                        <DeleteIcon />
                      </IconActionButton>
                    </div>
                  </article>
                );
              }

              const generation = item.generation;
              const segment = getSegmentForGeneration(generation);
              const thumbnailUrl = generationThumbnailUrl(generation);
              const topazState = topazStateByGenerationId[generation.genId];
              const topazPending = isUpscalingGeneration && topazUpscalePendingGenerationId === generation.genId;
              const isGenerationReady = generation.status === "complete" && Boolean(generation.downloadUrl);
              return (
                <article
                  key={item.itemId}
                  className={`space-y-3 rounded-xl border p-3 ${
                    generation.status === "failed"
                      ? "border-red-200 bg-red-50"
                      : generation.status === "queued" || generation.status === "running"
                        ? "border-amber-200 bg-amber-50"
                        : "border-ink/10 bg-white"
                  }`}
                >
                  <div className="block w-full overflow-hidden rounded-lg border border-ink/10 bg-bg aspect-video">
                    {thumbnailUrl && isGenerationReady ? (
                      <img
                        src={thumbnailUrl}
                        alt={describeGeneration(generation)}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                        onError={() => onAssetError(thumbnailUrl)}
                      />
                    ) : generation.status === "queued" || generation.status === "running" ? (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-amber-800">
                        <Spinner className="h-5 w-5" />
                        <p className="text-xs font-medium uppercase tracking-wide">{generation.status}</p>
                        <p className="text-xs text-amber-900/80">Waiting for generated video...</p>
                      </div>
                    ) : generation.status === "failed" ? (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center text-red-700">
                        <p className="text-xs font-medium uppercase tracking-wide">Failed</p>
                        <p className="text-xs">Video generation failed.</p>
                      </div>
                    ) : (
                      <div className="flex h-full w-full items-center justify-center px-4 text-xs text-ink/55">Preview unavailable</div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-ink">{describeGeneration(generation)}</p>
                    <p className="text-xs text-ink/60">
                      {formatModelLabel(generation, resolvedLabels.fallbackGenerationLabel)}
                      {segment ? ` · ${describeSegment(segment)}` : ""}
                    </p>
                    <p className="text-[11px] text-ink/45">
                      {generation.genId} · {formatCompactTimestamp(generation.finishedAt ?? generation.updatedAt ?? generation.createdAt)}
                    </p>
                    <p className="text-xs text-ink/60">
                      {generation.status === "complete" ? formatModelLabel(generation, resolvedLabels.fallbackGenerationLabel) : generation.status}
                    </p>
                  </div>

                  {generation.error ? <p className="text-[11px] text-rose-700">{generation.error}</p> : null}
                  {topazState?.resultExportId ? <p className="text-[11px] text-ink/55">Latest Topaz export: {topazState.resultExportId}</p> : null}
                  {topazState?.error ? <p className="text-[11px] text-rose-700">{topazState.error}</p> : null}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="rounded border border-ink/20 bg-white px-3 py-1.5 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!isGenerationReady}
                        onClick={() => setLengthenModal({ generation })}
                      >
                        Extend
                      </button>
                      <button
                        type="button"
                        className="rounded border border-ink/20 bg-white px-3 py-1.5 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={topazPending || !isGenerationReady}
                        onClick={() => setUpscaleModal({ generation })}
                      >
                        <PendingButtonLabel isPending={topazPending} idle="Upscale" pending="Queueing..." />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <IconActionButton title="Preview" onClick={() => onPreviewGeneration(generation)} disabled={!isGenerationReady}>
                        <PreviewIcon />
                      </IconActionButton>
                      <IconActionButton title="Download" href={generation.downloadUrl ?? undefined} download disabled={!isGenerationReady}>
                        <DownloadIcon />
                      </IconActionButton>
                      <IconActionButton title="Delete" tone="danger" onClick={() => onDeleteGeneration(generation)}>
                        <DeleteIcon />
                      </IconActionButton>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {lengthenModal ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/70 px-4 py-6">
          <div className="w-full max-w-3xl rounded-xl bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-ink/10 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-ink">{resolvedLabels.extendModalTitle}</h2>
                <p className="text-sm text-ink/60">{describeGeneration(lengthenModal.generation)}</p>
              </div>
              <button type="button" className="rounded-md border border-ink/15 px-3 py-1.5 text-sm text-ink/70" onClick={() => setLengthenModal(null)}>
                Close
              </button>
            </div>
            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-3 md:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="block font-medium">Extend</span>
                  <select
                    className="w-full rounded-md border border-ink/20 px-2 py-2"
                    value={clipLengthenDirection}
                    onChange={(event) => setClipLengthenDirection(event.target.value as "start" | "end")}
                  >
                    <option value="end">End</option>
                    <option value="start">Start</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="block font-medium">Model</span>
                  <select
                    className="w-full rounded-md border border-ink/20 px-2 py-2"
                    value={clipLengthenModel}
                    onChange={(event) => setClipLengthenModel(event.target.value)}
                  >
                    {clipLengthenModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="block font-medium">Add seconds</span>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, clipLengthenModelConfig.maxAdditionalSeconds)}
                    className="w-full rounded-md border border-ink/20 px-2 py-2 disabled:bg-ink/5 disabled:text-ink/50"
                    value={clipLengthenDurationSeconds}
                    onChange={(event) => setClipLengthenDurationSeconds(event.target.value)}
                    disabled={clipLengthenModelConfig.fixedDuration != null}
                  />
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_280px]">
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Prompt</span>
                  <textarea
                    rows={4}
                    className="w-full rounded-md border border-ink/20 px-2 py-2"
                    value={clipLengthenPrompt}
                    onChange={(event) => setClipLengthenPrompt(event.target.value)}
                  />
                </label>
                <div className="rounded-md border border-ink/10 bg-bg p-3 text-xs text-ink/70">
                  <p className="font-medium text-ink/85">Prompt advice</p>
                  <p className="mt-1">{clipLengthenPromptAdvice ?? "Describe the continuation clearly in relation to the current clip."}</p>
                </div>
              </div>
              {clipLengthenModelConfig.note ? <p className="text-xs text-ink/60">{clipLengthenModelConfig.note}</p> : null}
              {clipLengthenModelConfig.disabledReason ? (
                <StatusNotice variant="warning">
                  <p className="text-xs">{clipLengthenModelConfig.disabledReason}</p>
                </StatusNotice>
              ) : null}
              {lengthenGenerationError ? (
                <StatusNotice variant="error">
                  <p className="text-xs">{lengthenGenerationError}</p>
                </StatusNotice>
              ) : null}
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={() => setLengthenModal(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!canSubmitClipLengthen || isLengtheningGeneration}
                  onClick={() => {
                    onLengthenGeneration({
                      generationId: lengthenModal.generation.genId,
                      model: clipLengthenModel,
                      direction: clipLengthenDirection,
                      durationSeconds: clipLengthenModelConfig.fixedDuration ?? Number(clipLengthenDurationSeconds),
                      prompt: clipLengthenPrompt.trim(),
                      inputMode: "start_end",
                    });
                    setLengthenModal(null);
                  }}
                >
                  <PendingButtonLabel isPending={isLengtheningGeneration} idle="Queue clip extension" pending="Queueing clip extension..." />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {upscaleModal ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/70 px-4 py-6">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-ink/10 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-ink">{resolvedLabels.upscaleModalTitle}</h2>
                <p className="text-sm text-ink/60">{describeGeneration(upscaleModal.generation)}</p>
              </div>
              <button type="button" className="rounded-md border border-ink/15 px-3 py-1.5 text-sm text-ink/70" onClick={() => setUpscaleModal(null)}>
                Close
              </button>
            </div>
            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-3 md:grid-cols-4">
                <label className="space-y-1 text-sm text-ink/75">
                  <span className="block font-medium text-ink">Preset</span>
                  <select
                    className="w-full rounded-md border border-ink/20 px-2 py-2"
                    value={topazSettings.preset}
                    onChange={(event) =>
                      setTopazSettings((previous) => ({
                        ...previous,
                        preset: event.target.value as TopazUpscaleSettings["preset"],
                      }))
                    }
                  >
                    <option value="balanced">Balanced</option>
                    <option value="recover_detail">Recover detail</option>
                    <option value="fast_sharpen">Fast sharpen</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm text-ink/75">
                  <span className="block font-medium text-ink">Model</span>
                  <select
                    className="w-full rounded-md border border-ink/20 px-2 py-2"
                    value={topazSettings.model}
                    onChange={(event) => setTopazSettings((previous) => ({ ...previous, model: event.target.value }))}
                  >
                    <option value="Proteus">Proteus</option>
                    <option value="Artemis HQ">Artemis HQ</option>
                    <option value="Nyx Fast">Nyx Fast</option>
                    <option value="Starlight Sharp">Starlight Sharp</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm text-ink/75">
                  <span className="block font-medium text-ink">Scale</span>
                  <select
                    className="w-full rounded-md border border-ink/20 px-2 py-2"
                    value={topazSettings.upscaleFactor}
                    onChange={(event) =>
                      setTopazSettings((previous) => ({
                        ...previous,
                        upscaleFactor: Number(event.target.value) || 1,
                      }))
                    }
                  >
                    <option value={1}>1x (enhance only)</option>
                    <option value={2}>2x</option>
                    <option value={4}>4x</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 self-end rounded-md border border-ink/10 bg-bg px-3 py-2 text-sm text-ink/75">
                  <input
                    type="checkbox"
                    checked={topazSettings.h264Output}
                    onChange={(event) =>
                      setTopazSettings((previous) => ({
                        ...previous,
                        h264Output: event.target.checked,
                      }))
                    }
                  />
                  H264 output
                </label>
              </div>
              {topazUpscaleError ? (
                <StatusNotice variant="error">
                  <p className="text-xs">{topazUpscaleError}</p>
                </StatusNotice>
              ) : null}
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={() => setUpscaleModal(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-teal-600 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isUpscalingGeneration}
                  onClick={() => {
                    onUpscaleGeneration({
                      generationId: upscaleModal.generation.genId,
                      ...topazSettings,
                    });
                    setUpscaleModal(null);
                  }}
                >
                  <PendingButtonLabel isPending={isUpscalingGeneration} idle="Queue Topaz pass" pending="Queueing Topaz..." />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

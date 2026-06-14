import { CopyIcon, DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, Spinner, StatusNotice } from "../../components/layout/UiFeedback";
import type { SegmentGeneration } from "../../types/api";
import { copyTextToClipboard } from "../../lib/clipboard";

type PrevizGenerateModel = "veo_3_1" | "happy_horse_1_0" | "seedance_2_0";

type SelectedFrameItem = {
  referenceId: string;
  imageUrl?: string;
  title: string;
  subtitle: string;
};

export type PrevizGenerateTabCtx = {
  sceneAspectRatio: string;
  scenePrompt: string;
  selectedFrames: SelectedFrameItem[];
  model: PrevizGenerateModel;
  onModelChange: (value: PrevizGenerateModel) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  durationSec: number;
  onDurationSecChange: (value: number) => void;
  generations: SegmentGeneration[];
  selectedGenerationId: string | null;
  onGenerate: () => void;
  isGenerating: boolean;
  onSelectGeneration: (genId: string) => void;
  onPreviewGeneration: (generation: SegmentGeneration) => void;
  onDeleteGeneration: (generation: SegmentGeneration) => void;
};

type Props = { ctx: PrevizGenerateTabCtx };

const MODEL_OPTIONS: Array<{ value: PrevizGenerateModel; label: string }> = [
  { value: "veo_3_1", label: "Veo 3.1" },
  { value: "happy_horse_1_0", label: "Happy Horse 1.0" },
  { value: "seedance_2_0", label: "ByteDance Seedance 2.0" },
];

const DURATION_OPTIONS = [4, 6, 8, 10, 12, 15];

function modelGuidance(model: PrevizGenerateModel, frameCount: number, aspectRatio: string): string {
  if (model === "veo_3_1") {
    return `Uses the first selected frame as the shot start and the last selected frame as the shot end. Best when you have clear opening and closing beat frames. Output is conformed back to the scene aspect ratio (${aspectRatio}).`;
  }
  if (model === "happy_horse_1_0") {
    return `Uses the first selected frame as the main storyboard image and relies on the prompt for motion direction. This is best for a single strong keyframe. Output is conformed back to the scene aspect ratio (${aspectRatio}).`;
  }
  return frameCount > 1
    ? `Uses the selected frames as ordered storyboard references, with the prompt guiding motion between them. This is the most flexible option when you have start, key, and end beats. Output is conformed back to the scene aspect ratio (${aspectRatio}).`
    : `Uses the selected storyboard image as the primary scene reference and builds motion from the prompt. Output is conformed back to the scene aspect ratio (${aspectRatio}).`;
}

function generationPosterFrameClass(generation: SegmentGeneration) {
  const storedOutput = generation.generationSettings?.storedOutput;
  const width = Number(storedOutput?.width ?? 0);
  const height = Number(storedOutput?.height ?? 0);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > width) {
    return "aspect-[3/4]";
  }
  return "aspect-video";
}

function generationTitle(generation: SegmentGeneration): string {
  const rawValue =
    generation.generationSettings?.requestedModel ??
    generation.generationSettings?.model ??
    generation.luma.model;
  const raw = typeof rawValue === "string" ? rawValue : "";
  if (raw === "veo_3_1") return "Veo 3.1";
  if (raw === "happy_horse_1_0") return "Happy Horse 1.0";
  if (raw === "seedance_2_0") return "ByteDance Seedance 2.0";
  return raw || "Previz generation";
}

export default function PrevizGenerateTab({ ctx }: Props) {
  const {
    sceneAspectRatio,
    scenePrompt,
    selectedFrames,
    model,
    onModelChange,
    prompt,
    onPromptChange,
    durationSec,
    onDurationSecChange,
    generations,
    selectedGenerationId,
    onGenerate,
    isGenerating,
    onSelectGeneration,
    onPreviewGeneration,
    onDeleteGeneration,
  } = ctx;

  const canGenerate = selectedFrames.length > 0 && prompt.trim().length > 0 && !isGenerating;
  const guidance = modelGuidance(model, selectedFrames.length, sceneAspectRatio);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink/15 bg-white p-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="previz-generate-model">
                Model
              </label>
              <select
                id="previz-generate-model"
                value={model}
                onChange={(event) => onModelChange(event.target.value as PrevizGenerateModel)}
                className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
              >
                {MODEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="previz-generate-aspect">
                  Scene aspect ratio
                </label>
                <div id="previz-generate-aspect" className="rounded-lg border border-ink/15 bg-bg px-3 py-2 text-sm text-ink">
                  {sceneAspectRatio}
                </div>
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="previz-generate-duration">
                  Duration
                </label>
                <select
                  id="previz-generate-duration"
                  value={String(durationSec)}
                  onChange={(event) => onDurationSecChange(Number(event.target.value))}
                  className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                >
                  {DURATION_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}s
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="previz-generate-prompt">
                Text prompt
              </label>
              <textarea
                id="previz-generate-prompt"
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                rows={5}
                placeholder="Describe the shot, camera movement, pacing, and action you want the previz clip to show."
                className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
              />
            </div>
            <button
              type="button"
              disabled={!canGenerate}
              onClick={onGenerate}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PendingButtonLabel isPending={isGenerating} idle="Generate video" pending="Generating..." />
            </button>
          </div>
          <div className="rounded-xl border border-ink/10 bg-bg p-4 text-sm text-ink/75">
            <p className="font-medium text-ink">Model guidance</p>
            <p className="mt-2">{guidance}</p>
            {scenePrompt ? <p className="mt-3 text-xs text-ink/60">Scene brief: {scenePrompt}</p> : null}
          </div>
        </div>
      </div>

      {selectedFrames.length === 0 ? (
        <StatusNotice variant="warning">
          <p className="text-xs">Select one or more frames in the Edit step before generating a previz video.</p>
        </StatusNotice>
      ) : null}

      <div className="space-y-3 rounded-xl border border-ink/10 bg-white p-4">
        <p className="text-sm font-semibold text-ink">Generated videos</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {generations.map((generation) => {
            const posterUrl = generation.posterUrl ?? generation.downloadUrl ?? undefined;
            const status = generation.status;
            const selectable = status === "complete" && Boolean(generation.downloadUrl);
            const copyablePrompt = generation.luma.prompt?.trim() ?? "";
            return (
              <article
                key={generation.genId}
                className={`space-y-2 rounded-xl border p-3 ${
                  generation.genId === selectedGenerationId
                    ? "border-teal-500 bg-teal-50"
                    : status === "failed"
                      ? "border-red-200 bg-red-50"
                      : status === "queued" || status === "running"
                        ? "border-amber-200 bg-amber-50"
                        : "border-ink/10 bg-white"
                }`}
              >
                <button
                  type="button"
                  disabled={!selectable}
                  onClick={() => selectable && onSelectGeneration(generation.genId)}
                  className={`block w-full overflow-hidden rounded-lg border border-ink/10 bg-bg ${generationPosterFrameClass(generation)} disabled:cursor-default`}
                >
                  {posterUrl ? (
                    <img src={posterUrl} alt={generationTitle(generation)} className="h-full w-full object-contain" loading="lazy" decoding="async" />
                  ) : status === "queued" || status === "running" ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-amber-800">
                      <Spinner className="h-5 w-5" />
                      <p className="text-xs font-medium uppercase tracking-wide">{status}</p>
                      <p className="text-xs text-amber-900/80">Waiting for generated video...</p>
                    </div>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center px-4 text-xs text-ink/55">Preview unavailable</div>
                  )}
                </button>
                <div className="space-y-1">
                  <p className="truncate text-sm font-medium text-ink">{generationTitle(generation)}</p>
                  <p className="truncate text-xs text-ink/60">{status === "complete" ? `${durationSec}s target · ${sceneAspectRatio}` : status}</p>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={!selectable}
                    onClick={() => selectable && onSelectGeneration(generation.genId)}
                    className={`rounded border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                      generation.genId === selectedGenerationId ? "border-teal-500 bg-teal-50 text-teal-800" : "border-ink/20 bg-white text-ink/70"
                    }`}
                  >
                    {generation.genId === selectedGenerationId ? "Selected" : "Select"}
                  </button>
                  <div className="flex items-center gap-2">
                    <IconActionButton title="Preview" disabled={!generation.downloadUrl} onClick={() => onPreviewGeneration(generation)}>
                      <PreviewIcon />
                    </IconActionButton>
                    <IconActionButton title="Download" href={generation.downloadUrl} download disabled={!generation.downloadUrl}>
                      <DownloadIcon />
                    </IconActionButton>
                    {copyablePrompt ? (
                      <IconActionButton title="Copy prompt" onClick={() => void copyTextToClipboard(copyablePrompt)}>
                        <CopyIcon />
                      </IconActionButton>
                    ) : null}
                    <IconActionButton title="Delete" tone="danger" onClick={() => onDeleteGeneration(generation)}>
                      <DeleteIcon />
                    </IconActionButton>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

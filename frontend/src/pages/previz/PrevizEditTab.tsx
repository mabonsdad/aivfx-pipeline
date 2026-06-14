import { useEffect, useMemo, useState } from "react";

import { CopyIcon, DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, Spinner, StatusNotice } from "../../components/layout/UiFeedback";
import { copyTextToClipboard } from "../../lib/clipboard";

type GenerateFrameModel = "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro" | "luma_uni_1" | "luma_uni_1_max";

type FrameLibraryItem = {
  referenceId: string;
  imageUrl?: string;
  title: string;
  subtitle: string;
  selected: boolean;
  status?: "queued" | "running" | "complete" | "failed";
  prompt?: string | null;
};

export type PrevizEditTabCtx = {
  taskId?: string | null;
  sceneAspectRatio: string;
  selectedReferenceCount: number;
  frames: FrameLibraryItem[];
  prompt: string;
  onPromptChange: (value: string) => void;
  onCreateFrame: (payload: {
    model: GenerateFrameModel;
    prompt: string;
    aspectRatio: string;
  }) => Promise<void>;
  onToggleFrameSelection: (referenceId: string) => Promise<void>;
  onRemoveFrame: (referenceId: string) => Promise<void>;
  onPreviewFrame: (payload: { url: string; label: string }) => void;
};

type Props = { ctx: PrevizEditTabCtx };

const NANO_BANANA_PRO_SUPPORTED_ASPECT_RATIOS = new Set(["16:9", "3:2", "4:3", "1:1", "5:4", "4:5", "2:3", "3:4", "9:16"]);

export default function PrevizEditTab({ ctx }: Props) {
  const {
    taskId,
    sceneAspectRatio,
    selectedReferenceCount,
    frames,
    prompt,
    onPromptChange,
    onCreateFrame,
    onToggleFrameSelection,
    onRemoveFrame,
    onPreviewFrame,
  } = ctx;
  const [model, setModel] = useState<GenerateFrameModel>("chatgpt_latest");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [togglingIds, setTogglingIds] = useState<Record<string, boolean>>({});
  const nanoBananaProAspectUnsupported = useMemo(
    () => model === "nano_banana_pro" && !NANO_BANANA_PRO_SUPPORTED_ASPECT_RATIOS.has(sceneAspectRatio),
    [model, sceneAspectRatio],
  );

  useEffect(() => {
    setError(null);
  }, [taskId]);

  async function handleGenerate() {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError("Write a prompt before creating frames.");
      return;
    }
    if (nanoBananaProAspectUnsupported) {
      setError(`Nano Banana Pro does not support ${sceneAspectRatio}. Choose another model or change the scene aspect ratio.`);
      return;
    }
    setError(null);
    setIsGenerating(true);
    try {
      await onCreateFrame({
        model,
        prompt: trimmedPrompt,
        aspectRatio: sceneAspectRatio,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Frame generation failed");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleToggle(referenceId: string) {
    setTogglingIds((previous) => ({ ...previous, [referenceId]: true }));
    setError(null);
    try {
      await onToggleFrameSelection(referenceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update selected frames");
    } finally {
      setTogglingIds((previous) => ({ ...previous, [referenceId]: false }));
    }
  }

  async function handleDelete(referenceId: string) {
    setDeletingIds((previous) => ({ ...previous, [referenceId]: true }));
    setError(null);
    try {
      await onRemoveFrame(referenceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingIds((previous) => ({ ...previous, [referenceId]: false }));
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-ink/15 bg-white p-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-ink">Create key frames</p>
          <p className="text-sm text-ink/70">
            Generate images for start and end frames, and optionally frames for key beats, using the reference images you have selected for continuity.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={model}
            onChange={(event) => setModel(event.target.value as GenerateFrameModel)}
            className="rounded-md border border-ink/20 px-3 py-2 text-sm"
          >
            <option value="chatgpt_latest">ChatGPT Image Latest</option>
            <option value="chatgpt">ChatGPT Image</option>
            <option value="nano_banana_pro">Nano Banana Pro</option>
            <option value="nano_banana">Nano Banana</option>
            <option value="luma_uni_1">Luma Uni-1</option>
            <option value="luma_uni_1_max">Luma Uni-1 Max</option>
          </select>
          <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-sm text-ink/70">
            Scene aspect ratio: <span className="font-medium text-ink">{sceneAspectRatio}</span>
          </div>
          <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-sm text-ink/70">
            Selected references: <span className="font-medium text-ink">{selectedReferenceCount}</span>
          </div>
        </div>
        {nanoBananaProAspectUnsupported ? (
          <StatusNotice variant="warning">
            <p>Nano Banana Pro does not support the current scene aspect ratio `{sceneAspectRatio}`. Choose another model or change the scene aspect ratio in Select.</p>
          </StatusNotice>
        ) : null}
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink/75">Text prompt</span>
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            className="h-24 w-full rounded-md border border-ink/20 p-2 text-sm"
            placeholder="Describe the frame sequence you want to create."
          />
        </label>
        <div>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isGenerating || selectedReferenceCount === 0 || nanoBananaProAspectUnsupported}
            onClick={() => void handleGenerate()}
          >
            <PendingButtonLabel isPending={isGenerating} idle="Create frame" pending="Creating..." />
          </button>
        </div>
      </div>

      {error ? (
        <StatusNotice variant="error">
          <p className="text-xs">{error}</p>
        </StatusNotice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {frames.map((frame) => (
          <article
            key={frame.referenceId}
            className={`space-y-2 rounded-lg border p-3 ${
              frame.status === "failed"
                ? "border-red-200 bg-red-50"
                : frame.status === "queued" || frame.status === "running"
                  ? "border-amber-200 bg-amber-50"
                  : frame.selected
                    ? "border-teal-500 bg-teal-50"
                    : "border-ink/10 bg-white"
            }`}
          >
            <button
              type="button"
              className="block w-full overflow-hidden rounded-lg border border-ink/10 bg-bg disabled:cursor-default"
              disabled={!frame.imageUrl || (frame.status != null && frame.status !== "complete") || Boolean(togglingIds[frame.referenceId])}
              onClick={() => void handleToggle(frame.referenceId)}
            >
              {frame.imageUrl ? (
                <img src={frame.imageUrl} alt={frame.title} className="aspect-video w-full object-contain" loading="lazy" decoding="async" />
              ) : frame.status === "queued" || frame.status === "running" ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 text-amber-800">
                  <Spinner className="h-5 w-5" />
                  <p className="text-xs font-medium uppercase tracking-wide">{frame.status}</p>
                  <p className="text-xs text-amber-900/80">Waiting for generated frame...</p>
                </div>
              ) : frame.status === "failed" ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 px-3 text-center text-red-700">
                  <p className="text-xs font-medium uppercase tracking-wide">Failed</p>
                  <p className="text-xs">Frame generation failed.</p>
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center text-xs text-ink/55">Image unavailable</div>
              )}
            </button>
            <div className="space-y-1">
              <p className="truncate text-sm font-medium text-ink">{frame.title}</p>
              <p className="truncate text-xs text-ink/60">{frame.subtitle}</p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!frame.imageUrl || (frame.status != null && frame.status !== "complete") || Boolean(togglingIds[frame.referenceId])}
                className={`rounded border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                  frame.selected ? "border-teal-500 bg-teal-50 text-teal-800" : "border-ink/20 bg-white text-ink/70"
                }`}
                onClick={() => void handleToggle(frame.referenceId)}
              >
                {frame.selected ? "Selected" : "Select"}
              </button>
              <div className="flex items-center gap-2">
                <IconActionButton
                  title="Preview"
                  disabled={!frame.imageUrl}
                  onClick={() => {
                    if (!frame.imageUrl) return;
                    onPreviewFrame({ url: frame.imageUrl, label: frame.title });
                  }}
                >
                  <PreviewIcon />
                </IconActionButton>
                <IconActionButton title="Download" href={frame.imageUrl} download disabled={!frame.imageUrl}>
                  <DownloadIcon />
                </IconActionButton>
                {frame.prompt?.trim() ? (
                  <IconActionButton
                    title="Copy prompt"
                    onClick={() => {
                      void copyTextToClipboard(frame.prompt ?? "").catch((err) => {
                        setError(err instanceof Error ? err.message : "Prompt copy failed");
                      });
                    }}
                  >
                    <CopyIcon />
                  </IconActionButton>
                ) : null}
                <IconActionButton
                  title={deletingIds[frame.referenceId] ? "Deleting..." : "Delete"}
                  tone="danger"
                  disabled={Boolean(deletingIds[frame.referenceId])}
                  onClick={() => void handleDelete(frame.referenceId)}
                >
                  <DeleteIcon />
                </IconActionButton>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

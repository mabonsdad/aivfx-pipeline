import { useEffect, useState } from "react";

import { CopyIcon, DeleteIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, Spinner, StatusNotice } from "../../components/layout/UiFeedback";
import { copyTextToClipboard } from "../../lib/clipboard";

type ReferenceLibraryItem = {
  referenceId: string;
  imageUrl?: string;
  title: string;
  subtitle: string;
  selectedForVideo: boolean;
  status?: "queued" | "running" | "complete" | "failed";
  error?: string | null;
  prompt?: string | null;
};

type GenerateReferenceModel = "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro" | "luma_uni_1" | "luma_uni_1_max";

type ToolSelectedReferenceItem = {
  referenceId: string;
  imageUrl?: string;
  title: string;
  subtitle: string;
};

export type EditVideoReferencesTabCtx = {
  taskId?: string | null;
  references: ReferenceLibraryItem[];
  warning: string | null;
  openVideoReferencePicker: () => void;
  openToolReferencePicker: () => void;
  toolSelectedReferences: ToolSelectedReferenceItem[];
  generatePrompt: string;
  onGeneratePromptChange: (value: string) => void;
  moveToolSelectedReference: (referenceId: string, direction: -1 | 1) => void;
  removeToolSelectedReference: (referenceId: string) => void;
  toggleVideoReference: (referenceId: string) => void;
  removeReference: (referenceId: string) => Promise<void>;
  previewReference: (payload: { url: string; label: string }) => void;
  generateReferenceImage: (payload: {
    model: GenerateReferenceModel;
    prompt: string;
    aspectRatio?: string | null;
  }) => Promise<void>;
  labels?: {
    selectTitle?: string;
    selectDescription?: string;
    selectButtonLabel?: string;
    createTitle?: string;
    toolPickerButtonLabel?: string;
    promptPlaceholder?: string;
    promptHelper?: string;
    createButtonIdle?: string;
    createButtonPending?: string;
    selectedTokenPrefix?: string;
    useAssetButtonLabel?: string;
    removeAssetButtonLabel?: string;
    queuedHint?: string;
    failedHint?: string;
  };
  preferredAspectRatio?: string | null;
  addTopSpacing?: boolean;
};

type Props = { ctx: EditVideoReferencesTabCtx };

const MODEL_ASPECT_RATIO_OPTIONS: Record<GenerateReferenceModel, Array<{ value: string; label: string }>> = {
  chatgpt_latest: [
    { value: "3:2", label: "3:2" },
    { value: "1:1", label: "1:1" },
    { value: "2:3", label: "2:3" },
  ],
  chatgpt: [
    { value: "3:2", label: "3:2" },
    { value: "1:1", label: "1:1" },
    { value: "2:3", label: "2:3" },
  ],
  nano_banana: [
    { value: "16:9", label: "16:9" },
    { value: "3:2", label: "3:2" },
    { value: "4:3", label: "4:3" },
    { value: "1:1", label: "1:1" },
    { value: "4:5", label: "4:5" },
    { value: "2:3", label: "2:3" },
    { value: "9:16", label: "9:16" },
    { value: "21:9", label: "21:9" },
  ],
  nano_banana_pro: [
    { value: "16:9", label: "16:9" },
    { value: "3:2", label: "3:2" },
    { value: "4:3", label: "4:3" },
    { value: "1:1", label: "1:1" },
    { value: "5:4", label: "5:4" },
    { value: "4:5", label: "4:5" },
    { value: "2:3", label: "2:3" },
    { value: "3:4", label: "3:4" },
    { value: "9:16", label: "9:16" },
  ],
  luma_uni_1: [
    { value: "auto", label: "Auto" },
    { value: "3:1", label: "3:1" },
    { value: "2:1", label: "2:1" },
    { value: "16:9", label: "16:9" },
    { value: "3:2", label: "3:2" },
    { value: "1:1", label: "1:1" },
    { value: "2:3", label: "2:3" },
    { value: "9:16", label: "9:16" },
    { value: "1:2", label: "1:2" },
    { value: "1:3", label: "1:3" },
  ],
  luma_uni_1_max: [
    { value: "auto", label: "Auto" },
    { value: "3:1", label: "3:1" },
    { value: "2:1", label: "2:1" },
    { value: "16:9", label: "16:9" },
    { value: "3:2", label: "3:2" },
    { value: "1:1", label: "1:1" },
    { value: "2:3", label: "2:3" },
    { value: "9:16", label: "9:16" },
    { value: "1:2", label: "1:2" },
    { value: "1:3", label: "1:3" },
  ],
};

const MAX_REFERENCE_IMAGES_BY_MODEL: Partial<Record<GenerateReferenceModel, number>> = {
  nano_banana: 3,
};

function aspectRatioValueToNumber(value: string): number | null {
  if (!value || value === "auto") return null;
  const [left, right] = value.split(":").map(Number);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return null;
  return left / right;
}

function nearestAspectRatioValue(
  options: Array<{ value: string; label: string }>,
  preferredValue: string | null | undefined,
): string | null {
  const preferredRatio = preferredValue ? aspectRatioValueToNumber(preferredValue) : null;
  if (preferredRatio == null) return null;
  const ranked = options
    .map((option) => ({
      value: option.value,
      ratio: aspectRatioValueToNumber(option.value),
    }))
    .filter((option): option is { value: string; ratio: number } => option.ratio != null);
  if (!ranked.length) return null;
  ranked.sort((left, right) => Math.abs(left.ratio - preferredRatio) - Math.abs(right.ratio - preferredRatio));
  return ranked[0]?.value ?? null;
}

export default function EditVideoReferencesTab({ ctx }: Props) {
  const {
    taskId,
    references,
    warning,
    openVideoReferencePicker,
    openToolReferencePicker,
    toolSelectedReferences,
    generatePrompt,
    onGeneratePromptChange,
    moveToolSelectedReference,
    removeToolSelectedReference,
    toggleVideoReference,
    removeReference,
    previewReference,
    generateReferenceImage,
    labels,
    preferredAspectRatio,
    addTopSpacing,
  } = ctx;
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateModel, setGenerateModel] = useState<GenerateReferenceModel>("chatgpt_latest");
  const [generateAspectRatio, setGenerateAspectRatio] = useState<string>(
    nearestAspectRatioValue(MODEL_ASPECT_RATIO_OPTIONS.chatgpt_latest, preferredAspectRatio) ?? "1:1",
  );
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setError(null);
  }, [taskId]);

  const aspectRatioOptions = MODEL_ASPECT_RATIO_OPTIONS[generateModel];
  const selectedTokenPrefix = labels?.selectedTokenPrefix ?? "Reference";
  const maxReferenceImages = MAX_REFERENCE_IMAGES_BY_MODEL[generateModel] ?? null;
  const tooManyReferencesForModel = maxReferenceImages != null && toolSelectedReferences.length > maxReferenceImages;

  function handleModelChange(nextModel: GenerateReferenceModel) {
    setGenerateModel(nextModel);
    const nextOptions = MODEL_ASPECT_RATIO_OPTIONS[nextModel];
    const preferredNextValue = nearestAspectRatioValue(nextOptions, preferredAspectRatio);
    if (preferredNextValue) {
      setGenerateAspectRatio(preferredNextValue);
      return;
    }
    if (!nextOptions.some((option) => option.value === generateAspectRatio)) {
      setGenerateAspectRatio(nextOptions[0]?.value ?? "1:1");
    }
  }

  async function handleGenerate() {
    const prompt = generatePrompt.trim();
    if (!prompt) {
      setError("Write a prompt before creating a reference image.");
      return;
    }
    if (tooManyReferencesForModel) {
      setError(`${generateModel === "nano_banana" ? "Nano Banana" : "This model"} supports up to ${maxReferenceImages} reference images in this tool. Remove some references or choose another model.`);
      return;
    }
    setError(null);
    setIsGenerating(true);
    try {
      await generateReferenceImage({
        model: generateModel,
        prompt,
        aspectRatio: generateAspectRatio === "auto" ? null : generateAspectRatio,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image generation failed");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleDelete(referenceId: string) {
    setDeletingIds((previous) => ({ ...previous, [referenceId]: true }));
    setError(null);
    try {
      await removeReference(referenceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingIds((previous) => ({ ...previous, [referenceId]: false }));
    }
  }

  return (
    <div className={`space-y-4 ${addTopSpacing ? "pt-4" : ""}`}>
      <div className="rounded-xl border border-ink/15 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-ink">{labels?.selectTitle ?? "Select reference image(s)"}</p>
            <p className="text-sm text-ink/70">
              {labels?.selectDescription ??
                "Use reference images to control style, lighting or content when editing the video. Selected images appear in the Current working references above and can be uploaded, picked from previously created files or you can create them below."}
            </p>
          </div>
          <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white" onClick={openVideoReferencePicker}>
            {labels?.selectButtonLabel ?? "Add / edit reference images"}
          </button>
        </div>
        {warning ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{warning}</div> : null}
      </div>

      <div className="space-y-3 rounded-xl border border-ink/15 bg-white p-4">
        <p className="text-sm font-semibold text-ink">{labels?.createTitle ?? "Create reference image(s)"}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={generateModel}
            onChange={(event) => handleModelChange(event.target.value as GenerateReferenceModel)}
            className="rounded-md border border-ink/20 px-3 py-2 text-sm"
          >
            <option value="chatgpt_latest">ChatGPT Image Latest</option>
            <option value="chatgpt">ChatGPT Image</option>
            <option value="nano_banana_pro">Nano Banana Pro</option>
            <option value="nano_banana">Nano Banana</option>
            <option value="luma_uni_1">Luma Uni-1</option>
            <option value="luma_uni_1_max">Luma Uni-1 Max</option>
          </select>
          <select
            value={generateAspectRatio}
            onChange={(event) => setGenerateAspectRatio(event.target.value)}
            className="rounded-md border border-ink/20 px-3 py-2 text-sm"
          >
            {aspectRatioOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink"
            onClick={openToolReferencePicker}
          >
            {labels?.toolPickerButtonLabel ?? "Use reference images"}
          </button>
        </div>
        {toolSelectedReferences.length ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 bg-bg p-3">
            {toolSelectedReferences.map((reference, index) => (
              <div key={reference.referenceId} className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-2 py-2">
                {reference.imageUrl ? <img src={reference.imageUrl} alt={reference.title} className="h-10 w-10 rounded bg-white object-contain" /> : null}
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-ink">{selectedTokenPrefix} {index + 1}</p>
                  <p className="max-w-[120px] truncate text-[11px] text-ink/60">{reference.title}</p>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px]"
                    disabled={index === 0}
                    onClick={() => moveToolSelectedReference(reference.referenceId, -1)}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px]"
                    disabled={index === toolSelectedReferences.length - 1}
                    onClick={() => moveToolSelectedReference(reference.referenceId, 1)}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px]"
                    onClick={() => removeToolSelectedReference(reference.referenceId)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {tooManyReferencesForModel ? (
          <StatusNotice variant="warning">
            <p>{generateModel === "nano_banana" ? "Nano Banana" : "This model"} supports up to {maxReferenceImages} reference images in this tool. Remove some references or choose another model.</p>
          </StatusNotice>
        ) : null}
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink/75">Text prompt</span>
          <textarea
            value={generatePrompt}
            onChange={(event) => onGeneratePromptChange(event.target.value)}
            className="h-24 w-full rounded-md border border-ink/20 p-2 text-sm"
            placeholder={labels?.promptPlaceholder ?? "Describe the reference image you want to create."}
          />
        </label>
        <p className="text-[11px] text-ink/60">
          {labels?.promptHelper ?? "If using reference images, describe their purpose in the prompt in the order they appear above."}
        </p>
        <div>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isGenerating || tooManyReferencesForModel}
            onClick={() => void handleGenerate()}
          >
            <PendingButtonLabel
              isPending={isGenerating}
              idle={labels?.createButtonIdle ?? "Create image"}
              pending={labels?.createButtonPending ?? "Creating..."}
            />
          </button>
        </div>
      </div>

      {error ? (
        <StatusNotice variant="error">
          <p className="text-xs">{error}</p>
        </StatusNotice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {references.map((reference) => (
          <article
            key={reference.referenceId}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (!reference.imageUrl || (reference.status && reference.status !== "complete")) return;
              toggleVideoReference(reference.referenceId);
            }}
            onKeyDown={(event) => {
              if (!reference.imageUrl || (reference.status && reference.status !== "complete")) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleVideoReference(reference.referenceId);
              }
            }}
            className={`space-y-2 rounded-lg border p-3 transition-colors ${
              reference.status === "failed"
                ? "border-red-200 bg-red-50"
                : reference.status === "queued" || reference.status === "running"
                  ? "border-amber-200 bg-amber-50"
                  : reference.selectedForVideo
                    ? "border-teal-500 bg-teal-50"
                    : "border-ink/10 bg-white"
            }`}
          >
            <div className="overflow-hidden rounded-lg border border-ink/10 bg-bg">
              {reference.imageUrl ? (
                <img
                  src={reference.imageUrl}
                  alt={reference.title}
                  className="aspect-video w-full object-contain"
                  loading="lazy"
                  decoding="async"
                />
              ) : reference.status === "queued" || reference.status === "running" ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 text-amber-800">
                  <Spinner className="h-5 w-5" />
                  <p className="text-xs font-medium uppercase tracking-wide">{reference.status}</p>
                  <p className="text-xs text-amber-900/80">{labels?.queuedHint ?? "Waiting for generated image..."}</p>
                </div>
              ) : reference.status === "failed" ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 px-3 text-center text-red-700">
                  <p className="text-xs font-medium uppercase tracking-wide">Failed</p>
                  <p className="text-xs">{reference.error?.trim() || labels?.failedHint || "Reference image generation failed."}</p>
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center text-xs text-ink/55">Image unavailable</div>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{reference.title}</p>
                  <p className="truncate text-xs text-ink/60">{reference.subtitle}</p>
                </div>
                {reference.selectedForVideo ? <span className="shrink-0 text-[11px] font-medium text-teal-700">Selected</span> : null}
              </div>
              {reference.status === "failed" ? (
                <p className="text-xs text-red-700">{reference.error?.trim() || "Generation failed. Delete this placeholder or try again."}</p>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!reference.imageUrl || (reference.status != null && reference.status !== "complete")}
                className={`rounded border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                  reference.selectedForVideo ? "border-teal-500 bg-teal-50 text-teal-800" : "border-ink/20 bg-white text-ink/70"
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!reference.imageUrl || (reference.status && reference.status !== "complete")) return;
                  toggleVideoReference(reference.referenceId);
                }}
              >
                {reference.selectedForVideo
                  ? labels?.removeAssetButtonLabel ?? "Remove Video Ref"
                  : labels?.useAssetButtonLabel ?? "Use as Video Ref"}
              </button>
              <div
                className="flex items-center gap-2"
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
              <IconActionButton
                title="Preview"
                disabled={!reference.imageUrl}
                onClick={() => {
                  if (!reference.imageUrl) return;
                  previewReference({ url: reference.imageUrl, label: reference.title });
                }}
              >
                <PreviewIcon />
              </IconActionButton>
              {reference.prompt?.trim() ? (
                <IconActionButton
                  title="Copy prompt"
                  onClick={() => {
                    void copyTextToClipboard(reference.prompt ?? "").catch((err) => {
                      setError(err instanceof Error ? err.message : "Prompt copy failed");
                    });
                  }}
                >
                  <CopyIcon />
                </IconActionButton>
              ) : null}
              <IconActionButton
                title={deletingIds[reference.referenceId] ? "Deleting..." : "Delete"}
                tone="danger"
                disabled={Boolean(deletingIds[reference.referenceId])}
                onClick={() => void handleDelete(reference.referenceId)}
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

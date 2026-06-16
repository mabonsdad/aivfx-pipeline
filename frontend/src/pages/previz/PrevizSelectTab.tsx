import { useEffect, useMemo, useState } from "react";

import { CopyIcon, DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, Spinner, StatusNotice } from "../../components/layout/UiFeedback";
import { copyTextToClipboard } from "../../lib/clipboard";
import { summarizeImageGenerationError } from "../../lib/imageGenerationErrorSummary";

type GenerateReferenceModel = "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro" | "luma_uni_1" | "luma_uni_1_max";
type PrevizReferenceMode = "image" | "sheet";
type PrevizSheetType = "character_objects" | "location" | "lighting_colour" | "camera_composition";

type ReferenceLibraryItem = {
  referenceId: string;
  imageUrl?: string;
  title: string;
  subtitle: string;
  selected: boolean;
  model?: GenerateReferenceModel | null;
  status?: "queued" | "running" | "complete" | "failed";
  error?: string | null;
  prompt?: string | null;
};

type ToolSelectedReferenceItem = {
  referenceId: string;
  imageUrl?: string;
  title: string;
  subtitle: string;
};

export type PrevizSelectTabCtx = {
  taskId?: string | null;
  sceneAspectRatio: string | null;
  onSceneAspectRatioChange: (aspectRatio: string) => Promise<void>;
  uploadReferences: ReferenceLibraryItem[];
  createdReferences: ReferenceLibraryItem[];
  warning: string | null;
  openSceneReferencePicker: () => void;
  openToolReferencePicker: () => void;
  toolSelectedReferences: ToolSelectedReferenceItem[];
  generatePrompt: string;
  onGeneratePromptChange: (value: string) => void;
  moveToolSelectedReference: (referenceId: string, direction: -1 | 1) => void;
  removeToolSelectedReference: (referenceId: string) => void;
  toggleReferenceSelection: (referenceId: string) => Promise<void>;
  removeReference: (referenceId: string) => Promise<void>;
  previewReference: (payload: { url: string; label: string }) => void;
  generateReferenceImage: (payload: {
    model: GenerateReferenceModel;
    prompt: string;
    aspectRatio?: string | null;
  }) => Promise<void>;
};

type Props = { ctx: PrevizSelectTabCtx };

const SCENE_ASPECT_RATIO_OPTIONS = [
  { value: "21:9", label: "21:9" },
  { value: "16:9", label: "16:9" },
  { value: "4:3", label: "4:3" },
  { value: "1:1", label: "1:1" },
  { value: "3:4", label: "3:4" },
  { value: "9:16", label: "9:16" },
];

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

const SHEET_TYPE_OPTIONS: Array<{ value: PrevizSheetType; label: string }> = [
  { value: "character_objects", label: "Character / objects" },
  { value: "location", label: "Location" },
  { value: "lighting_colour", label: "Lighting / colour" },
  { value: "camera_composition", label: "Camera / composition" },
];

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
    .map((option) => ({ value: option.value, ratio: aspectRatioValueToNumber(option.value) }))
    .filter((option): option is { value: string; ratio: number } => option.ratio != null);
  if (!ranked.length) return null;
  ranked.sort((left, right) => Math.abs(left.ratio - preferredRatio) - Math.abs(right.ratio - preferredRatio));
  return ranked[0]?.value ?? null;
}

function modelTokenForIndex(index: number): string {
  return `@Image${index + 1}`;
}

function sheetTypePromptPrefix(sheetType: PrevizSheetType): string {
  switch (sheetType) {
    case "character_objects":
      return "Create a character and objects reference sheet";
    case "location":
      return "Create a location reference sheet";
    case "lighting_colour":
      return "Create a lighting and colour reference sheet";
    case "camera_composition":
      return "Create a camera and composition reference sheet";
    default:
      return "Create a reference sheet";
  }
}

export default function PrevizSelectTab({ ctx }: Props) {
  const {
    taskId,
    sceneAspectRatio,
    onSceneAspectRatioChange,
    uploadReferences,
    createdReferences,
    warning,
    openSceneReferencePicker,
    openToolReferencePicker,
    toolSelectedReferences,
    generatePrompt,
    onGeneratePromptChange,
    moveToolSelectedReference,
    removeToolSelectedReference,
    toggleReferenceSelection,
    removeReference,
    previewReference,
    generateReferenceImage,
  } = ctx;

  const [referenceMode, setReferenceMode] = useState<PrevizReferenceMode>("image");
  const [sheetType, setSheetType] = useState<PrevizSheetType>("character_objects");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateModel, setGenerateModel] = useState<GenerateReferenceModel>("chatgpt_latest");
  const [generateAspectRatio, setGenerateAspectRatio] = useState<string>(
    nearestAspectRatioValue(MODEL_ASPECT_RATIO_OPTIONS.chatgpt_latest, sceneAspectRatio) ?? "1:1",
  );
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [togglingIds, setTogglingIds] = useState<Record<string, boolean>>({});
  const [isSavingSceneAspectRatio, setIsSavingSceneAspectRatio] = useState(false);

  useEffect(() => {
    setError(null);
  }, [taskId]);

  const aspectRatioOptions = MODEL_ASPECT_RATIO_OPTIONS[generateModel];
  const sceneAspectRatioValue = sceneAspectRatio ?? "16:9";
  const maxReferenceImages = MAX_REFERENCE_IMAGES_BY_MODEL[generateModel] ?? null;
  const tooManyReferencesForModel = maxReferenceImages != null && toolSelectedReferences.length > maxReferenceImages;
  const generatedPromptHelper = useMemo(() => {
    if (referenceMode !== "sheet") {
      return "If using reference images, describe their purpose in the prompt in the order they appear above.";
    }
    const tokens = toolSelectedReferences.length
      ? toolSelectedReferences.map((_, index) => modelTokenForIndex(index)).join(" and ")
      : "the uploaded reference images";
    return `${sheetTypePromptPrefix(sheetType)} based on ${tokens}. Your prompt is appended after this template.`;
  }, [referenceMode, sheetType, toolSelectedReferences]);

  function handleModelChange(nextModel: GenerateReferenceModel) {
    setGenerateModel(nextModel);
    if (referenceMode === "sheet") {
      setGenerateAspectRatio("16:9");
      return;
    }
    const nextOptions = MODEL_ASPECT_RATIO_OPTIONS[nextModel];
    const preferredValue = nearestAspectRatioValue(nextOptions, sceneAspectRatioValue);
    if (preferredValue) {
      setGenerateAspectRatio(preferredValue);
      return;
    }
    if (!nextOptions.some((option) => option.value === generateAspectRatio)) {
      setGenerateAspectRatio(nextOptions[0]?.value ?? "1:1");
    }
  }

  async function handleSceneAspectRatioChange(nextAspectRatio: string) {
    if (nextAspectRatio === sceneAspectRatioValue) return;
    setIsSavingSceneAspectRatio(true);
    setError(null);
    try {
      await onSceneAspectRatioChange(nextAspectRatio);
      if (referenceMode === "image") {
        const nextOptions = MODEL_ASPECT_RATIO_OPTIONS[generateModel];
        const preferredValue = nearestAspectRatioValue(nextOptions, nextAspectRatio);
        if (preferredValue) {
          setGenerateAspectRatio(preferredValue);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save scene aspect ratio");
    } finally {
      setIsSavingSceneAspectRatio(false);
    }
  }

  async function handleGenerate() {
    const trimmedPrompt = generatePrompt.trim();
    if (!trimmedPrompt) {
      setError("Write a prompt before creating a reference image or sheet.");
      return;
    }
    if (tooManyReferencesForModel) {
      setError(`${generateModel === "nano_banana" ? "Nano Banana" : "This model"} supports up to ${maxReferenceImages} reference images in this tool. Remove some references or choose another model.`);
      return;
    }
    setError(null);
    setIsGenerating(true);
    try {
      const prompt =
        referenceMode === "sheet"
          ? `${sheetTypePromptPrefix(sheetType)} based on ${
              toolSelectedReferences.length
                ? toolSelectedReferences.map((_, index) => modelTokenForIndex(index)).join(" and ")
                : "the supplied creative direction"
            }. ${trimmedPrompt}`
          : trimmedPrompt;
      await generateReferenceImage({
        model: generateModel,
        prompt,
        aspectRatio: referenceMode === "sheet" ? "16:9" : generateAspectRatio === "auto" ? null : generateAspectRatio,
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

  async function handleToggleReference(referenceId: string) {
    setTogglingIds((previous) => ({ ...previous, [referenceId]: true }));
    setError(null);
    try {
      await toggleReferenceSelection(referenceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update selected references");
    } finally {
      setTogglingIds((previous) => ({ ...previous, [referenceId]: false }));
    }
  }

  function renderReferenceGrid(items: ReferenceLibraryItem[], emptyState: string) {
    if (!items.length) {
      return <p className="text-sm text-ink/60">{emptyState}</p>;
    }

    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((reference) => {
          const displayError = summarizeImageGenerationError(
            reference.error,
            reference.model === "nano_banana" || reference.model === "nano_banana_pro" ? "Nano Banana" : "This model",
          );
          return (
          <article
            key={reference.referenceId}
            className={`space-y-2 rounded-lg border p-3 ${
              reference.status === "failed"
                ? "border-red-200 bg-red-50"
                : reference.status === "queued" || reference.status === "running"
                  ? "border-amber-200 bg-amber-50"
                  : reference.selected
                    ? "border-teal-500 bg-teal-50"
                    : "border-ink/10 bg-white"
            }`}
          >
            <button
              type="button"
              className="block w-full overflow-hidden rounded-lg border border-ink/10 bg-bg disabled:cursor-default"
              disabled={!reference.imageUrl || (reference.status != null && reference.status !== "complete") || Boolean(togglingIds[reference.referenceId])}
              onClick={() => void handleToggleReference(reference.referenceId)}
            >
              {reference.imageUrl ? (
                <img src={reference.imageUrl} alt={reference.title} className="aspect-video w-full object-contain" loading="lazy" decoding="async" />
              ) : reference.status === "queued" || reference.status === "running" ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 text-amber-800">
                  <Spinner className="h-5 w-5" />
                  <p className="text-xs font-medium uppercase tracking-wide">{reference.status}</p>
                  <p className="text-xs text-amber-900/80">Waiting for generated reference...</p>
                </div>
              ) : reference.status === "failed" ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 px-3 text-center text-red-700">
                  <p className="text-xs font-medium uppercase tracking-wide">Failed</p>
                  <p className="text-xs" title={reference.error?.trim() || undefined}>{displayError || "Reference image generation failed."}</p>
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center text-xs text-ink/55">Image unavailable</div>
              )}
            </button>
            <div className="space-y-1">
              <p className="truncate text-sm font-medium text-ink">{reference.title}</p>
              <p className="truncate text-xs text-ink/60">{reference.subtitle}</p>
              {reference.status === "failed" ? (
                <p className="text-xs text-red-700" title={reference.error?.trim() || undefined}>
                  {displayError || "Reference image generation failed. Delete this placeholder or try again."}
                </p>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!reference.imageUrl || (reference.status != null && reference.status !== "complete") || Boolean(togglingIds[reference.referenceId])}
                className={`rounded border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                  reference.selected ? "border-teal-500 bg-teal-50 text-teal-800" : "border-ink/20 bg-white text-ink/70"
                }`}
                onClick={() => void handleToggleReference(reference.referenceId)}
              >
                {reference.selected ? "Selected" : "Select"}
              </button>
              <div className="flex items-center gap-2">
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
                <IconActionButton title="Download" href={reference.imageUrl} download disabled={!reference.imageUrl}>
                  <DownloadIcon />
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
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="rounded-xl border border-ink/15 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-ink">Select scene aspect ratio</p>
            <p className="text-sm text-ink/70">
              Choose the aspect ratio for this scene. Later generated frames and video outputs will be conformed to this ratio.
            </p>
          </div>
          <select
            value={sceneAspectRatioValue}
            disabled={isSavingSceneAspectRatio}
            onChange={(event) => {
              void handleSceneAspectRatioChange(event.target.value);
            }}
            className="rounded-md border border-ink/20 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {SCENE_ASPECT_RATIO_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-xl border border-ink/15 bg-white p-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-ink">Upload reference images</p>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white" onClick={openSceneReferencePicker}>
              Choose from picker / library
            </button>
            <p className="max-w-2xl flex-1 text-sm text-ink/70">
              Select images to use as references for this scene - you can upload, select from your library or capture from video.
            </p>
          </div>
        </div>
        {warning ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{warning}</div> : null}
        <div className="mt-4">{renderReferenceGrid(uploadReferences, "No uploaded or library references yet.")}</div>
      </div>

      <div className="space-y-3 rounded-xl border border-ink/15 bg-white p-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-ink">Create reference images</p>
          <p className="text-sm text-ink/70">
            Create a scene reference image or a structured reference sheet using prompts and optional reference images.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-ink/20 bg-bg p-1">
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-sm ${referenceMode === "image" ? "bg-white font-medium text-ink shadow-sm" : "text-ink/65"}`}
              onClick={() => {
                setReferenceMode("image");
                const preferredValue = nearestAspectRatioValue(MODEL_ASPECT_RATIO_OPTIONS[generateModel], sceneAspectRatioValue);
                setGenerateAspectRatio(preferredValue ?? MODEL_ASPECT_RATIO_OPTIONS[generateModel][0]?.value ?? "1:1");
              }}
            >
              Image
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-sm ${referenceMode === "sheet" ? "bg-white font-medium text-ink shadow-sm" : "text-ink/65"}`}
              onClick={() => {
                setReferenceMode("sheet");
                setGenerateAspectRatio("16:9");
              }}
            >
              Sheet
            </button>
          </div>
          {referenceMode === "sheet" ? <p className="text-xs text-amber-700">Reference Sheet creation is experimental</p> : null}
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
          {referenceMode === "image" ? (
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
          ) : (
            <select
              value={sheetType}
              onChange={(event) => setSheetType(event.target.value as PrevizSheetType)}
              className="rounded-md border border-ink/20 px-3 py-2 text-sm"
            >
              {SHEET_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink"
            onClick={openToolReferencePicker}
          >
            Use reference images
          </button>
        </div>

        {toolSelectedReferences.length ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 bg-bg p-3">
            {toolSelectedReferences.map((reference, index) => (
              <div key={reference.referenceId} className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-2 py-2">
                {reference.imageUrl ? <img src={reference.imageUrl} alt={reference.title} className="h-10 w-10 rounded bg-white object-contain" /> : null}
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-ink">{modelTokenForIndex(index)}</p>
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
            placeholder={
              referenceMode === "sheet"
                ? "Describe what should be included in the reference sheet."
                : "Describe the reference image you want to create."
            }
          />
        </label>
        <p className="text-[11px] text-ink/60">{generatedPromptHelper}</p>
        <div>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isGenerating || tooManyReferencesForModel}
            onClick={() => void handleGenerate()}
          >
            <PendingButtonLabel isPending={isGenerating} idle={referenceMode === "sheet" ? "Create sheet" : "Create image"} pending="Creating..." />
          </button>
        </div>
      </div>

      {error ? (
        <StatusNotice variant="error">
          <p className="text-xs">{error}</p>
        </StatusNotice>
      ) : null}
      <div>{renderReferenceGrid(createdReferences, "No created reference images yet.")}</div>
    </div>
  );
}

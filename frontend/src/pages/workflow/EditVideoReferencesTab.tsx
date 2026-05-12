import { useRef, useState, type ChangeEvent } from "react";

import { PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import type { EditVideoReference } from "../../types/api";

export type EditVideoReferencesTabCtx = {
  references: EditVideoReference[];
  selectedReferenceIds: string[];
  toggleReferenceSelection: (referenceId: string) => void;
  removeReference: (referenceId: string) => Promise<void>;
  uploadReferenceImage: (file: File) => Promise<void>;
  generateReferenceImage: (payload: { model: "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro"; prompt: string }) => Promise<void>;
};

type Props = { ctx: EditVideoReferencesTabCtx };

export default function EditVideoReferencesTab({ ctx }: Props) {
  const { references, selectedReferenceIds, toggleReferenceSelection, removeReference, uploadReferenceImage, generateReferenceImage } = ctx;
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateModel, setGenerateModel] = useState<"chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro">("chatgpt_latest");
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});

  async function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setIsUploading(true);
    try {
      await uploadReferenceImage(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleGenerate() {
    const prompt = generatePrompt.trim();
    if (!prompt) {
      setError("Write a prompt before generating a reference image.");
      return;
    }
    setError(null);
    setIsGenerating(true);
    try {
      await generateReferenceImage({ model: generateModel, prompt });
      setGeneratePrompt("");
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
    <div className="space-y-4">
      <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleUploadChange(event)} />
      <StatusNotice variant="info">
        <p className="text-xs">Reference images are optional. Model allow different number of reference images: 3 Seedance / Happy Horse / Kling, 1 Wan2.7 / Runway Aleph.</p>
      </StatusNotice>

      <div className="rounded-xl border border-ink/15 bg-white p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isUploading}
            onClick={() => uploadInputRef.current?.click()}
          >
            <PendingButtonLabel isPending={isUploading} idle="Upload Reference Image" pending="Uploading..." />
          </button>
          <select
            value={generateModel}
            onChange={(event) => setGenerateModel(event.target.value as typeof generateModel)}
            className="rounded-md border border-ink/20 px-3 py-2 text-sm"
          >
            <option value="chatgpt_latest">ChatGPT Image Latest</option>
            <option value="chatgpt">ChatGPT Image</option>
            <option value="nano_banana_pro">Nano Banana Pro</option>
            <option value="nano_banana">Nano Banana</option>
          </select>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isGenerating}
            onClick={() => void handleGenerate()}
          >
            <PendingButtonLabel isPending={isGenerating} idle="Generate Reference" pending="Generating..." />
          </button>
        </div>
        <textarea
          value={generatePrompt}
          onChange={(event) => setGeneratePrompt(event.target.value)}
          className="h-20 w-full rounded-md border border-ink/20 p-2 text-sm"
          placeholder="Describe the reference image you want to generate."
        />
      </div>

      {error ? (
        <StatusNotice variant="error">
          <p className="text-xs">{error}</p>
        </StatusNotice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {references.map((reference) => {
          const selected = selectedReferenceIds.includes(reference.referenceId);
          return (
            <div key={reference.referenceId} className={`rounded-lg border p-2 ${selected ? "border-teal-500 bg-teal-50" : "border-ink/15 bg-white"}`}>
              {reference.imageUrl ? <img src={reference.imageUrl} alt={reference.filename || reference.referenceId} className="aspect-video w-full rounded-md bg-bg object-contain" /> : null}
              <div className="mt-2 flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-ink/80">
                  <input type="checkbox" checked={selected} onChange={() => toggleReferenceSelection(reference.referenceId)} />
                  Select
                </label>
                <button
                  type="button"
                  className="ml-auto rounded border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                  disabled={Boolean(deletingIds[reference.referenceId])}
                  onClick={() => void handleDelete(reference.referenceId)}
                >
                  {deletingIds[reference.referenceId] ? "Deleting..." : "Delete"}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-ink/60">{reference.type === "generated" ? `${reference.model ?? "generated"}` : "uploaded"}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

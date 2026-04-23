import { useMemo, useRef, useState, type ChangeEvent } from "react";

import { apiClient } from "../../api/client";
import type { FrameVariant } from "../../types/api";

type RefineVariantGroup = {
  editedVariant: FrameVariant;
  refinedVariants: FrameVariant[];
  isSelectedEdited: boolean;
  selectedRefinedVariantId: string | null;
};

export type RefineFramesTabCtx = {
  refineFrameTab: "first" | "last";
  setRefineFrameTab: (tab: "first" | "last") => void;
  activeRefineFrame:
    | {
        frameId: string;
        frameIndex: number;
        timecode: string;
        imageUrl?: string;
      }
    | null;
  refineGroups: RefineVariantGroup[];
  focusedEditedVariantId: string | null;
  selectedSourceVariantId: string | null;
  openRefineModalForVariant: (variant: FrameVariant) => void;
  selectRefineSourceVariant: (variantId: string) => void;
  setImagePreviewModal: (value: { url: string; label: string } | null) => void;
  formatCompactTimestamp: (iso: string | undefined) => string;
  selectedTaskId: string | null;
  refreshTask: () => Promise<void>;
  handleDeleteAsset: (item: {
    id: string;
    taskId: string;
    title: string;
    subtitle: string;
    createdAt: string;
    previewUrl: string;
    downloadUrl: string;
    mediaType: "image" | "video";
    deletePayload: { assetType: "frame_variant"; frameId: string; variantId: string };
  }) => Promise<void>;
};

type RefineFramesTabProps = {
  ctx: RefineFramesTabCtx;
};

function isManualRefineVariant(variant: FrameVariant): boolean {
  return variant.generationSettings?.workflow === "manual_refine_upload";
}

function PreviewIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m6 6 1 14h10l1-14" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function ManualBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
      Manual refine
    </span>
  );
}

export default function RefineFramesTab({ ctx }: RefineFramesTabProps) {
  const {
    refineFrameTab,
    setRefineFrameTab,
    activeRefineFrame,
    refineGroups,
    focusedEditedVariantId,
    selectedSourceVariantId,
    openRefineModalForVariant,
    selectRefineSourceVariant,
    setImagePreviewModal,
    formatCompactTimestamp,
    selectedTaskId,
    refreshTask,
    handleDeleteAsset,
  } = ctx;
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const focusedGroup = focusedEditedVariantId
    ? refineGroups.find((group) => group.editedVariant.variantId === focusedEditedVariantId) ?? null
    : null;
  const currentFrameRefinedOutputs = useMemo(
    () =>
      refineGroups.flatMap((group) =>
        group.refinedVariants.map((variant) => ({
          variant,
          sourceEditedVariant: group.editedVariant,
        })),
      ),
    [refineGroups],
  );
  const selectedRefinedOutput = currentFrameRefinedOutputs.find((item) => item.variant.variantId === selectedSourceVariantId) ?? null;
  const sourceEditedVariant = focusedGroup?.editedVariant ?? null;

  async function handleDeleteVariant(frameId: string, variant: FrameVariant, label: string) {
    if (!selectedTaskId || !variant.imageUrl) return;
    await handleDeleteAsset({
      id: `variant:${frameId}:${variant.variantId}`,
      taskId: selectedTaskId,
      title: label,
      subtitle: "",
      createdAt: variant.createdAt ?? new Date().toISOString(),
      previewUrl: variant.imageUrl,
      downloadUrl: variant.imageUrl,
      mediaType: "image",
      deletePayload: { assetType: "frame_variant", frameId, variantId: variant.variantId },
    });
  }

  async function handleExport(format: "psd" | "png_zip") {
    if (!selectedTaskId || !activeRefineFrame || !sourceEditedVariant) return;
    setIsExporting(true);
    try {
      const exported = await apiClient.exportManualRefinePsd(selectedTaskId, activeRefineFrame.frameId, {
        sourceVariantId: sourceEditedVariant.variantId,
        format,
      });
      const link = document.createElement("a");
      link.href = exported.downloadUrl;
      link.download = exported.filename;
      link.rel = "noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to export layer bundle");
    } finally {
      setIsExporting(false);
    }
  }

  async function handleManualUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedTaskId || !activeRefineFrame || !sourceEditedVariant) return;
    setIsUploading(true);
    try {
      const init = await apiClient.initManualRefineUpload(selectedTaskId, activeRefineFrame.frameId, {
        sourceVariantId: sourceEditedVariant.variantId,
        filename: file.name,
        contentType: file.type || "image/png",
      });
      const uploadResponse = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
        },
        body: file,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.status}`);
      }
      const completed = await apiClient.completeManualRefineUpload(selectedTaskId, activeRefineFrame.frameId, {
        sourceVariantId: sourceEditedVariant.variantId,
        uploadKey: init.uploadKey,
        filename: file.name,
      });
      selectRefineSourceVariant(completed.variant.variantId);
      await refreshTask();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to upload manual refine");
    } finally {
      setIsUploading(false);
    }
  }

  function renderVariantActions(frameId: string, variant: FrameVariant, label: string) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="rounded border border-ink/20 bg-white p-2 text-xs"
          title="Preview"
          onClick={() => variant.imageUrl && setImagePreviewModal({ url: variant.imageUrl, label })}
        >
          <PreviewIcon />
        </button>
        <a href={variant.imageUrl} target="_blank" rel="noreferrer" download className="rounded border border-ink/20 bg-white p-2 text-xs" title="Download full quality image">
          <DownloadIcon />
        </a>
        <button
          type="button"
          className="rounded border border-red-200 bg-white p-2 text-xs text-red-700"
          title={`Delete ${label.toLowerCase()}`}
          onClick={() => void handleDeleteVariant(frameId, variant, label)}
        >
          <DeleteIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleManualUpload(event)} />
      <h3 className="text-lg font-semibold">Refine Frames</h3>

      <div className="flex gap-2">
        <button
          onClick={() => setRefineFrameTab("first")}
          className={`rounded-md px-3 py-2 text-sm ${refineFrameTab === "first" ? "bg-ink text-white" : "bg-ink/10"}`}
        >
          Start Frame
        </button>
        <button
          onClick={() => setRefineFrameTab("last")}
          className={`rounded-md px-3 py-2 text-sm ${refineFrameTab === "last" ? "bg-ink text-white" : "bg-ink/10"}`}
        >
          End Frame (Optional)
        </button>
      </div>

      {!activeRefineFrame ? (
        <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
          Select frames in Select Frames first, then return here to review and refine them.
        </div>
      ) : null}

      {activeRefineFrame && refineGroups.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
          Create edited frame variants in Edit frames first. Refine Frames only works on generated stills.
        </div>
      ) : null}

      {activeRefineFrame && refineGroups.length > 0 && !focusedGroup ? (
        <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
          Select an edited variant in Edit frames first, then return here to refine it.
        </div>
      ) : null}

      {activeRefineFrame && focusedGroup && sourceEditedVariant ? (
        <section className="rounded-lg border border-ink/10 bg-white p-3">
          <div className="mb-3">
            <p className="text-sm font-medium text-ink/85">Selected Edited Variant</p>
            <p className="text-xs text-ink/60">Build the keep mask from the edited frame. The original frame is only used as the restoration source outside that mask.</p>
          </div>
          <div className="rounded-lg border border-ink/10 bg-bg/20 p-3">
            <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div className="space-y-2">
                <img
                  src={sourceEditedVariant.imageUrl}
                  alt={`${sourceEditedVariant.model} edited output`}
                  className="w-full rounded border border-teal-500 bg-teal-50 object-contain"
                />
                <div className="space-y-1 text-xs text-ink/65">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-ink/85">{sourceEditedVariant.model} / {sourceEditedVariant.type}</p>
                    {isManualRefineVariant(sourceEditedVariant) ? <ManualBadge /> : null}
                  </div>
                  <p>{formatCompactTimestamp(sourceEditedVariant.createdAt)}</p>
                  {selectedRefinedOutput ? (
                    <p className="text-[11px] text-ink/60">
                      Current generation source is a refined output. New QA refinements still start from this edited source.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-ink/20 bg-white px-3 py-1.5 text-xs"
                    onClick={() => openRefineModalForVariant(sourceEditedVariant)}
                  >
                    Refine
                  </button>
                  <button
                    type="button"
                    className="rounded border border-ink/20 bg-white px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleExport("psd")}
                    disabled={isExporting || !sourceEditedVariant}
                  >
                    {isExporting ? "Exporting PSD..." : "Export PSD"}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-ink/20 bg-white px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleExport("png_zip")}
                    disabled={isExporting || !sourceEditedVariant}
                  >
                    {isExporting ? "Exporting..." : "Export PNG Layers"}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-ink/20 bg-white px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => uploadInputRef.current?.click()}
                    disabled={isUploading || !sourceEditedVariant}
                    title="Upload flattened image at same resolution/dimensions"
                  >
                    {isUploading ? "Uploading..." : "Upload Manual Refine"}
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium text-ink/85">Refined Outputs</p>
                  <p className="text-xs text-ink/60">Saved QA and manual refinements derived from this edited variant.</p>
                </div>

                {focusedGroup.refinedVariants.length === 0 ? (
                  <div className="rounded border border-dashed border-ink/20 bg-white p-4 text-sm text-ink/60">
                    No refined versions yet. Use <span className="font-medium text-ink/80">Refine</span> or upload a manual refine.
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {focusedGroup.refinedVariants.map((variant) => {
                      const isSelected = focusedGroup.selectedRefinedVariantId === variant.variantId;
                      return (
                        <div
                          key={variant.variantId}
                          className={`rounded border p-2 ${isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white"}`}
                        >
                          <button type="button" className="block w-full text-left" onClick={() => selectRefineSourceVariant(variant.variantId)}>
                            <img src={variant.imageUrl} alt="Refined output" className="mb-2 w-full rounded border border-ink/10 object-contain" />
                          </button>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-xs font-medium text-ink/85">Refined output</p>
                            {isManualRefineVariant(variant) ? <ManualBadge /> : null}
                          </div>
                          <p className="text-[11px] text-ink/60">{formatCompactTimestamp(variant.createdAt)}</p>
                          {renderVariantActions(activeRefineFrame.frameId, variant, "Refined frame")}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {activeRefineFrame && currentFrameRefinedOutputs.length > 0 ? (
        <section className="rounded-lg border border-ink/10 bg-white p-3">
          <div className="mb-3">
            <p className="text-sm font-medium text-ink/85">Previous Refined Outputs For This Frame</p>
            <p className="text-xs text-ink/60">Saved refined outputs for this frame. Click a thumbnail to make it the current source for video generation.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {currentFrameRefinedOutputs.map(({ variant, sourceEditedVariant }) => {
              const isSelected = selectedSourceVariantId === variant.variantId;
              return (
                <div
                  key={variant.variantId}
                  className={`rounded border p-2 ${isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white"}`}
                >
                  <button type="button" className="block w-full text-left" onClick={() => selectRefineSourceVariant(variant.variantId)}>
                    <img src={variant.imageUrl} alt="Refined output" className="mb-2 w-full rounded border border-ink/10 object-contain" />
                  </button>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-ink/85">Refined output</p>
                    {isManualRefineVariant(variant) ? <ManualBadge /> : null}
                  </div>
                  <p className="text-[11px] text-ink/60">{formatCompactTimestamp(variant.createdAt)}</p>
                  <p className="mt-1 text-[11px] text-ink/60">From {sourceEditedVariant.model} / {sourceEditedVariant.type}</p>
                  {renderVariantActions(activeRefineFrame.frameId, variant, "Refined frame")}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

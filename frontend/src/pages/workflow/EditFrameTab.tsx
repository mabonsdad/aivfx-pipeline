import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type RefObject } from "react";

import { apiClient } from "../../api/client";

import { CompareIcon, DeleteIcon, DownloadIcon, EditIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import type { FrameVariant } from "../../types/api";

type EditFrameCandidate = {
  id: string;
  kind: "original" | "variant";
  imageUrl: string;
  label: string;
  createdAt?: string;
  variantId?: string;
  variant?: FrameVariant;
  qualityMatched?: boolean;
  isSelected: boolean;
};

type PatchReferenceImage = {
  file: File;
  previewUrl: string;
};

export type EditFrameTabCtx = {
  setEditFrameTab: (tab: "first" | "last") => void;
  allowEndFrameTab: boolean;
  openRefineModalForVariant: (variantId: string) => void;
  onNext: () => void;
  nextWarning: string | null;
  editFrameTab: "first" | "last";
  activeEditFrame:
    | {
        frameId: string;
        frameIndex: number;
        timecode: string;
        imageUrl?: string;
      }
    | null;
  prompt: string;
  setPrompt: (value: string) => void;
  model: "nano_banana" | "nano_banana_pro" | "chatgpt" | "chatgpt_latest";
  setModel: (value: "nano_banana" | "nano_banana_pro" | "chatgpt" | "chatgpt_latest") => void;
  fullEditMutation: { isPending: boolean; mutate: (frameId: string) => void };
  activeEditSourceImageUrl: string | null;
  activeEditCandidates: EditFrameCandidate[];
  selectCompareCandidate: (frameId: string, tabKey: "first" | "last", candidate: EditFrameCandidate) => void;
  setImagePreviewModal: (value: { url: string; label: string } | null) => void;
  setImageCompareModal: (value: { originalUrl: string; compareUrl: string; label: string } | null) => void;
  setEditSourceCandidate: (tabKey: "first" | "last", candidate: EditFrameCandidate) => void;
  selectedTaskId: string | null;
  uploadManualEditedFrame: (tabKey: "first" | "last", file: File) => Promise<string>;
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
  activeFrameDimensions: { width: number; height: number } | null;
  patchOverlayCanvasRef: RefObject<HTMLCanvasElement>;
  onPatchMaskPointerDown: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPatchMaskPointerMove: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPatchMaskPointerUp: (event: PointerEvent<HTMLCanvasElement>) => void;
  patchEngine: "nano_banana_pro" | "chatgpt" | "chatgpt_latest" | "runware_flux_fill" | "runware_ace_pp";
  setPatchEngine: (value: "nano_banana_pro" | "chatgpt" | "chatgpt_latest" | "runware_flux_fill" | "runware_ace_pp") => void;
  patchToolMode: "brush_add" | "brush_erase" | "lasso_add" | "lasso_erase";
  setPatchToolMode: (value: "brush_add" | "brush_erase" | "lasso_add" | "lasso_erase") => void;
  patchBrushSize: number;
  setPatchBrushSize: (value: number) => void;
  featherPx: number;
  setFeatherPx: (value: number) => void;
  clearPatchMask: () => void;
  edgeAwareRefine: boolean;
  setEdgeAwareRefine: (value: boolean) => void;
  edgeAwareStrength: number;
  setEdgeAwareStrength: (value: number) => void;
  edgeAwareRadiusPx: number;
  setEdgeAwareRadiusPx: (value: number) => void;
  maskGrowPx: number;
  setMaskGrowPx: (value: number) => void;
  activePatchReference: PatchReferenceImage | null;
  setPatchReferenceForTab: (tabKey: "first" | "last", file: File) => void;
  clearPatchReferenceForTab: (tabKey: "first" | "last") => void;
  runwareRepaintingScale: number;
  setRunwareRepaintingScale: (value: number) => void;
  patchPrompt: string;
  setPatchPrompt: (value: string) => void;
  patchEditMutation: { isPending: boolean; mutate: (frameId: string) => void; error?: { message?: string } | null };
  maskHasPaint: boolean;
  refreshPatchOverlay: () => void;
  formatCompactTimestamp: (iso: string | undefined) => string;
};

type EditFrameTabProps = {
  ctx: EditFrameTabCtx;
};

function QaTickIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m3 8 3 3 7-7" />
    </svg>
  );
}

export default function EditFrameTab({ ctx }: EditFrameTabProps) {
  const {
    setEditFrameTab,
    allowEndFrameTab,
    openRefineModalForVariant,
    onNext,
    nextWarning,
    editFrameTab,
    activeEditFrame,
    prompt,
    setPrompt,
    model,
    setModel,
    fullEditMutation,
    activeEditSourceImageUrl,
    activeEditCandidates,
    selectCompareCandidate,
    setImagePreviewModal,
    setImageCompareModal,
    setEditSourceCandidate,
    selectedTaskId,
    uploadManualEditedFrame,
    handleDeleteAsset,
    activeFrameDimensions,
    patchOverlayCanvasRef,
    onPatchMaskPointerDown,
    onPatchMaskPointerMove,
    onPatchMaskPointerUp,
    patchEngine,
    setPatchEngine,
    patchToolMode,
    setPatchToolMode,
    patchBrushSize,
    setPatchBrushSize,
    featherPx,
    setFeatherPx,
    clearPatchMask,
    edgeAwareRefine,
    setEdgeAwareRefine,
    edgeAwareStrength,
    setEdgeAwareStrength,
    edgeAwareRadiusPx,
    setEdgeAwareRadiusPx,
    maskGrowPx,
    setMaskGrowPx,
    activePatchReference,
    setPatchReferenceForTab,
    clearPatchReferenceForTab,
    runwareRepaintingScale,
    setRunwareRepaintingScale,
    patchPrompt,
    setPatchPrompt,
    patchEditMutation,
    maskHasPaint,
    refreshPatchOverlay,
    formatCompactTimestamp,
  } = ctx;
  const [isPatchModalOpen, setPatchModalOpen] = useState(false);
  const [patchQueuedNotice, setPatchQueuedNotice] = useState(false);
  const [downloadCandidate, setDownloadCandidate] = useState<EditFrameCandidate | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<"psd" | "png_zip" | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [manualUploadPending, setManualUploadPending] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const canDownloadSourceFrame = Boolean(activeEditFrame?.imageUrl);
  const activeTabLabel = editFrameTab === "first" ? "Start Frame" : "End Frame";

  useEffect(() => {
    if (!isPatchModalOpen) return;
    const refreshTimer = window.setTimeout(() => {
      refreshPatchOverlay();
    }, 0);
    return () => window.clearTimeout(refreshTimer);
  }, [isPatchModalOpen, refreshPatchOverlay]);

  useEffect(() => {
    if (!patchEditMutation.isPending) {
      setPatchQueuedNotice(false);
    }
  }, [patchEditMutation.isPending]);

  const downloadMenuSupportsLayers = Boolean(downloadCandidate?.variantId && selectedTaskId && activeEditFrame?.frameId);
  const refineableVariantIds = useMemo(
    () =>
      new Set(
        activeEditCandidates
          .filter((candidate) => candidate.kind === "variant" && candidate.variantId && candidate.variant?.variantKind !== "refined")
          .map((candidate) => candidate.variantId as string),
      ),
    [activeEditCandidates],
  );

  function triggerDirectDownload(url: string, filename?: string) {
    const link = document.createElement("a");
    link.href = url;
    if (filename) link.download = filename;
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function openInNewTab(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function handleLayerExport(format: "psd" | "png_zip") {
    if (!downloadCandidate?.variantId || !selectedTaskId || !activeEditFrame?.frameId) return;
    setDownloadBusy(format);
    setDownloadError(null);
    try {
      const exported = await apiClient.exportManualRefinePsd(selectedTaskId, activeEditFrame.frameId, {
        sourceVariantId: downloadCandidate.variantId,
        format,
      });
      triggerDirectDownload(exported.downloadUrl, exported.filename);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Failed to prepare download");
    } finally {
      setDownloadBusy(null);
    }
  }

  async function handleManualEditedFrameUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setManualUploadPending(true);
    try {
      await uploadManualEditedFrame(editFrameTab, file);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Failed to upload edited frame");
    } finally {
      setManualUploadPending(false);
    }
  }

  return (
              <div className="space-y-4">
                <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleManualEditedFrameUpload(event)} />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex gap-2">
                  <button
                    onClick={() => setEditFrameTab("first")}
                    className={`rounded-md px-3 py-2 text-sm ${editFrameTab === "first" ? "bg-ink text-white" : "bg-ink/10"}`}
                  >
                    Start Frame
                  </button>
                  {allowEndFrameTab ? (
                    <button
                      onClick={() => setEditFrameTab("last")}
                      className={`rounded-md px-3 py-2 text-sm ${editFrameTab === "last" ? "bg-ink text-white" : "bg-ink/10"}`}
                    >
                      End Frame
                    </button>
                  ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canDownloadSourceFrame}
                      onClick={() => {
                        if (!activeEditFrame?.imageUrl) return;
                        openInNewTab(activeEditFrame.imageUrl);
                      }}
                    >
                      Download Source Frame
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!activeEditFrame || manualUploadPending}
                      onClick={() => uploadInputRef.current?.click()}
                    >
                      <PendingButtonLabel isPending={manualUploadPending} idle="Upload Edited Frame" pending="Uploading frame..." />
                    </button>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-ink/10 bg-white p-3">
                  <p className="text-sm text-ink/70">
                    {editFrameTab === "first" ? "Start frame" : "End frame"}
                    {activeEditFrame ? ` · frame ${activeEditFrame.frameIndex} · ${activeEditFrame.timecode}` : ""}
                  </p>

                  {!activeEditFrame ? (
                    <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
                      Choose a working range in Source first, then return here to edit.
                    </div>
                  ) : null}
                  <div className="space-y-3">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Describe the edit"
                      className="h-24 w-full rounded-md border border-ink/20 p-2"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value as "nano_banana" | "nano_banana_pro" | "chatgpt" | "chatgpt_latest")}
                        className="rounded-md border border-ink/20 px-2 py-2"
                      >
                        <option value="nano_banana_pro">Nano Banana Pro</option>
                        <option value="nano_banana">Nano Banana Std</option>
                        <option value="chatgpt">ChatGPT-image 1.5</option>
                        <option value="chatgpt_latest">ChatGPT-image 2.0</option>
                      </select>
                      <button
                        type="button"
                        className="rounded-md border border-ink/20 bg-white px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!activeEditFrame}
                        onClick={() => {
                          setPatchPrompt(prompt);
                          setPatchModalOpen(true);
                        }}
                      >
                        Add Mask
                      </button>
                      <button
                        className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!activeEditFrame || fullEditMutation.isPending || !prompt.trim()}
                        onClick={() => activeEditFrame && fullEditMutation.mutate(activeEditFrame.frameId)}
                      >
                        <PendingButtonLabel isPending={fullEditMutation.isPending} idle="Edit" pending="Queueing edit..." />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Frame variants</p>
                  {patchQueuedNotice ? (
                    <StatusNotice variant="loading">
                      <p className="text-xs">Patch edit queued. Track progress in Jobs while the new frame variant is generated.</p>
                    </StatusNotice>
                  ) : null}
                  {!activeEditFrame ? (
                    <p className="text-xs text-ink/60">Choose a frame in Source first.</p>
                  ) : null}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {activeEditCandidates.map((candidate) => (
                      <div
                        key={candidate.id}
                        className={`rounded border p-2 ${
                          candidate.isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10"
                        }`}
                      >
                        <button
                          type="button"
                          className="block w-full"
                          onClick={() => {
                            if (!activeEditFrame) return;
                            selectCompareCandidate(activeEditFrame.frameId, editFrameTab, candidate);
                          }}
                          title="Select for comparison and generation"
                        >
                          <img src={candidate.imageUrl} className="mb-2 w-full rounded bg-bg object-contain" loading="lazy" decoding="async" />
                        </button>
                        <p className="text-xs font-medium text-ink/80">{candidate.label}</p>
                        <p className="text-[11px] text-ink/60">{formatCompactTimestamp(candidate.createdAt)}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <IconActionButton title="Preview" onClick={() => setImagePreviewModal({ url: candidate.imageUrl, label: candidate.label })}>
                            <PreviewIcon />
                          </IconActionButton>
                          <IconActionButton
                            title={candidate.kind === "original" || !activeEditFrame?.imageUrl ? "Compare is only available for edited variants" : "Compare against original"}
                            disabled={candidate.kind === "original" || !activeEditFrame?.imageUrl}
                            onClick={() => {
                              if (candidate.kind === "original" || !activeEditFrame?.imageUrl) return;
                              setImageCompareModal({
                                originalUrl: activeEditFrame.imageUrl,
                                compareUrl: candidate.imageUrl,
                                label: candidate.label,
                              });
                            }}
                          >
                            <CompareIcon />
                          </IconActionButton>
                          <IconActionButton
                            title="Use for editing"
                            onClick={() => {
                              setEditSourceCandidate(editFrameTab, candidate);
                            }}
                          >
                            <EditIcon />
                          </IconActionButton>
                          <IconActionButton
                            title="Download options"
                            onClick={() => {
                              setDownloadError(null);
                              setDownloadBusy(null);
                              setDownloadCandidate(candidate);
                            }}
                          >
                            <DownloadIcon />
                          </IconActionButton>
                          {candidate.kind === "variant" ? (
                            candidate.variant?.variantKind === "refined" ? (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded border border-teal-300 bg-teal-50 px-2 py-2 text-[11px] font-medium text-teal-700"
                                disabled
                              >
                                <QaTickIcon />
                                <span>QA</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="rounded border border-ink/20 bg-white px-2 py-2 text-[11px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={!candidate.variantId || !refineableVariantIds.has(candidate.variantId)}
                                title={candidate.variantId ? "Open QA refine tools for this edited frame" : "Only generated variants can be refined"}
                                onClick={() => {
                                  if (!candidate.variantId) return;
                                  openRefineModalForVariant(candidate.variantId);
                                }}
                              >
                                QA
                              </button>
                            )
                          ) : null}
                          <IconActionButton
                            title={candidate.kind === "original" ? "Original frame cannot be deleted" : "Delete variant"}
                            tone="danger"
                            disabled={candidate.kind === "original" || !activeEditFrame || !candidate.variantId}
                            onClick={() => {
                              if (!activeEditFrame || !candidate.variantId) return;
                              handleDeleteAsset({
                                id: `variant:${activeEditFrame.frameId}:${candidate.variantId}`,
                                taskId: selectedTaskId ?? "",
                                title: candidate.label,
                                subtitle: "",
                                createdAt: candidate.createdAt ?? new Date().toISOString(),
                                previewUrl: candidate.imageUrl,
                                downloadUrl: candidate.imageUrl,
                                mediaType: "image",
                                deletePayload: { assetType: "frame_variant", frameId: activeEditFrame.frameId, variantId: candidate.variantId },
                              });
                            }}
                          >
                            <DeleteIcon />
                          </IconActionButton>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {nextWarning ? (
                  <StatusNotice variant="warning">
                    <p className="text-xs">{nextWarning}</p>
                  </StatusNotice>
                ) : null}
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={Boolean(nextWarning)}
                    onClick={onNext}
                  >
                    Next
                  </button>
                </div>

                {downloadCandidate ? (
                  <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={() => setDownloadCandidate(null)}>
                    <div className="w-full max-w-md rounded-2xl border border-ink/15 bg-card p-4" onClick={(event) => event.stopPropagation()}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="text-base font-semibold text-ink">Download Options</h4>
                          <p className="text-sm text-ink/65">{downloadCandidate.label}</p>
                        </div>
                        <button type="button" className="rounded border border-ink/20 bg-white px-3 py-1 text-sm" onClick={() => setDownloadCandidate(null)}>
                          Close
                        </button>
                      </div>
                      <div className="mt-4 space-y-2">
                        {downloadError ? (
                          <StatusNotice variant="error">
                            <p className="text-sm">{downloadError}</p>
                          </StatusNotice>
                        ) : null}
                        {downloadBusy ? (
                          <StatusNotice variant="loading">
                            <p className="text-sm">
                              {downloadBusy === "psd" ? "Preparing PSD with QA layers." : "Preparing PNG QA layer bundle."} This can take a moment before the download starts.
                            </p>
                          </StatusNotice>
                        ) : null}
                        <button
                          type="button"
                          className="w-full rounded-md border border-ink/20 bg-white px-4 py-2 text-left text-sm font-medium text-ink"
                          onClick={() => triggerDirectDownload(downloadCandidate.imageUrl, `${downloadCandidate.label.toLowerCase().replace(/\s+/g, "_")}.png`)}
                        >
                          PNG
                        </button>
                        <button
                          type="button"
                          className="w-full rounded-md border border-ink/20 bg-white px-4 py-2 text-left text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!downloadMenuSupportsLayers || Boolean(downloadBusy)}
                          onClick={() => {
                            void handleLayerExport("psd");
                          }}
                        >
                          <PendingButtonLabel isPending={downloadBusy === "psd"} idle="PSD (with QA layers)" pending="Preparing PSD..." />
                        </button>
                        <button
                          type="button"
                          className="w-full rounded-md border border-ink/20 bg-white px-4 py-2 text-left text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!downloadMenuSupportsLayers || Boolean(downloadBusy)}
                          onClick={() => {
                            void handleLayerExport("png_zip");
                          }}
                        >
                          <PendingButtonLabel isPending={downloadBusy === "png_zip"} idle="PNG (with QA layers)" pending="Preparing layers..." />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

              {isPatchModalOpen ? (
                <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/60 p-4">
                  <div className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-ink/15 bg-card p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <h4 className="text-lg font-semibold">Patch Editor</h4>
                        <p className="text-sm text-ink/70">
                          {editFrameTab === "first" ? "Start Frame" : "End Frame"} mask editing
                          {activeEditFrame ? ` · frame ${activeEditFrame.frameIndex}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="rounded border border-ink/20 bg-white px-3 py-1 text-sm"
                        onClick={() => setPatchModalOpen(false)}
                      >
                        Close
                      </button>
                    </div>

                    <div className="space-y-3">
                      {activeEditFrame?.imageUrl && activeFrameDimensions ? (
                        <div className="space-y-2">
                          <p className="text-xs text-ink/70">
                            Paint or lasso the exact area to change. Add mode paints edit regions, erase mode removes them.
                            Keep masks tight to the target, then use feather and edge refine to avoid seams.
                          </p>
                          <div className="relative inline-block max-w-full overflow-hidden rounded-md border border-ink/20 bg-bg">
                            <img
                              src={activeEditSourceImageUrl ?? activeEditFrame.imageUrl}
                              alt="Patch mask base frame"
                              className="block max-h-[420px] max-w-full select-none"
                              draggable={false}
                            />
                            <canvas
                              ref={patchOverlayCanvasRef}
                              width={activeFrameDimensions.width}
                              height={activeFrameDimensions.height}
                              className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                              onPointerDown={onPatchMaskPointerDown}
                              onPointerMove={onPatchMaskPointerMove}
                              onPointerUp={onPatchMaskPointerUp}
                              onPointerLeave={onPatchMaskPointerUp}
                              onPointerCancel={onPatchMaskPointerUp}
                            />
                          </div>
                          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                            <label className="text-xs text-ink/70">
                              Patch engine
                              <select
                                value={patchEngine}
                                onChange={(e) => setPatchEngine(e.target.value as EditFrameTabCtx["patchEngine"])}
                                className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                              >
                                <option value="nano_banana_pro">Google Nano Banana Pro</option>
                                <option value="chatgpt">OpenAI ChatGPT-image 1.5</option>
                                <option value="chatgpt_latest">OpenAI ChatGPT-image 2.0</option>
                                <option value="runware_flux_fill">Runware FLUX Fill</option>
                                <option value="runware_ace_pp">Runware ACE++ + FLUX Fill</option>
                              </select>
                            </label>
                            <label className="text-xs text-ink/70">
                              Tool
                              <select
                                value={patchToolMode}
                                onChange={(e) => setPatchToolMode(e.target.value as EditFrameTabCtx["patchToolMode"])}
                                className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                              >
                                <option value="brush_add">Brush (add)</option>
                                <option value="brush_erase">Brush (erase)</option>
                                <option value="lasso_add">Lasso (add)</option>
                                <option value="lasso_erase">Lasso (erase)</option>
                              </select>
                            </label>
                            <label className="text-xs text-ink/70">
                              Brush size
                              <select
                                value={patchBrushSize}
                                onChange={(e) => setPatchBrushSize(Number(e.target.value))}
                                className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                              >
                                {[8, 12, 16, 24, 32, 48, 64].map((size) => (
                                  <option key={size} value={size}>
                                    {size}px
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="text-xs text-ink/70">
                              Feather edge
                              <select
                                value={featherPx}
                                onChange={(e) => setFeatherPx(Number(e.target.value))}
                                className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                              >
                                {[0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160, 200].map((value) => (
                                  <option key={value} value={value}>
                                    {value}px
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="flex items-end lg:col-span-4">
                              <button
                                type="button"
                                className="w-full rounded border border-ink/20 bg-white px-3 py-2 text-sm"
                                onClick={clearPatchMask}
                              >
                                Clear mask
                              </button>
                            </div>
                          </div>
                          <div className="rounded border border-ink/10 bg-white p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <label className="flex items-center gap-2 text-xs text-ink/70">
                                <input
                                  type="checkbox"
                                  checked={edgeAwareRefine}
                                  onChange={(event) => setEdgeAwareRefine(event.target.checked)}
                                />
                                Edge-aware matte refinement
                              </label>
                              <p className="text-[11px] text-ink/60">Helps reduce halos on detailed edges like hair, fabric and props.</p>
                            </div>
                            <p className="mt-1 text-[11px] text-ink/60">
                              Applies only when you click <strong>Edit</strong> in this patch modal (masked patch generation). It does not affect the normal Edit mode above.
                            </p>
                            {edgeAwareRefine ? (
                              <div className="mt-2 grid gap-2 md:grid-cols-3">
                                <label className="text-xs text-ink/70">
                                  Refine strength
                                  <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={edgeAwareStrength}
                                    onChange={(event) => setEdgeAwareStrength(Number(event.target.value))}
                                    className="mt-1 block w-full"
                                  />
                                  <span className="mt-1 block text-[11px] text-ink/60">{edgeAwareStrength.toFixed(2)}</span>
                                </label>
                                <label className="text-xs text-ink/70">
                                  Edge radius
                                  <select
                                    value={edgeAwareRadiusPx}
                                    onChange={(event) => setEdgeAwareRadiusPx(Number(event.target.value))}
                                    className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                                  >
                                    {[0, 2, 4, 6, 8, 10, 12, 16, 20, 24].map((value) => (
                                      <option key={value} value={value}>
                                        {value}px
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="text-xs text-ink/70">
                                  Mask grow/shrink
                                  <select
                                    value={maskGrowPx}
                                    onChange={(event) => setMaskGrowPx(Number(event.target.value))}
                                    className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                                  >
                                    {[-24, -16, -12, -8, -4, 0, 4, 8, 12, 16, 24].map((value) => (
                                      <option key={value} value={value}>
                                        {value > 0 ? `+${value}px` : `${value}px`}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                            ) : null}
                          </div>
                          {patchEngine === "runware_ace_pp" ? (
                            <div className="space-y-2 rounded border border-ink/10 bg-white p-2">
                              <p className="text-xs text-ink/70">
                                ACE++ local editing needs one reference image plus your painted mask.
                              </p>
                              <input
                                type="file"
                                accept="image/*"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (!file) return;
                                  setPatchReferenceForTab(editFrameTab, file);
                                }}
                                className="text-xs"
                              />
                              {activePatchReference?.previewUrl ? (
                                <div className="flex items-start gap-2">
                                  <img
                                    src={activePatchReference.previewUrl}
                                    alt="Runware ACE++ reference"
                                    className="max-h-20 rounded border border-ink/10 bg-bg object-contain"
                                  />
                                  <div className="space-y-1">
                                    <p className="text-xs text-ink/60">{activePatchReference.file.name}</p>
                                    <button
                                      type="button"
                                      className="rounded border border-ink/20 px-2 py-1 text-xs"
                                      onClick={() => clearPatchReferenceForTab(editFrameTab)}
                                    >
                                      Remove reference
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-xs text-ink/60">No ACE++ reference image selected.</p>
                              )}
                              <label className="text-xs text-ink/70">
                                Repainting scale
                                <input
                                  type="range"
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={runwareRepaintingScale}
                                  onChange={(e) => setRunwareRepaintingScale(Number(e.target.value))}
                                  className="mt-1 block w-full"
                                />
                                <span className="mt-1 block text-[11px] text-ink/60">{runwareRepaintingScale.toFixed(2)}</span>
                              </label>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-sm text-ink/60">Select a frame above to enable mask painting.</p>
                      )}
                      <textarea
                        value={patchPrompt}
                        onChange={(e) => setPatchPrompt(e.target.value)}
                        placeholder="Describe the masked edit"
                        className="h-20 w-full rounded-md border border-ink/20 p-2"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className="rounded-md bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={
                            !activeEditFrame ||
                            patchEditMutation.isPending ||
                            !patchPrompt.trim() ||
                            !maskHasPaint ||
                            (patchEngine === "runware_ace_pp" && !activePatchReference?.file)
                          }
                          onClick={() => {
                            if (!activeEditFrame) return;
                            setPatchQueuedNotice(true);
                            patchEditMutation.mutate(activeEditFrame.frameId);
                            setPatchModalOpen(false);
                          }}
                        >
                          <PendingButtonLabel isPending={patchEditMutation.isPending} idle="Edit" pending="Queueing patch edit..." />
                        </button>
                        <button
                          type="button"
                          className="rounded border border-ink/20 bg-white px-4 py-2 text-sm"
                          onClick={() => setPatchModalOpen(false)}
                        >
                          Cancel
                        </button>
                      </div>
                      {!maskHasPaint ? <p className="text-xs text-ink/60">Draw a mask before generating a patch variant.</p> : null}
                      {patchEngine === "runware_ace_pp" && !activePatchReference?.file ? (
                        <p className="text-xs text-ink/60">Select one reference image to use ACE++ local editing.</p>
                      ) : null}
                      {patchEditMutation.error ? (
                        <StatusNotice variant="error">
                          <p className="text-xs">{patchEditMutation.error.message}</p>
                        </StatusNotice>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
  );
}

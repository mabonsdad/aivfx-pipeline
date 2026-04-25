import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { useEffect, useState, type PointerEvent, type RefObject } from "react";

import type { TaskDetail } from "../../types/api";

type EditFrameCandidate = {
  id: string;
  kind: "original" | "variant";
  imageUrl: string;
  label: string;
  createdAt?: string;
  variantId?: string;
  qualityMatched?: boolean;
  isSelected: boolean;
};

type PatchReferenceImage = {
  file: File;
  previewUrl: string;
};

export type EditFrameTabCtx = {
  setEditFrameTab: (tab: "first" | "last") => void;
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
  task: TaskDetail | undefined;
  activeEditSourceImageUrl: string | null;
  activeCompareImageUrl: string | null;
  activeEditCandidates: EditFrameCandidate[];
  selectCompareCandidate: (frameId: string, tabKey: "first" | "last", candidate: EditFrameCandidate) => void;
  setImagePreviewModal: (value: { url: string; label: string } | null) => void;
  setEditSourceCandidate: (tabKey: "first" | "last", candidate: EditFrameCandidate) => void;
  selectedTaskId: string | null;
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

export default function EditFrameTab({ ctx }: EditFrameTabProps) {
  const {
    setEditFrameTab,
    editFrameTab,
    activeEditFrame,
    prompt,
    setPrompt,
    model,
    setModel,
    fullEditMutation,
    task,
    activeEditSourceImageUrl,
    activeCompareImageUrl,
    activeEditCandidates,
    selectCompareCandidate,
    setImagePreviewModal,
    setEditSourceCandidate,
    selectedTaskId,
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

  useEffect(() => {
    if (!isPatchModalOpen) return;
    const refreshTimer = window.setTimeout(() => {
      refreshPatchOverlay();
    }, 0);
    return () => window.clearTimeout(refreshTimer);
  }, [isPatchModalOpen, refreshPatchOverlay]);

  return (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Edit frames</h3>

                <div className="flex gap-2">
                  <button
                    onClick={() => setEditFrameTab("first")}
                    className={`rounded-md px-3 py-2 text-sm ${editFrameTab === "first" ? "bg-ink text-white" : "bg-ink/10"}`}
                  >
                    Start Frame
                  </button>
                  <button
                    onClick={() => setEditFrameTab("last")}
                    className={`rounded-md px-3 py-2 text-sm ${editFrameTab === "last" ? "bg-ink text-white" : "bg-ink/10"}`}
                  >
                    End Frame (Optional)
                  </button>
                </div>

                <div className="space-y-3 rounded-lg border border-ink/10 bg-white p-3">
                  <p className="text-sm text-ink/70">
                    Working on: {editFrameTab === "first" ? "Start Frame" : "End Frame"}
                    {activeEditFrame ? ` (frame ${activeEditFrame.frameIndex}, ${activeEditFrame.timecode})` : ""}
                  </p>

                  {!activeEditFrame ? (
                    <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
                      Select frames in Select Frames first, then return here to edit.
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
                        Edit
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Comparison</p>
                  {activeEditFrame?.imageUrl ? (
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
                          <ReactCompareSliderImage
                            src={activeEditSourceImageUrl ?? activeEditFrame.imageUrl}
                            alt="Edit source"
                            style={{ height: "100%", width: "100%", objectFit: "contain", objectPosition: "center" }}
                          />
                        }
                        itemTwo={
                          <ReactCompareSliderImage
                            src={activeCompareImageUrl ?? activeEditFrame.imageUrl}
                            alt="Selected variant"
                            style={{ height: "100%", width: "100%", objectFit: "contain", objectPosition: "center" }}
                          />
                        }
                      />
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
                      Select a frame in Select Frames to start comparing edits.
                    </div>
                  )}
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
                          <img src={candidate.imageUrl} className="mb-2 w-full rounded bg-bg object-contain" />
                        </button>
                        <p className="text-xs font-medium text-ink/80">{candidate.label}</p>
                        <p className="text-[11px] text-ink/60">{formatCompactTimestamp(candidate.createdAt)}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded border border-ink/20 bg-white p-2 text-xs"
                            title="Preview"
                            onClick={() => setImagePreviewModal({ url: candidate.imageUrl, label: candidate.label })}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="rounded border border-ink/20 bg-white p-2 text-xs"
                            title="Use for editing"
                            onClick={() => {
                              setEditSourceCandidate(editFrameTab, candidate);
                            }}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 20h9" />
                              <path d="m16.5 3.5 4 4L8 20H4v-4L16.5 3.5Z" />
                            </svg>
                          </button>
                          <a
                            href={candidate.imageUrl}
                            target="_blank"
                            rel="noreferrer"
                            download
                            className="rounded border border-ink/20 bg-white p-2 text-xs"
                            title="Download full quality image"
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 3v12" />
                              <path d="m7 10 5 5 5-5" />
                              <path d="M4 21h16" />
                            </svg>
                          </a>
                          <button
                            type="button"
                            className="rounded border border-red-200 bg-white p-2 text-xs text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                            title={candidate.kind === "original" ? "Original frame cannot be deleted" : "Delete variant"}
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
                </div>

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
                            window.alert("Generating frame from patch edit. You can track progress in Jobs.");
                            patchEditMutation.mutate(activeEditFrame.frameId);
                            setPatchModalOpen(false);
                          }}
                        >
                          Edit
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
                      {patchEditMutation.error ? <p className="text-xs text-red-600">{patchEditMutation.error.message}</p> : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { apiClient } from "../../api/client";
import { InfoButton, InfoModal, type InfoModalState } from "../reports/QcReportShared";

type WorkspaceViewMode = "composite" | "generated" | "original" | "diff" | "mask" | "edge" | "qc";
type ToolMode = "pan" | "brush" | "lasso" | "sam-point" | "compare";
type MaskEditMode = "add" | "subtract" | "replace" | "intersect";
type CompareMode = "off" | "split" | "blink";
type OverlayKey = "mask" | "generationMask" | "diff" | "binary" | "restoration" | "samProposal";
type ModalState = "idle" | "analysing" | "analysis_ready" | "reanalysing" | "previewing" | "applying" | "error";
type CollapsibleSection = "maskActions" | "metrics";

type QualitySettings = {
  diffThreshold: number;
  minRegionAreaPct: number;
  featherWidthPx: number;
  boundaryProtectionWidthPx: number;
  edgeSuppression: "off" | "low" | "medium" | "high";
  useSeamlessCloneFallback: boolean;
  autoDetectEditRegion: boolean;
};

type SamEdgeBias = "conservative" | "balanced" | "inclusive";

type SamProposal = {
  id: string;
  maskUrl: string;
  score?: number;
  bounds?: { x: number; y: number; w: number; h: number };
};

type AnalyseResponse = Awaited<ReturnType<typeof apiClient.analyseQualityMatch>>;

type QualityMatchModalProps = {
  isOpen: boolean;
  taskId: string | null;
  frameId: string | null;
  variantId: string | null;
  variantLabel: string;
  originalFrameUrl?: string | null;
  generatedFrameUrl?: string | null;
  alreadyReviewed?: boolean;
  onClose: () => void;
  onApplied: (result?: { frameId?: string; variantId?: string; sourceVariantId?: string | null }) => void;
};

const DEFAULT_SETTINGS: QualitySettings = {
  diffThreshold: 0.08,
  minRegionAreaPct: 0.0005,
  featherWidthPx: 6,
  boundaryProtectionWidthPx: 8,
  edgeSuppression: "medium",
  useSeamlessCloneFallback: true,
  autoDetectEditRegion: true,
};

const DEFAULT_OVERLAY_OPACITY: Record<OverlayKey, number> = {
  mask: 0.72,
  generationMask: 1,
  diff: 0.45,
  binary: 0.4,
  restoration: 0.55,
  samProposal: 0.45,
};

const SECTION_DEFAULTS: Record<CollapsibleSection, boolean> = {
  maskActions: true,
  metrics: true,
};

const QUALITY_MATCH_INFO = {
  workspace: [
    "Quality Match is a compositing workspace for generated frames. On load it analyses the original and generated frames, builds the automatic overlays, and suggests an Auto mask.",
    "The intended flow is: inspect the overlays, build the Keep Mask with brush, lasso, Add Auto to Mask, or Add Segment to Mask, click PREVIEW to build the current Output Preview, and then click SAVE when the result is correct.",
  ],
  viewport: [
    "The viewport is the main workspace. You can zoom, pan, split-compare, blink, paint directly on the Keep Mask, and inspect the Auto, Diff, Edge, and Segment overlays without leaving the image.",
    "Original and Generated are the source images. Output Preview is the current composite built from your current Keep Mask. Split and Blink are for comparison only; they do not change the mask or the saved result.",
  ],
  layers: [
    "Overlays are optional diagnostic layers drawn on top of the current base image. Keep Mask shows the editable matte you are building. Diff Map shows the difference heatmap. Edge Map shows the thresholded binary change map. Auto Map shows the automatic suggestion from the current analysis. Segment Map shows the current point-driven segmentation proposal. Gen Mask shows the outline of the original generation mask when one existed.",
    "Use opacity to inspect how strongly each overlay overlaps the image. Diff and Edge are useful for understanding what changed, Auto suggests a mask, and Keep Mask and Segment are the layers you will act on directly.",
  ],
  detailMask: [
    "Keep Mask is the editable grayscale matte used for PREVIEW and SAVE. Brighter mask areas keep more of the generated image. Darker areas restore more of the original image.",
    "You can paint directly on the Keep Mask with a soft brush, add the current Auto suggestion with Add Auto to Mask, or add the current Segment proposal with Add Segment to Mask. The overlay shows mask strength, not just a binary on/off region.",
  ],
  diff: [
    "Diff is the standard difference heatmap between the original and generated frames. It helps you see where the generated image changed most strongly relative to the original.",
    "Diff sensitivity and minimum region size affect the next analysis pass, not the current Keep Mask directly. Change those settings and click Re-analyse when you want the automatic overlays to be recomputed.",
  ],
  edge: [
    "Edge shows the thresholded binary change map used by the analysis. It is a harder changed-versus-not-changed view than Diff and is useful for spotting isolated speckles or weak edge noise.",
    "Edge suppression affects this overlay on the next analysis pass. Increase it when the automatic suggestion is picking up too much weak or noisy change around boundaries.",
  ],
  qc: [
    "Auto is the current automatic suggestion layer. It merges the quality analysis with the edit mask used during generation, if one exists, to suggest where generated pixels should be kept.",
    "Suggested keep areas from analysis + generation edit mask.",
    "Use this as a proposal and diagnostic layer, not as the final result. If the Auto suggestion is useful, bring it into the editable Keep Mask with Add Auto Map to Mask and then refine from there.",
  ],
  tools: [
    "Brush Add and Brush Subtract edit the Keep Mask directly on the image. Lasso Add and Lasso Subtract do the same with polygon regions. The brush uses Size and Soft controls, so you can build either hard or soft edges into the matte.",
    "Pan is for navigation. Compare is only active when Split is on and lets you drag the split line. The Segment tool adds foreground prompt points to generate a segmentation proposal that you can then add into the Keep Mask. Keyboard shortcuts: B = brush add, E = brush subtract, L = lasso, Space = pan, Z = zoom to fit.",
  ],
  settings: [
    "These controls affect the automatic analysis and preview blend. Diff sensitivity, minimum region size, edge suppression, protect edges, and auto-detect region affect the analysis-driven overlays and suggested Auto layer after you click Re-analyse.",
    "Edge softness and seamless blend fallback affect PREVIEW and SAVE. The Keep Mask itself is a grayscale matte, so soft brush edits and global edge softness work together rather than forcing everything into a hard binary cutout.",
  ],
  metrics: [
    "Before shows the measured change and leakage for the current generated frame before Quality Match. Preview shows the same measurements for the current Output Preview after your current mask edits and preview settings are applied.",
    "Use these values to check whether PREVIEW is reducing unwanted spill while still keeping the intended edit. Current mask coverage is based on the grayscale Keep Mask, so partially feathered regions contribute proportionally rather than as simple on/off pixels.",
  ],
  sam: [
    "Segment Mask uses SAM 2 segmentation as an optional point-guided proposal helper. Click one or more foreground points directly on the image. Multiple points work together to guide one segmentation result for the same object or region.",
    "Each prompt change queues a segmentation run automatically. The returned Segment result appears as a temporary overlay that you can invert, clear, or merge with Add Segment Map to Mask. Segment stays separate from the core automatic analysis and does not overwrite the Keep Mask unless you explicitly add it.",
  ],
  maskActions: [
    "Add Auto Map to Mask unions the current Auto suggestion into the editable Keep Mask. Add Segment Map to Mask unions the current Segment proposal into the Keep Mask. Add Gen Mask to Mask unions the original generation mask into the Keep Mask when that source mask exists. Fill Holes closes enclosed gaps, Remove Speckles removes small fragments, Expand Mask and Contract Mask push the mask outward or inward, and Smooth Edge softens abrupt steps in the current matte.",
    "These are bulk operations. Use them when the mask is broadly right but needs cleanup or reinforcement. For local precision, refine the Keep Mask directly with the brush or lasso tools. Seamless blend fallback is optional edge smoothing during merge; when off, the kept region uses straight mask compositing.",
  ],
  apply: [
    "PREVIEW builds a new Output Preview from the current Keep Mask and preview settings. SAVE uploads the current Keep Mask, computes the final composite, replaces the generated frame asset, and stores the Quality Match audit metadata.",
    "Use Re-analyse when you want the automatic overlays and suggestion layers to be recomputed from the current analysis settings. Use PREVIEW when the Keep Mask has changed. Use SAVE only when the Output Preview is correct.",
  ],
} as const;

function rgbaFromMaskValue(value: number): [number, number, number, number] {
  if (value <= 0) return [0, 0, 0, 0];
  return [145, 92, 255, Math.round((value / 255) * 170)];
}

function rgbaFromSamValue(value: number): [number, number, number, number] {
  return value > 0 ? [34, 211, 238, 155] : [0, 0, 0, 0];
}

function overlayDotClasses(color: "purple" | "blue" | "yellow" | "green" | "cyan", active: boolean): string {
  const colorMap = {
    purple: active ? "border-violet-300 bg-violet-400" : "border-violet-300/70 bg-transparent",
    blue: active ? "border-blue-400 bg-blue-500" : "border-blue-400/70 bg-transparent",
    yellow: active ? "border-amber-300 bg-amber-300" : "border-amber-300/70 bg-transparent",
    green: active ? "border-emerald-300 bg-emerald-400" : "border-emerald-300/70 bg-transparent",
    cyan: active ? "border-cyan-300 bg-cyan-400" : "border-cyan-300/70 bg-transparent",
  } as const;
  return `inline-block h-2.5 w-2.5 rounded-full border ${colorMap[color]}`;
}

function drawMaskOutline(ctx: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement, color: string, lineWidth = 2): void {
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) return;
  const mask = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const width = mask.width;
  const height = mask.height;
  const outline = new ImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      if (mask.data[idx] <= 10) continue;
      let isEdge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (!isEdge) {
        const left = mask.data[(y * width + (x - 1)) * 4] > 10;
        const right = mask.data[(y * width + (x + 1)) * 4] > 10;
        const up = mask.data[((y - 1) * width + x) * 4] > 10;
        const down = mask.data[((y + 1) * width + x) * 4] > 10;
        isEdge = !(left && right && up && down);
      }
      if (!isEdge) continue;
      outline.data[idx] = 34;
      outline.data[idx + 1] = 211;
      outline.data[idx + 2] = 238;
      outline.data[idx + 3] = 255;
    }
  }
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offscreenCtx = offscreen.getContext("2d");
  if (!offscreenCtx) return;
  offscreenCtx.putImageData(outline, 0, 0);
  ctx.save();
  ctx.drawImage(offscreen, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.restore();
}

function cloneImageData(data: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
}

function dataUrlFromCanvas(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

function createBlankMaskCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
  }
  return canvas;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function applyMorphology(mask: ImageData, op: "grow" | "shrink" | "fill_holes" | "remove_speckles" | "smooth"): ImageData {
  const width = mask.width;
  const height = mask.height;
  const source = mask.data;
  const binary: number[] = new Array(width * height).fill(0);
  for (let i = 0; i < width * height; i += 1) {
    binary[i] = source[i * 4] > 10 ? 1 : 0;
  }

  const runKernel = (input: number[], mode: "dilate" | "erode"): number[] => {
    const out = new Array(input.length).fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        let value = mode === "erode" ? 1 : 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || xx >= width || yy < 0 || yy >= height) {
              if (mode === "erode") value = 0;
              continue;
            }
            const neighbor = input[yy * width + xx];
            if (mode === "dilate") {
              if (neighbor) value = 1;
            } else if (!neighbor) {
              value = 0;
            }
          }
        }
        out[idx] = value;
      }
    }
    return out;
  };

  let transformed = binary;
  if (op === "grow") transformed = runKernel(binary, "dilate");
  if (op === "shrink") transformed = runKernel(binary, "erode");
  if (op === "fill_holes") transformed = runKernel(runKernel(binary, "dilate"), "erode");
  if (op === "remove_speckles") transformed = runKernel(runKernel(binary, "erode"), "dilate");
  if (op === "smooth") {
    const next = cloneImageData(mask);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let total = 0;
        let weightTotal = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = clamp(x + dx, 0, width - 1);
            const yy = clamp(y + dy, 0, height - 1);
            const weight = dx === 0 && dy === 0 ? 4 : Math.abs(dx) + Math.abs(dy) === 1 ? 2 : 1;
            total += source[(yy * width + xx) * 4] * weight;
            weightTotal += weight;
          }
        }
        const value = Math.round(total / Math.max(1, weightTotal));
        const base = (y * width + x) * 4;
        next.data[base] = value;
        next.data[base + 1] = value;
        next.data[base + 2] = value;
        next.data[base + 3] = value;
      }
    }
    return next;
  }

  const next = cloneImageData(mask);
  for (let i = 0; i < width * height; i += 1) {
    const base = i * 4;
    const value = transformed[i] ? 255 : 0;
    next.data[base] = value;
    next.data[base + 1] = value;
    next.data[base + 2] = value;
    next.data[base + 3] = value;
  }
  return next;
}

function mergeMaskData(target: ImageData, proposal: ImageData, mode: MaskEditMode): ImageData {
  const next = cloneImageData(target);
  const maxPixels = Math.min(target.width * target.height, proposal.width * proposal.height);
  for (let index = 0; index < maxPixels; index += 1) {
    const offset = index * 4;
    const current = target.data[offset];
    const incoming = proposal.data[offset];
    let value = current;
    if (mode === "add") value = Math.max(current, incoming);
    if (mode === "subtract") value = Math.round(current * (1 - incoming / 255));
    if (mode === "replace") value = incoming;
    if (mode === "intersect") value = Math.min(current, incoming);
    next.data[offset] = value;
    next.data[offset + 1] = value;
    next.data[offset + 2] = value;
    next.data[offset + 3] = value;
  }
  return next;
}

function getMaskCoverage(mask: ImageData): number {
  let count = 0;
  for (let index = 0; index < mask.width * mask.height; index += 1) {
    count += mask.data[index * 4] / 255;
  }
  return count / Math.max(1, mask.width * mask.height);
}

function getMaskBounds(mask: ImageData): { x: number; y: number; width: number; height: number } | null {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const value = mask.data[(y * mask.width + x) * 4];
      if (value <= 10) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function drawMaskCanvas(
  canvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  proposalCanvas: HTMLCanvasElement | null,
  options: {
    showMask: boolean;
    showProposal: boolean;
    lassoPoints: Array<{ x: number; y: number }>;
    hoverPoint: { x: number; y: number } | null;
    brushSize: number;
    brushSoftness: number;
    activeTool: ToolMode;
    showMaskOnly: boolean;
    maskEditMode: MaskEditMode;
    maskOpacity: number;
    proposalOpacity: number;
  },
): void {
  const ctx = canvas.getContext("2d");
  const maskCtx = maskCanvas.getContext("2d");
  if (!ctx || !maskCtx) return;
  canvas.width = maskCanvas.width;
  canvas.height = maskCanvas.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (options.showMaskOnly) {
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (options.showMask) {
    const mask = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const overlay = new ImageData(mask.width, mask.height);
    for (let i = 0; i < mask.width * mask.height; i += 1) {
      const offset = i * 4;
      const [r, g, b, a] = rgbaFromMaskValue(mask.data[offset]);
      overlay.data[offset] = r;
      overlay.data[offset + 1] = g;
      overlay.data[offset + 2] = b;
      overlay.data[offset + 3] = Math.round(a * options.maskOpacity);
    }
    const offscreen = document.createElement("canvas");
    offscreen.width = mask.width;
    offscreen.height = mask.height;
    const offscreenCtx = offscreen.getContext("2d");
    if (offscreenCtx) {
      offscreenCtx.putImageData(overlay, 0, 0);
      ctx.drawImage(offscreen, 0, 0);
    }
  }

  if (options.showProposal && proposalCanvas) {
    const proposalCtx = proposalCanvas.getContext("2d");
    if (proposalCtx) {
      const proposal = proposalCtx.getImageData(0, 0, proposalCanvas.width, proposalCanvas.height);
      const overlay = new ImageData(proposal.width, proposal.height);
      for (let i = 0; i < proposal.width * proposal.height; i += 1) {
        const offset = i * 4;
        const [r, g, b, a] = rgbaFromSamValue(proposal.data[offset]);
        overlay.data[offset] = r;
        overlay.data[offset + 1] = g;
        overlay.data[offset + 2] = b;
        overlay.data[offset + 3] = Math.round(a * options.proposalOpacity);
      }
      const offscreen = document.createElement("canvas");
      offscreen.width = proposal.width;
      offscreen.height = proposal.height;
      const offscreenCtx = offscreen.getContext("2d");
      if (offscreenCtx) {
        offscreenCtx.putImageData(overlay, 0, 0);
        ctx.drawImage(offscreen, 0, 0);
      }
    }
  }

  if (options.lassoPoints.length >= 2) {
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = options.maskEditMode === "subtract" ? "#ef4444" : "#f59e0b";
    ctx.beginPath();
    ctx.moveTo(options.lassoPoints[0].x, options.lassoPoints[0].y);
    for (const point of options.lassoPoints.slice(1)) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (options.hoverPoint && (options.activeTool === "brush" || options.activeTool === "sam-point")) {
    ctx.save();
    ctx.strokeStyle = options.activeTool === "sam-point" ? "#60a5fa" : options.maskEditMode === "subtract" ? "#ef4444" : "#22c55e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(options.hoverPoint.x, options.hoverPoint.y, Math.max(2, options.brushSize / 2), 0, Math.PI * 2);
    ctx.stroke();
    if (options.activeTool === "brush") {
      const innerRadius = Math.max(1, (options.brushSize / 2) * (1 - options.brushSoftness));
      if (innerRadius < options.brushSize / 2) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.beginPath();
        ctx.arc(options.hoverPoint.x, options.hoverPoint.y, innerRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }
}

function buildComparisonMaskStyle(split: number): { clipPath: string } {
  const clamped = clamp(split, 0, 1) * 100;
  return { clipPath: `inset(0 ${100 - clamped}% 0 0)` };
}

async function loadCrossOriginImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    image.src = src;
  });
  return image;
}

async function loadMaskIntoCanvas(src: string): Promise<HTMLCanvasElement> {
  const image = await loadCrossOriginImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to prepare mask canvas");
  ctx.drawImage(image, 0, 0);
  return canvas;
}

function Section(props: { title: string; infoLabel?: string; infoLines?: string[]; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const { title, infoLabel, infoLines, open, onToggle, children } = props;
  const [infoModal, setInfoModal] = useState<InfoModalState>(null);
  return (
    <section className="rounded-xl border border-ink/10 bg-white">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onToggle} className="text-left text-sm font-semibold text-ink/90">
            {open ? "▾" : "▸"} {title}
          </button>
          {infoLabel && infoLines ? <InfoButton label={infoLabel} onClick={() => setInfoModal({ title, lines: infoLines })} /> : null}
        </div>
      </div>
      {open ? <div className="border-t border-ink/10 px-3 py-3">{children}</div> : null}
      <InfoModal state={infoModal} onClose={() => setInfoModal(null)} />
    </section>
  );
}

function ToolRailButton(props: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { label, active, disabled = false, onClick, children } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-11 w-full items-center justify-center rounded-xl border ${
        disabled ? "cursor-not-allowed border-ink/10 bg-bg text-ink/30" : active ? "border-accent bg-accent/10 text-accent" : "border-ink/10 bg-bg text-ink/70 hover:bg-white"
      }`}
    >
      {children}
    </button>
  );
}

function IconPan() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 11V5a1.5 1.5 0 1 1 3 0v5" />
      <path d="M11 10V4.5a1.5 1.5 0 1 1 3 0V10" />
      <path d="M14 10.5V6a1.5 1.5 0 1 1 3 0v7.5c0 3.6-2.8 6.5-6.2 6.5H10c-3 0-5-2-5-5v-4.5a1.5 1.5 0 1 1 3 0V13" />
    </svg>
  );
}

function IconBrush(props: { mode: "add" | "subtract" }) {
  const { mode } = props;
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4l5 5-8.5 8.5-5-5L15 4z" />
      <path d="M6.5 12.5L4 17c-.5 1 0 3 2.5 3 2 0 3-1 3.5-2l1.5-2.5" />
      {mode === "add" ? (
        <>
          <path d="M18.5 14.5v5" />
          <path d="M16 17h5" />
        </>
      ) : (
        <path d="M16 17h5" />
      )}
    </svg>
  );
}

function IconLasso(props: { mode: "add" | "subtract" }) {
  const { mode } = props;
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8c2-3 8-4 11-1.5 3 2.5 2 7-1.5 8.5-3.5 1.5-8.5.5-9.5-2.5-.8-2.4.9-4.2 3-4.2 1.7 0 2.8 1.2 2.8 2.6 0 1.2-.8 2.1-1.8 2.1-.7 0-1.2-.5-1.2-1.1" />
      <path d="M8.2 14.7c0 1.3-.8 2.3-1.9 2.3S4.5 16 4.5 14.7c0-1.2.7-2.2 1.8-2.2s1.9 1 1.9 2.2z" />
      {mode === "add" ? (
        <>
          <path d="M18.5 15v5" />
          <path d="M16 17.5h5" />
        </>
      ) : (
        <path d="M16 17.5h5" />
      )}
    </svg>
  );
}

function IconSam() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 2.5v3" />
      <path d="M12 18.5v3" />
      <path d="M2.5 12h3" />
      <path d="M18.5 12h3" />
    </svg>
  );
}

function IconSamClear() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 2.5v3" />
      <path d="M12 18.5v3" />
      <path d="M2.5 12h3" />
      <path d="M18.5 12h3" />
      <path d="M5 19L19 5" stroke="#dc2626" />
    </svg>
  );
}

function IconCompare() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M12 5v14" />
      <path d="M9.5 9.5H7.5" />
      <path d="M9.5 14.5H7.5" />
      <path d="M16.5 9.5h-2" />
      <path d="M16.5 14.5h-2" />
    </svg>
  );
}

export default function QualityMatchModal({
  isOpen,
  taskId,
  frameId,
  variantId,
  variantLabel,
  originalFrameUrl,
  generatedFrameUrl,
  alreadyReviewed,
  onClose,
  onApplied,
}: QualityMatchModalProps) {
  const [modalState, setModalState] = useState<ModalState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalyseResponse | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [settings, setSettings] = useState<QualitySettings>(DEFAULT_SETTINGS);
  const [lastAnalysedSettings, setLastAnalysedSettings] = useState<QualitySettings>(DEFAULT_SETTINGS);
  const [lastPreviewedSettings, setLastPreviewedSettings] = useState<QualitySettings>(DEFAULT_SETTINGS);
  const [viewerMode, setViewerMode] = useState<WorkspaceViewMode>("generated");
  const [compareMode, setCompareMode] = useState<CompareMode>("off");
  const [overlayOpacity, setOverlayOpacity] = useState<Record<OverlayKey, number>>(DEFAULT_OVERLAY_OPACITY);
  const [visibleOverlays, setVisibleOverlays] = useState<Record<OverlayKey, boolean>>({
    mask: true,
    generationMask: false,
    diff: false,
    binary: false,
    restoration: true,
    samProposal: false,
  });
  const [activeTool, setActiveTool] = useState<ToolMode>("brush");
  const [maskEditMode, setMaskEditMode] = useState<MaskEditMode>("add");
  const [brushSize, setBrushSize] = useState(28);
  const [brushSoftness, setBrushSoftness] = useState(0.55);
  const [splitPosition, setSplitPosition] = useState(0.5);
  const [isDrawing, setIsDrawing] = useState(false);
  const [lassoPoints, setLassoPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [zoomPreset, setZoomPreset] = useState<"fit" | "mask" | "100" | "200">("fit");
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const [maskDirty, setMaskDirty] = useState(false);
  const [maskCoverage, setMaskCoverage] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [compareDragActive, setCompareDragActive] = useState(false);
  const [blinkOn, setBlinkOn] = useState(false);
  const [activeOverlayPopover, setActiveOverlayPopover] = useState<OverlayKey | null>(null);
  const [sectionOpen, setSectionOpen] = useState<Record<CollapsibleSection, boolean>>(SECTION_DEFAULTS);
  const [infoModal, setInfoModal] = useState<InfoModalState>(null);
  const [samEdgeBias, setSamEdgeBias] = useState<SamEdgeBias>("balanced");
  const [samRestrictToMaskBounds, setSamRestrictToMaskBounds] = useState(false);
  const [samProposal, setSamProposal] = useState<SamProposal | null>(null);
  const [samPoints, setSamPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [samLoading, setSamLoading] = useState(false);
  const [samError, setSamError] = useState<string | null>(null);
  const [segmentHintVisible, setSegmentHintVisible] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const proposedMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const proposalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const generationMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const proposalImageUrlRef = useRef<string | null>(null);
  const originalImageRef = useRef<HTMLImageElement | null>(null);
  const generatedImageRef = useRef<HTMLImageElement | null>(null);
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const diffImageRef = useRef<HTMLImageElement | null>(null);
  const binaryImageRef = useRef<HTMLImageElement | null>(null);
  const restorationImageRef = useRef<HTMLImageElement | null>(null);
  const panStateRef = useRef<{ active: boolean; startX: number; startY: number; scrollLeft: number; scrollTop: number }>({
    active: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const settingsRef = useRef<QualitySettings>(DEFAULT_SETTINGS);
  const renderWorkspaceOverlayRef = useRef<() => void>(() => {});
  const analysePromiseRef = useRef<Promise<void> | null>(null);
  const lastBrushPointRef = useRef<{ x: number; y: number } | null>(null);
  const samRunInFlightRef = useRef(false);
  const samQueuedArgsRef = useRef<{
    points: Array<{ x: number; y: number }>;
    edgeBias: SamEdgeBias;
    restrict: boolean;
  } | null>(null);

  const clearSamState = useCallback(() => {
    setSamPoints([]);
    setSamProposal(null);
    setSamLoading(false);
    setSamError(null);
    setSegmentHintVisible(false);
    samRunInFlightRef.current = false;
    samQueuedArgsRef.current = null;
    proposalCanvasRef.current = null;
    proposalImageUrlRef.current = null;
  }, []);

  const resetWorkspaceState = useCallback(() => {
    setModalState("idle");
    setError(null);
    setAnalysis(null);
    setAnalysisId(null);
    setSettings(DEFAULT_SETTINGS);
    setLastAnalysedSettings(DEFAULT_SETTINGS);
    setLastPreviewedSettings(DEFAULT_SETTINGS);
    setViewerMode("generated");
    setCompareMode("off");
    setOverlayOpacity(DEFAULT_OVERLAY_OPACITY);
    setVisibleOverlays({ mask: true, generationMask: false, diff: false, binary: false, restoration: true, samProposal: false });
    setActiveTool("brush");
    setMaskEditMode("add");
    setBrushSize(28);
    setBrushSoftness(0.55);
    setSplitPosition(0.5);
    setIsDrawing(false);
    setLassoPoints([]);
    setHoverPoint(null);
    setZoom(1);
    setZoomPreset("fit");
    setMaskDirty(false);
    setMaskCoverage(0);
    setHistory([]);
    setHistoryIndex(-1);
    setCompareDragActive(false);
    setBlinkOn(false);
    setActiveOverlayPopover(null);
    setSectionOpen(SECTION_DEFAULTS);
    setInfoModal(null);
    setSamEdgeBias("balanced");
    setSamRestrictToMaskBounds(false);
    setSegmentHintVisible(false);
    clearSamState();
    lastBrushPointRef.current = null;
    maskCanvasRef.current = null;
    proposedMaskCanvasRef.current = null;
    generationMaskCanvasRef.current = null;
  }, [clearSamState]);

  const toggleSection = useCallback((key: CollapsibleSection) => {
    setSectionOpen((previous) => ({ ...previous, [key]: !previous[key] }));
  }, []);

  const pushMaskHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const snapshot = dataUrlFromCanvas(maskCanvas);
    setHistory((previous) => {
      const nextBase = historyIndex >= 0 ? previous.slice(0, historyIndex + 1) : previous;
      const next = [...nextBase, snapshot].slice(-30);
      setHistoryIndex(next.length - 1);
      return next;
    });
  }, [historyIndex]);

  const renderWorkspaceOverlay = useCallback(() => {
    const stageCanvas = stageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!stageCanvas || !maskCanvas) return;
    drawMaskCanvas(stageCanvas, maskCanvas, proposalCanvasRef.current, {
      showMask: visibleOverlays.mask || viewerMode === "mask",
      showProposal: visibleOverlays.samProposal,
      lassoPoints,
      hoverPoint,
      brushSize,
      brushSoftness,
      activeTool,
      showMaskOnly: viewerMode === "mask",
      maskEditMode,
      maskOpacity: overlayOpacity.mask,
      proposalOpacity: overlayOpacity.samProposal,
    });

    const ctx = stageCanvas.getContext("2d");
    if (!ctx) return;
    if (visibleOverlays.generationMask && generationMaskCanvasRef.current) {
      drawMaskOutline(ctx, generationMaskCanvasRef.current, "#22d3ee", 2);
    }
    if (samPoints.length) {
      ctx.save();
      for (const point of samPoints) {
        ctx.fillStyle = "#3b82f6";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [activeTool, brushSize, brushSoftness, hoverPoint, lassoPoints, maskEditMode, overlayOpacity.mask, overlayOpacity.samProposal, samPoints, viewerMode, visibleOverlays]);

  useEffect(() => {
    renderWorkspaceOverlayRef.current = renderWorkspaceOverlay;
  }, [renderWorkspaceOverlay]);

  useEffect(() => {
    if (!segmentHintVisible) return;
    const timeout = window.setTimeout(() => setSegmentHintVisible(false), 2800);
    return () => window.clearTimeout(timeout);
  }, [segmentHintVisible]);

  const syncMaskCoverage = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext("2d");
    if (!maskCanvas || !maskCtx) return;
    const mask = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    setMaskCoverage(getMaskCoverage(mask));
  }, []);

  const initialiseMaskFromAnalysis = useCallback(async (nextAnalysis: AnalyseResponse) => {
    const proposedMaskCanvas = await loadMaskIntoCanvas(nextAnalysis.artifacts.proposedMergeMaskUri);
    proposedMaskCanvasRef.current = proposedMaskCanvas;
    const currentMaskCanvas = maskCanvasRef.current;
    if (currentMaskCanvas && currentMaskCanvas.width === proposedMaskCanvas.width && currentMaskCanvas.height === proposedMaskCanvas.height) {
      maskCanvasRef.current = currentMaskCanvas;
    } else {
      maskCanvasRef.current = createBlankMaskCanvas(proposedMaskCanvas.width, proposedMaskCanvas.height);
    }
    generationMaskCanvasRef.current = nextAnalysis.artifacts.originalMaskUri ? await loadMaskIntoCanvas(nextAnalysis.artifacts.originalMaskUri) : null;
    clearSamState();
    const sources = await Promise.all([
      loadCrossOriginImage(originalFrameUrl || nextAnalysis.artifacts.alignedGeneratedUri),
      loadCrossOriginImage(nextAnalysis.artifacts.alignedGeneratedUri || generatedFrameUrl || nextAnalysis.artifacts.previewUri),
      loadCrossOriginImage(nextAnalysis.artifacts.previewUri),
      loadCrossOriginImage(nextAnalysis.artifacts.diffHeatmapUri),
      loadCrossOriginImage(nextAnalysis.artifacts.binaryChangeMaskUri),
      loadCrossOriginImage(nextAnalysis.artifacts.restorationMapUri),
    ]);
    originalImageRef.current = sources[0];
    generatedImageRef.current = sources[1];
    previewImageRef.current = sources[2];
    diffImageRef.current = sources[3];
    binaryImageRef.current = sources[4];
    restorationImageRef.current = sources[5];
    setVisibleOverlays((previous) => ({ ...previous, restoration: true }));
    setMaskDirty(false);
    if (!currentMaskCanvas || currentMaskCanvas.width !== proposedMaskCanvas.width || currentMaskCanvas.height !== proposedMaskCanvas.height) {
      setHistory([dataUrlFromCanvas(maskCanvasRef.current)]);
      setHistoryIndex(0);
    }
    syncMaskCoverage();
    renderWorkspaceOverlayRef.current();
  }, [clearSamState, generatedFrameUrl, originalFrameUrl, syncMaskCoverage]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const analyse = useCallback(
    async (maskKey?: string, reuseAnalysisId?: string, settingsOverride?: QualitySettings) => {
      if (!taskId || !frameId || !variantId) return;
      if (analysePromiseRef.current) {
        return analysePromiseRef.current;
      }
      const promise = (async () => {
        setModalState(reuseAnalysisId ? "reanalysing" : "analysing");
        setError(null);
        const response = await apiClient.analyseQualityMatch(taskId, frameId, {
          variantId,
          existingAnalysisId: reuseAnalysisId,
          maskKey,
          settings: settingsOverride ?? settingsRef.current,
        });
        setAnalysis(response);
        setAnalysisId(response.analysisId);
        setModalState("analysis_ready");
        setSettings(response.settings);
        setLastAnalysedSettings(response.settings);
        setLastPreviewedSettings(response.settings);
        await initialiseMaskFromAnalysis(response);
      })();
      analysePromiseRef.current = promise;
      try {
        await promise;
      } finally {
        if (analysePromiseRef.current === promise) {
          analysePromiseRef.current = null;
        }
      }
    },
    [frameId, initialiseMaskFromAnalysis, taskId, variantId],
  );

  useEffect(() => {
    if (!isOpen || !taskId || !frameId || !variantId) return;
    resetWorkspaceState();
    void analyse(undefined, undefined, DEFAULT_SETTINGS).catch((err) => {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Initial Quality Match analysis failed");
    });
  }, [analyse, frameId, isOpen, resetWorkspaceState, taskId, variantId]);

  useEffect(() => {
    if (isOpen) return;
    resetWorkspaceState();
  }, [isOpen, resetWorkspaceState]);

  useEffect(() => {
    renderWorkspaceOverlay();
  }, [renderWorkspaceOverlay]);

  useEffect(() => {
    if (!isOpen) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      setViewportSize({ width, height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [isOpen]);

  const imageWidth = maskCanvasRef.current?.width ?? previewImageRef.current?.naturalWidth ?? generatedImageRef.current?.naturalWidth ?? 1;
  const imageHeight = maskCanvasRef.current?.height ?? previewImageRef.current?.naturalHeight ?? generatedImageRef.current?.naturalHeight ?? 1;

  const fitZoom = useMemo(() => {
    if (!imageWidth || !imageHeight || !viewportSize.width || !viewportSize.height) return 1;
    return Math.max(0.1, Math.min(viewportSize.width / imageWidth, viewportSize.height / imageHeight));
  }, [imageHeight, imageWidth, viewportSize.height, viewportSize.width]);

  const applyZoomPreset = useCallback((preset: "fit" | "mask" | "100" | "200") => {
    if (preset === "mask") {
      setZoomPreset("mask");
      return;
    }
    setZoomPreset(preset);
    if (preset === "fit") {
      setZoom(fitZoom);
      return;
    }
    if (preset === "100") {
      setZoom(1);
      return;
    }
    setZoom(2);
  }, [fitZoom]);

  useEffect(() => {
    if (zoomPreset === "mask") return;
    applyZoomPreset(zoomPreset);
  }, [applyZoomPreset, zoomPreset]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const nextIndex = historyIndex - 1;
        if (nextIndex >= 0) {
          const snapshot = history[nextIndex];
          void (async () => {
            const canvas = await loadMaskIntoCanvas(snapshot);
            maskCanvasRef.current = canvas;
            setHistoryIndex(nextIndex);
            syncMaskCoverage();
            renderWorkspaceOverlay();
          })();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        const nextIndex = historyIndex + 1;
        if (nextIndex < history.length) {
          const snapshot = history[nextIndex];
          void (async () => {
            const canvas = await loadMaskIntoCanvas(snapshot);
            maskCanvasRef.current = canvas;
            setHistoryIndex(nextIndex);
            syncMaskCoverage();
            renderWorkspaceOverlay();
          })();
        }
        return;
      }
      if (event.key.toLowerCase() === "b") {
        setActiveTool("brush");
        setMaskEditMode("add");
      }
      if (event.key.toLowerCase() === "e") {
        setActiveTool("brush");
        setMaskEditMode("subtract");
      }
      if (event.key.toLowerCase() === "l") {
        setActiveTool("lasso");
      }
      if (event.key === " ") {
        event.preventDefault();
        setActiveTool("pan");
      }
      if (event.key.toLowerCase() === "z") {
        applyZoomPreset("fit");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [applyZoomPreset, history, historyIndex, isOpen, renderWorkspaceOverlay, syncMaskCoverage]);

  useEffect(() => {
    if (compareMode !== "blink") {
      setBlinkOn(false);
      return;
    }
    const handle = window.setInterval(() => {
      setBlinkOn((previous) => !previous);
    }, 500);
    return () => window.clearInterval(handle);
  }, [compareMode]);

  useEffect(() => {
    if (compareMode !== "split" && activeTool === "compare") {
      setActiveTool("pan");
    }
  }, [activeTool, compareMode]);

  const uploadCurrentMask = useCallback(async () => {
    if (!taskId || !frameId) throw new Error("Task or frame missing");
    const canvas = maskCanvasRef.current;
    if (!canvas) throw new Error("Mask canvas not ready");
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((output) => {
        if (!output) {
          reject(new Error("Unable to create mask blob"));
          return;
        }
        resolve(output);
      }, "image/png");
    });
    const init = await apiClient.initQualityMatchMaskUpload(taskId, frameId, { analysisId: analysisId ?? undefined });
    const put = await fetch(init.maskUploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: blob,
    });
    if (!put.ok) throw new Error(`Mask upload failed (${put.status})`);
    return init.maskKey;
  }, [analysisId, frameId, taskId]);

  const runReanalyse = useCallback(async () => {
    const maskKey = await uploadCurrentMask();
    await analyse(maskKey, analysisId ?? undefined, settings);
  }, [analyse, analysisId, settings, uploadCurrentMask]);

  const handleReanalyse = useCallback(async () => {
    try {
      await runReanalyse();
    } catch (err) {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Re-analyse failed");
    }
  }, [runReanalyse]);

  const handleReset = useCallback(async () => {
    try {
      setSettings(DEFAULT_SETTINGS);
      setViewerMode("composite");
      await analyse(undefined, analysisId ?? undefined, DEFAULT_SETTINGS);
    } catch (err) {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Reset failed");
    }
  }, [analyse, analysisId]);

  const handlePreviewFromCurrentMask = useCallback(async () => {
    try {
      if (!taskId || !frameId || !analysisId) return;
      setModalState("previewing");
      setError(null);
      const maskKey = await uploadCurrentMask();
      const response = await apiClient.previewQualityMatch(taskId, frameId, {
        analysisId,
        maskKey,
        settings,
      });
      setAnalysis((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          artifacts: {
            ...previous.artifacts,
            previewUri: response.artifacts.previewUri,
          },
          metrics: {
            ...previous.metrics,
            ...response.metrics,
          },
          warnings: response.warnings,
        };
      });
      previewImageRef.current = await loadCrossOriginImage(response.artifacts.previewUri);
      setLastPreviewedSettings(response.settings);
      setMaskDirty(false);
      setModalState("analysis_ready");
      setViewerMode("composite");
    } catch (err) {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Preview refresh failed");
    }
  }, [analysisId, frameId, settings, taskId, uploadCurrentMask]);

  const handleApply = useCallback(async () => {
    if (!taskId || !frameId || !analysisId) return;
    try {
      setModalState("applying");
      const finalMaskKey = await uploadCurrentMask();
      const queued = await apiClient.applyQualityMatch(taskId, frameId, {
        analysisId,
        finalMaskKey,
        settings,
        overwriteGeneratedFrame: false,
      });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const job = await apiClient.getJob(queued.jobId);
        if (job.status === "complete") {
          onApplied({
            frameId: typeof job.resultRefs?.frameId === "string" ? job.resultRefs.frameId : frameId ?? undefined,
            variantId: typeof job.resultRefs?.variantId === "string" ? job.resultRefs.variantId : undefined,
            sourceVariantId: typeof job.resultRefs?.sourceVariantId === "string" ? job.resultRefs.sourceVariantId : null,
          });
          onClose();
          return;
        }
        if (job.status === "failed") {
          throw new Error(job.error || "Quality Match apply failed");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
      }
      throw new Error("Quality Match apply is taking too long");
    } catch (err) {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Apply failed");
    }
  }, [analysisId, frameId, onApplied, onClose, settings, taskId, uploadCurrentMask]);

  const baseImageUrl = useMemo(() => {
    if (!analysis) return null;
    if (viewerMode === "generated") return analysis.artifacts.alignedGeneratedUri || generatedFrameUrl || analysis.artifacts.previewUri;
    if (viewerMode === "original") return originalFrameUrl || analysis.artifacts.alignedGeneratedUri;
    if (viewerMode === "diff") return analysis.artifacts.diffHeatmapUri;
    if (viewerMode === "edge") return analysis.artifacts.binaryChangeMaskUri;
    if (viewerMode === "qc") return analysis.artifacts.restorationMapUri;
    return analysis.artifacts.previewUri;
  }, [analysis, generatedFrameUrl, originalFrameUrl, viewerMode]);

  const compareImageUrl = useMemo(() => {
    if (!analysis) return null;
    return originalFrameUrl || analysis.artifacts.alignedGeneratedUri;
  }, [analysis, originalFrameUrl]);

  const processingMessage = useMemo(() => {
    if (modalState === "analysing") {
      return {
        title: "Analysing Frame",
        detail: "Comparing original and generated frames, building Diff, Edge, and Auto overlays, and preparing an empty Keep Mask for manual refinement.",
      };
    }
    if (modalState === "reanalysing") {
      return {
        title: "Re-analysing Auto Layers",
        detail: "Refreshing Diff, Edge, and Auto overlays from your current settings without replacing the current Keep Mask.",
      };
    }
    if (modalState === "previewing") {
      return {
        title: "Building Output Preview",
        detail: "Compositing the original and generated frames using your current Keep Mask and edge softness settings.",
      };
    }
    if (modalState === "applying") {
      return {
        title: "Saving Quality Match Result",
        detail: "Writing the final merged frame, updating audit metadata, and replacing the generated frame in the task.",
      };
    }
    return null;
  }, [modalState]);

  const scaledWidth = Math.max(1, imageWidth * zoom);
  const scaledHeight = Math.max(1, imageHeight * zoom);
  const stageBoardWidth = Math.max(scaledWidth, viewportSize.width || 0);
  const stageBoardHeight = Math.max(scaledHeight, viewportSize.height || 0);
  const stageLeft = Math.max(0, (stageBoardWidth - scaledWidth) / 2);
  const stageTop = Math.max(0, (stageBoardHeight - scaledHeight) / 2);
  const pendingReanalyseChanges = useMemo(() => {
    const changes: string[] = [];
    if (settings.diffThreshold !== lastAnalysedSettings.diffThreshold) changes.push("Diff sensitivity");
    if (settings.minRegionAreaPct !== lastAnalysedSettings.minRegionAreaPct) changes.push("Minimum region size");
    if (settings.boundaryProtectionWidthPx !== lastAnalysedSettings.boundaryProtectionWidthPx) changes.push("Protect edges");
    if (settings.edgeSuppression !== lastAnalysedSettings.edgeSuppression) changes.push("Edge suppression");
    if (settings.autoDetectEditRegion !== lastAnalysedSettings.autoDetectEditRegion) changes.push("Auto-detect region");
    return changes;
  }, [lastAnalysedSettings, settings]);
  const analysisSettingsDirty = pendingReanalyseChanges.length > 0;
  const pendingPreviewChanges = useMemo(() => {
    const changes: string[] = [];
    if (maskDirty) changes.push("Mask edits");
    if (settings.featherWidthPx !== lastPreviewedSettings.featherWidthPx) changes.push("Edge softness");
    if (settings.useSeamlessCloneFallback !== lastPreviewedSettings.useSeamlessCloneFallback) changes.push("Seamless blend fallback");
    return changes;
  }, [lastPreviewedSettings, maskDirty, settings.featherWidthPx, settings.useSeamlessCloneFallback]);
  const overlayProcessedState = useMemo<Record<OverlayKey, boolean>>(
    () => ({
      mask: maskCoverage > 0.001,
      generationMask: Boolean(analysis?.artifacts.originalMaskUri),
      diff: Boolean(analysis?.artifacts.diffHeatmapUri),
      binary: Boolean(analysis?.artifacts.binaryChangeMaskUri),
      restoration: Boolean(analysis?.artifacts.restorationMapUri),
      samProposal: Boolean(samProposal),
    }),
    [analysis?.artifacts.binaryChangeMaskUri, analysis?.artifacts.diffHeatmapUri, analysis?.artifacts.originalMaskUri, analysis?.artifacts.restorationMapUri, maskCoverage, samProposal],
  );
  const stagePointerToImagePoint = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = clamp(((event.clientX - rect.left) / rect.width) * imageWidth, 0, imageWidth);
    const y = clamp(((event.clientY - rect.top) / rect.height) * imageHeight, 0, imageHeight);
    return { x, y };
  }, [imageHeight, imageWidth]);

  const commitMaskCanvas = useCallback(() => {
    setMaskDirty(true);
    syncMaskCoverage();
    renderWorkspaceOverlay();
  }, [renderWorkspaceOverlay, syncMaskCoverage]);

  const paintSoftBrush = useCallback((mask: ImageData, point: { x: number; y: number }, mode: "add" | "subtract") => {
    const next = cloneImageData(mask);
    const radius = Math.max(2, brushSize / 2);
    const hardness = clamp(1 - brushSoftness, 0, 1);
    const innerRadius = radius * hardness;
    const minX = Math.max(0, Math.floor(point.x - radius - 1));
    const maxX = Math.min(mask.width - 1, Math.ceil(point.x + radius + 1));
    const minY = Math.max(0, Math.floor(point.y - radius - 1));
    const maxY = Math.min(mask.height - 1, Math.ceil(point.y + radius + 1));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x + 0.5 - point.x;
        const dy = y + 0.5 - point.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > radius) continue;
        let influence = 0;
        if (distance <= innerRadius || radius <= innerRadius) {
          influence = 1;
        } else {
          const t = clamp((distance - innerRadius) / Math.max(0.0001, radius - innerRadius), 0, 1);
          influence = Math.cos((t * Math.PI) / 2) ** 2;
        }
        const offset = (y * mask.width + x) * 4;
        const current = next.data[offset];
        let value = current;
        if (mode === "add") {
          value = Math.max(current, Math.round(influence * 255));
        } else {
          value = Math.round(current * (1 - influence));
        }
        next.data[offset] = value;
        next.data[offset + 1] = value;
        next.data[offset + 2] = value;
        next.data[offset + 3] = value;
      }
    }
    return next;
  }, [brushSize, brushSoftness]);

  const applyBrushStamp = useCallback((point: { x: number; y: number }) => {
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext("2d");
    if (!maskCanvas || !maskCtx) return;
    if (maskEditMode === "replace" && !lastBrushPointRef.current) {
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
    const current = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    let next = current;
    const previousPoint = lastBrushPointRef.current;
    const stampMode = maskEditMode === "subtract" ? "subtract" : "add";
    if (previousPoint) {
      const dx = point.x - previousPoint.x;
      const dy = point.y - previousPoint.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const spacing = Math.max(1, brushSize * 0.18);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        next = paintSoftBrush(next, { x: previousPoint.x + dx * t, y: previousPoint.y + dy * t }, stampMode);
      }
    } else {
      next = paintSoftBrush(next, point, stampMode);
    }
    maskCtx.putImageData(next, 0, 0);
    lastBrushPointRef.current = point;
    commitMaskCanvas();
  }, [brushSize, commitMaskCanvas, maskEditMode, paintSoftBrush]);

  const commitLasso = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext("2d");
    if (!maskCanvas || !maskCtx || lassoPoints.length < 3) return;
    if (maskEditMode === "replace") {
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
    if (maskEditMode === "intersect") {
      const existing = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
      const selectionCanvas = document.createElement("canvas");
      selectionCanvas.width = maskCanvas.width;
      selectionCanvas.height = maskCanvas.height;
      const selectionCtx = selectionCanvas.getContext("2d");
      if (selectionCtx) {
        selectionCtx.fillStyle = "white";
        selectionCtx.beginPath();
        selectionCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (const point of lassoPoints.slice(1)) selectionCtx.lineTo(point.x, point.y);
        selectionCtx.closePath();
        selectionCtx.fill();
        const selection = selectionCtx.getImageData(0, 0, selectionCanvas.width, selectionCanvas.height);
        const merged = mergeMaskData(existing, selection, "intersect");
        maskCtx.putImageData(merged, 0, 0);
      }
    } else {
      maskCtx.globalCompositeOperation = maskEditMode === "subtract" ? "destination-out" : "source-over";
      maskCtx.fillStyle = "white";
      maskCtx.beginPath();
      maskCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
      for (const point of lassoPoints.slice(1)) maskCtx.lineTo(point.x, point.y);
      maskCtx.closePath();
      maskCtx.fill();
      maskCtx.globalCompositeOperation = "source-over";
    }
    commitMaskCanvas();
    pushMaskHistory();
  }, [commitMaskCanvas, lassoPoints, maskEditMode, pushMaskHistory]);

  const handleStagePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = stagePointerToImagePoint(event);
    setHoverPoint(point);
    if (activeTool === "pan" || event.shiftKey) {
      const viewport = viewportRef.current;
      if (!viewport) return;
      panStateRef.current = {
        active: true,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      };
      return;
    }
    if (activeTool === "compare") {
      setCompareMode("split");
      setCompareDragActive(true);
      return;
    }
    if (activeTool === "sam-point") {
      const nextPoints = [...samPoints, point];
      setSamPoints(nextPoints);
      void runSam(nextPoints);
      return;
    }
    if (activeTool === "lasso") {
      setIsDrawing(true);
      setLassoPoints([point]);
      return;
    }
    if (activeTool === "brush") {
      setIsDrawing(true);
      lastBrushPointRef.current = null;
      applyBrushStamp(point);
    }
  };

  const handleStagePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = stagePointerToImagePoint(event);
    setHoverPoint(point);
    if (panStateRef.current.active) {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = panStateRef.current.scrollLeft - (event.clientX - panStateRef.current.startX);
      viewport.scrollTop = panStateRef.current.scrollTop - (event.clientY - panStateRef.current.startY);
      return;
    }
    if (compareDragActive) {
      const target = event.currentTarget;
      const rect = target.getBoundingClientRect();
      setSplitPosition(clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0.05, 0.95));
      return;
    }
    if (!isDrawing) return;
    if (activeTool === "brush") {
      applyBrushStamp(point);
      return;
    }
    if (activeTool === "lasso") {
      setLassoPoints((previous) => [...previous, point]);
      return;
    }
  };

  const handleStagePointerUp = () => {
    if (panStateRef.current.active) {
      panStateRef.current.active = false;
      return;
    }
    if (compareDragActive) {
      setCompareDragActive(false);
      return;
    }
    if (activeTool === "lasso") {
      commitLasso();
    }
    if (activeTool === "brush" && isDrawing) {
      pushMaskHistory();
    }
    setIsDrawing(false);
    setLassoPoints([]);
    lastBrushPointRef.current = null;
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    setZoomPreset("100");
    setZoom((previous) => clamp(previous + (event.deltaY < 0 ? 0.08 : -0.08), fitZoom, 6));
  };

  const runMaskOperation = (op: "grow" | "shrink" | "fill_holes" | "remove_speckles" | "smooth") => {
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext("2d");
    if (!maskCanvas || !maskCtx) return;
    const current = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const next = applyMorphology(current, op);
    maskCtx.putImageData(next, 0, 0);
    commitMaskCanvas();
    pushMaskHistory();
  };

  const addCanvasIntoDetailMask = useCallback((sourceCanvas: HTMLCanvasElement | null, mode: MaskEditMode = "add") => {
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext("2d");
    const sourceCtx = sourceCanvas?.getContext("2d");
    if (!maskCanvas || !maskCtx || !sourceCanvas || !sourceCtx) return;
    const current = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const incoming = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const merged = mergeMaskData(current, incoming, mode);
    maskCtx.putImageData(merged, 0, 0);
    commitMaskCanvas();
    pushMaskHistory();
  }, [commitMaskCanvas, pushMaskHistory]);

  const zoomToMask = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext("2d");
    const viewport = viewportRef.current;
    if (!maskCanvas || !maskCtx || !viewport) return;
    const mask = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const bounds = getMaskBounds(mask);
    if (!bounds) return;
    const padding = 32;
    const zoomX = viewport.clientWidth / Math.max(1, bounds.width + padding * 2);
    const zoomY = viewport.clientHeight / Math.max(1, bounds.height + padding * 2);
    const nextZoom = clamp(Math.min(zoomX, zoomY), fitZoom, 6);
    setZoomPreset("mask");
    setZoom(nextZoom);
    window.setTimeout(() => {
      viewport.scrollLeft = Math.max(0, (bounds.x + bounds.width / 2) * nextZoom - viewport.clientWidth / 2);
      viewport.scrollTop = Math.max(0, (bounds.y + bounds.height / 2) * nextZoom - viewport.clientHeight / 2);
    }, 0);
  }, [fitZoom]);

  const undoMask = useCallback(async () => {
    const nextIndex = historyIndex - 1;
    if (nextIndex < 0) return;
    const canvas = await loadMaskIntoCanvas(history[nextIndex]);
    maskCanvasRef.current = canvas;
    setHistoryIndex(nextIndex);
    commitMaskCanvas();
  }, [commitMaskCanvas, history, historyIndex]);

  const redoMask = useCallback(async () => {
    const nextIndex = historyIndex + 1;
    if (nextIndex >= history.length) return;
    const canvas = await loadMaskIntoCanvas(history[nextIndex]);
    maskCanvasRef.current = canvas;
    setHistoryIndex(nextIndex);
    commitMaskCanvas();
  }, [commitMaskCanvas, history, historyIndex]);

  const runSam = useCallback(async (pointOverride?: Array<{ x: number; y: number }>, edgeBiasOverride?: SamEdgeBias, restrictOverride?: boolean) => {
    if (!taskId || !frameId || !variantId) return;
    const queued = {
      points: [...(pointOverride ?? samPoints)],
      edgeBias: edgeBiasOverride ?? samEdgeBias,
      restrict: restrictOverride ?? samRestrictToMaskBounds,
    };
    if (!queued.points.length) {
      setSamError("Add one or more Segment prompt points first.");
      return;
    }
    samQueuedArgsRef.current = queued;
    if (samRunInFlightRef.current) {
      return;
    }
    samRunInFlightRef.current = true;
    try {
      while (samQueuedArgsRef.current) {
        const currentRun = samQueuedArgsRef.current;
        samQueuedArgsRef.current = null;
        try {
          setSamLoading(true);
          setSamError(null);
          const existingMaskKey = currentRun.restrict ? await uploadCurrentMask() : undefined;
          const queuedResponse = await apiClient.segmentQualityMatchSam(taskId, frameId, {
            variantId,
            analysisId: analysisId ?? undefined,
            promptType: "points",
            positivePoints: currentRun.points.map(({ x, y }) => ({ x, y })),
            negativePoints: [],
            box: undefined,
            restrictToMaskBounds: currentRun.restrict,
            existingMaskKey,
            edgeBias: currentRun.edgeBias,
          });

          const deadline = Date.now() + 2 * 60 * 1000;
          let completedJob = null as Awaited<ReturnType<typeof apiClient.getJob>> | null;
          while (Date.now() < deadline) {
            const job = await apiClient.getJob(queuedResponse.jobId);
            if (job.status === "complete") {
              completedJob = job;
              break;
            }
            if (job.status === "failed") {
              throw new Error(job.error || "Segment request failed");
            }
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
          }
          if (!completedJob) {
            throw new Error("Segment generation is taking too long");
          }
          const resultRefs = completedJob.resultRefs as
            | {
                proposals?: Array<{
                  id: string;
                  maskUrl: string;
                  score?: number;
                  bounds?: { x: number; y: number; w: number; h: number };
                }>;
                warnings?: string[];
              }
            | undefined;
          const firstProposal = resultRefs?.proposals?.[0] ?? null;
          setSamProposal(firstProposal);
          if (firstProposal) {
            const proposalCanvas = await loadMaskIntoCanvas(firstProposal.maskUrl);
            proposalCanvasRef.current = proposalCanvas;
            proposalImageUrlRef.current = firstProposal.maskUrl;
          } else {
            proposalCanvasRef.current = null;
            proposalImageUrlRef.current = null;
          }
          const warnings = resultRefs?.warnings ?? [];
          setSamError(warnings.length ? warnings.join(" ") : null);
          renderWorkspaceOverlay();
        } catch (err) {
          setSamError(err instanceof Error ? err.message : "Segment request failed");
        } finally {
          setSamLoading(false);
        }
      }
    } finally {
      samRunInFlightRef.current = false;
    }
  }, [analysisId, frameId, renderWorkspaceOverlay, samEdgeBias, samPoints, samRestrictToMaskBounds, taskId, uploadCurrentMask, variantId]);

  const invertSamProposal = useCallback(() => {
    const proposalCanvas = proposalCanvasRef.current;
    const proposalCtx = proposalCanvas?.getContext("2d");
    if (!proposalCanvas || !proposalCtx) return;
    const current = proposalCtx.getImageData(0, 0, proposalCanvas.width, proposalCanvas.height);
    for (let i = 0; i < current.data.length; i += 4) {
      const next = current.data[i] > 10 ? 0 : 255;
      current.data[i] = next;
      current.data[i + 1] = next;
      current.data[i + 2] = next;
      current.data[i + 3] = next;
    }
    proposalCtx.putImageData(current, 0, 0);
    proposalImageUrlRef.current = dataUrlFromCanvas(proposalCanvas);
    renderWorkspaceOverlay();
  }, [renderWorkspaceOverlay]);

  const overlayImages: Array<{ key: OverlayKey; url: string | null; opacity: number }> = useMemo(() => {
    if (!analysis) return [];
    return [
      { key: "diff", url: analysis.artifacts.diffHeatmapUri, opacity: overlayOpacity.diff },
      { key: "binary", url: analysis.artifacts.binaryChangeMaskUri, opacity: overlayOpacity.binary },
      { key: "restoration", url: analysis.artifacts.restorationMapUri, opacity: overlayOpacity.restoration },
      { key: "samProposal", url: proposalImageUrlRef.current, opacity: overlayOpacity.samProposal },
    ];
  }, [analysis, overlayOpacity]);

  if (!isOpen) return null;

  const previewButtonTitle = pendingPreviewChanges.length
    ? `Preview from Current Mask to process: ${pendingPreviewChanges.join(", ")}`
    : "Build an output preview from the current keep-mask";
  const reanalyseButtonTitle = pendingReanalyseChanges.length
    ? `Re-analyse to process setting change${pendingReanalyseChanges.length > 1 ? "s" : ""}: ${pendingReanalyseChanges.join(", ")}`
    : "Re-run Quality Match analysis layers using the current settings";
  return (
    <div className="fixed inset-0 z-[80] bg-card text-ink">
      <div className="flex h-full flex-col">
        <header className="border-b border-ink/10 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 pr-1">
                <span className="text-xl font-semibold">QA</span>
                <InfoButton
                  label="Explain Quality Match workspace"
                  onClick={() =>
                    setInfoModal({
                      title: "Quality Match Generated Frame",
                      lines: [
                        `${variantLabel}`,
                        "Use this tool to analyse what has changed across the edited frame and then create a compositing mask that can reintroduces details/fidelity from the regions of the original frame that you want to keep.",
                        ...QUALITY_MATCH_INFO.workspace,
                      ],
                    })
                  }
                />
              </div>
              <span className="text-xs font-semibold uppercase tracking-wide text-ink/55">Base Layer</span>
              <div className="flex flex-wrap items-center gap-1 rounded-full border border-ink/10 bg-bg px-1 py-1">
                {([
                  ["original", "Original"],
                  ["generated", "Generated"],
                  ["composite", "Output Preview"],
                ] as Array<[WorkspaceViewMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewerMode(mode)}
                    className={`rounded-full px-3 py-1 text-xs ${viewerMode === mode ? "bg-ink text-white" : "text-ink/70 hover:bg-white"}`}
                  >
                    {label}
                  </button>
                ))}
                <InfoButton label="Explain viewport modes" onClick={() => setInfoModal({ title: "Viewport", lines: [...QUALITY_MATCH_INFO.viewport] })} />
              </div>
              <div className="flex items-center gap-1 rounded-full border border-ink/10 bg-bg px-1 py-1 text-xs">
                <button type="button" className={`rounded-full px-3 py-1 ${compareMode === "split" ? "bg-ink text-white" : "text-ink/70 hover:bg-white"}`} onClick={() => setCompareMode((previous) => previous === "split" ? "off" : "split")}>Split</button>
                <button type="button" className={`rounded-full px-3 py-1 ${compareMode === "blink" ? "bg-ink text-white" : "text-ink/70 hover:bg-white"}`} onClick={() => setCompareMode((previous) => previous === "blink" ? "off" : "blink")}>Blink</button>
              </div>
              <div className="flex items-center gap-1 rounded-full border border-ink/10 bg-bg px-1 py-1 text-xs">
                <button type="button" className="rounded-full px-3 py-1 text-ink/70 hover:bg-white" onClick={() => void undoMask()} disabled={historyIndex <= 0}>Undo</button>
                <button type="button" className="rounded-full px-3 py-1 text-ink/70 hover:bg-white" onClick={() => void redoMask()} disabled={historyIndex >= history.length - 1}>Redo</button>
                <button type="button" className="rounded-full px-3 py-1 text-ink/70 hover:bg-white" onClick={() => void handleReset()} disabled={modalState === "analysing" || modalState === "reanalysing" || modalState === "previewing" || modalState === "applying"}>Reset</button>
              </div>
              <button
                type="button"
                onClick={() => void handlePreviewFromCurrentMask()}
                title={previewButtonTitle}
                className={`rounded px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
                  pendingPreviewChanges.length ? "bg-amber-100 text-amber-900 ring-1 ring-amber-300" : "bg-accent2 text-white"
                }`}
                disabled={modalState === "analysing" || modalState === "reanalysing" || modalState === "previewing" || modalState === "applying"}
              >
                {modalState === "previewing" ? "Previewing..." : "PREVIEW"}
                {pendingPreviewChanges.length ? "  !" : ""}
              </button>
              <button type="button" className="rounded bg-accent px-4 py-2 text-sm text-white disabled:opacity-50" onClick={() => void handleApply()} disabled={!analysisId || modalState === "analysing" || modalState === "reanalysing" || modalState === "previewing" || modalState === "applying"}>
                {modalState === "applying" ? "Saving..." : "SAVE"}
              </button>
              <button type="button" className="rounded border border-ink/20 bg-white px-3 py-2 text-sm" onClick={onClose}>CANCEL</button>
            </div>
          </div>
          {alreadyReviewed ? (
            <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              This frame has already been QC reviewed and Quality Matched. Saving again will overwrite the current generated frame and update the QC log.
            </div>
          ) : null}
          {error ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[84px_minmax(0,1fr)_220px] gap-0">
          <aside className="flex flex-col gap-3 border-r border-ink/10 bg-white px-3 py-4">
            <div className="space-y-2">
              <ToolRailButton label="Pan" active={activeTool === "pan"} onClick={() => setActiveTool("pan")}>
                <IconPan />
              </ToolRailButton>
              <div className="space-y-1">
                <ToolRailButton
                  label="Brush add"
                  active={activeTool === "brush" && maskEditMode === "add"}
                  onClick={() => {
                    setActiveTool("brush");
                    setMaskEditMode("add");
                  }}
                >
                  <IconBrush mode="add" />
                </ToolRailButton>
                <ToolRailButton
                  label="Brush subtract"
                  active={activeTool === "brush" && maskEditMode === "subtract"}
                  onClick={() => {
                    setActiveTool("brush");
                    setMaskEditMode("subtract");
                  }}
                >
                  <IconBrush mode="subtract" />
                </ToolRailButton>
                <div className="rounded-xl border border-ink/10 bg-bg px-2 py-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-ink/55">Size</div>
                  <input type="range" min={4} max={96} step={1} value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} className="w-full" title={`Brush size ${brushSize}px`} />
                  <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-ink/55">Soft</div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={brushSoftness}
                    onChange={(event) => setBrushSoftness(Number(event.target.value))}
                    className="mt-2 w-full"
                    title={`Brush softness ${Math.round(brushSoftness * 100)}%`}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <ToolRailButton
                  label="Lasso add"
                  active={activeTool === "lasso" && maskEditMode === "add"}
                  onClick={() => {
                    setActiveTool("lasso");
                    setMaskEditMode("add");
                  }}
                >
                  <IconLasso mode="add" />
                </ToolRailButton>
                <ToolRailButton
                  label="Lasso subtract"
                  active={activeTool === "lasso" && maskEditMode === "subtract"}
                  onClick={() => {
                    setActiveTool("lasso");
                    setMaskEditMode("subtract");
                  }}
                >
                  <IconLasso mode="subtract" />
                </ToolRailButton>
              </div>
              <ToolRailButton label="Segment" active={activeTool === "sam-point"} onClick={() => setActiveTool("sam-point")}>
                <IconSam />
              </ToolRailButton>
              <ToolRailButton
                label="Clear prompt points"
                active={false}
                onClick={() => {
                  setSamPoints([]);
                  renderWorkspaceOverlay();
                }}
              >
                <IconSamClear />
              </ToolRailButton>
              <ToolRailButton
                label={compareMode === "split" ? "Compare" : "Compare unavailable until Split is enabled"}
                active={activeTool === "compare"}
                disabled={compareMode !== "split"}
                onClick={() => {
                  if (compareMode !== "split") return;
                  setActiveTool("compare");
                }}
              >
                <IconCompare />
              </ToolRailButton>
              <div className="flex items-center justify-center pt-1">
                <InfoButton label="Explain Quality Match tools" onClick={() => setInfoModal({ title: "Tools", lines: [...QUALITY_MATCH_INFO.tools] })} />
              </div>
            </div>
            <div className="mt-auto rounded-xl border border-ink/10 bg-bg p-2 text-[11px] text-ink/65">
              <div className="grid grid-cols-1 gap-1">
                <button type="button" className={`rounded-lg px-2 py-1 text-left ${zoomPreset === "fit" ? "bg-ink text-white" : "bg-white text-ink/70"}`} onClick={() => applyZoomPreset("fit")}>Fit</button>
                <button type="button" className={`rounded-lg px-2 py-1 text-left ${zoomPreset === "mask" ? "bg-ink text-white" : "bg-white text-ink/70"}`} onClick={zoomToMask}>Mask</button>
                <button type="button" className={`rounded-lg px-2 py-1 text-left ${zoomPreset === "100" ? "bg-ink text-white" : "bg-white text-ink/70"}`} onClick={() => applyZoomPreset("100")}>100%</button>
                <button type="button" className={`rounded-lg px-2 py-1 text-left ${zoomPreset === "200" ? "bg-ink text-white" : "bg-white text-ink/70"}`} onClick={() => applyZoomPreset("200")}>200%</button>
              </div>
              <div className="mt-2 border-t border-ink/10 pt-2">
              <p>Zoom: {(zoom * 100).toFixed(0)}%</p>
              </div>
            </div>
          </aside>

          <main className="relative min-h-0 bg-[#0d1117] px-3 py-3">
            <div className="absolute left-6 top-6 z-10">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/55 px-3 py-2 text-xs text-white backdrop-blur">
                <span className="font-semibold uppercase tracking-wide">OVERLAYS</span>
                  {([
                    ["mask", "Keep Mask", "Keep Mask", "purple"],
                    ["diff", "Diff Map", "Diff Map", "blue"],
                    ["binary", "Edge Map", "Edge Map", "yellow"],
                    ["restoration", "Auto Map", "Auto Map", "green"],
                    ["samProposal", "Segment Map", "Segment Map (using SAM 2 segmentation)", "cyan"],
                  ] as Array<[OverlayKey, string, string, "purple" | "blue" | "yellow" | "green" | "cyan"]>).map(([key, label, fullTitle, dotColor]) => (
                <div key={key} className="relative flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (key === "samProposal" && !samProposal && !visibleOverlays.samProposal) {
                        setSegmentHintVisible(true);
                      }
                      setVisibleOverlays((previous) => ({ ...previous, [key]: !previous[key] }));
                      setActiveOverlayPopover((previous) => (previous && previous !== key ? null : previous));
                    }}
                    className={`rounded-full px-2 py-1 ${visibleOverlays[key] ? "bg-white text-black" : "bg-white/10 text-white/70"}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span className={overlayDotClasses(dotColor, overlayProcessedState[key])} />
                      <span>{label}</span>
                      {key === "samProposal" && samLoading ? <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current/40 border-t-current" /> : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveOverlayPopover((previous) => (previous === key ? null : key))}
                    className={`rounded-full px-1.5 py-1 ${activeOverlayPopover === key ? "bg-white text-black" : "bg-white/10 text-white/70"}`}
                    aria-label={`Open ${fullTitle} controls`}
                    title={`${fullTitle} controls`}
                  >
                    ▾
                  </button>
                  {activeOverlayPopover === key ? (
                    <div className="absolute left-0 top-[calc(100%+8px)] z-20 w-72 rounded-xl border border-white/15 bg-[#111827] p-3 text-left text-xs text-white shadow-2xl">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="font-semibold">{fullTitle}</p>
                        <div className="flex items-center gap-2">
                          <InfoButton
                            label={`Explain ${fullTitle}`}
                            onClick={() =>
                              setInfoModal({
                                title: fullTitle,
                                lines:
                                  key === "mask"
                                    ? [...QUALITY_MATCH_INFO.detailMask]
                                    : key === "diff"
                                      ? [...QUALITY_MATCH_INFO.diff]
                                      : key === "binary"
                                        ? [...QUALITY_MATCH_INFO.edge]
                                        : key === "restoration"
                                          ? [...QUALITY_MATCH_INFO.qc]
                                          : [...QUALITY_MATCH_INFO.sam],
                              })
                            }
                          />
                          <button type="button" className="text-white/70" onClick={() => setActiveOverlayPopover(null)}>
                            Close
                          </button>
                        </div>
                      </div>
                      <label className="block">
                        <span className="mb-1 block">Opacity {Math.round(overlayOpacity[key] * 100)}%</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={overlayOpacity[key]}
                          onChange={(event) => setOverlayOpacity((previous) => ({ ...previous, [key]: Number(event.target.value) }))}
                          className="w-full"
                        />
                      </label>
                      {key === "diff" ? (
                        <div className="mt-3 space-y-3">
                          <label className="block">
                            <span className="mb-1 block">Diff sensitivity ({settings.diffThreshold.toFixed(2)})</span>
                            <input
                              type="range"
                              min={0.05}
                              max={0.4}
                              step={0.01}
                              value={settings.diffThreshold}
                              onChange={(event) => setSettings((previous) => ({ ...previous, diffThreshold: Number(event.target.value) }))}
                              className="w-full"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block">Minimum region size ({(settings.minRegionAreaPct * 100).toFixed(3)}%)</span>
                            <input
                              type="range"
                              min={0}
                              max={0.01}
                              step={0.0001}
                              value={settings.minRegionAreaPct}
                              onChange={(event) => setSettings((previous) => ({ ...previous, minRegionAreaPct: Number(event.target.value) }))}
                              className="w-full"
                            />
                          </label>
                        </div>
                      ) : null}
                      {key === "binary" ? (
                        <div className="mt-3 space-y-3">
                          <label className="block">
                            <span className="mb-1 block">Edge suppression</span>
                            <select
                              className="w-full rounded border border-white/15 bg-black/20 px-2 py-1"
                              value={settings.edgeSuppression}
                              onChange={(event) => setSettings((previous) => ({ ...previous, edgeSuppression: event.target.value as QualitySettings["edgeSuppression"] }))}
                            >
                              <option value="off">Off</option>
                              <option value="low">Low</option>
                              <option value="medium">Medium</option>
                              <option value="high">High</option>
                            </select>
                          </label>
                        </div>
                      ) : null}
                      {key === "restoration" ? (
                        <div className="mt-3 space-y-3">
                          <label className="block">
                            <span className="mb-1 block">Edge softness ({settings.featherWidthPx}px)</span>
                            <input
                              type="range"
                              min={0}
                              max={32}
                              step={1}
                              value={settings.featherWidthPx}
                              onChange={(event) => setSettings((previous) => ({ ...previous, featherWidthPx: Number(event.target.value) }))}
                              className="w-full"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block">Protect edges ({settings.boundaryProtectionWidthPx}px)</span>
                            <input
                              type="range"
                              min={0}
                              max={32}
                              step={1}
                              value={settings.boundaryProtectionWidthPx}
                              onChange={(event) => setSettings((previous) => ({ ...previous, boundaryProtectionWidthPx: Number(event.target.value) }))}
                              className="w-full"
                            />
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={settings.useSeamlessCloneFallback}
                              onChange={(event) => setSettings((previous) => ({ ...previous, useSeamlessCloneFallback: event.target.checked }))}
                            />
                            Seamless blend fallback
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={settings.autoDetectEditRegion}
                              onChange={(event) => setSettings((previous) => ({ ...previous, autoDetectEditRegion: event.target.checked }))}
                            />
                            Auto-detect region if no source mask
                          </label>
                        </div>
                      ) : null}
                      {key === "samProposal" ? (
                        <div className="mt-3 space-y-3">
                          <label className="block">
                            <span className="mb-1 block">Edge bias</span>
                            <select
                              className="w-full rounded border border-white/15 bg-black/20 px-2 py-1"
                              value={samEdgeBias}
                              onChange={(event) => {
                                const nextValue = event.target.value as SamEdgeBias;
                                setSamEdgeBias(nextValue);
                                if (samPoints.length) {
                                  void runSam(samPoints, nextValue, samRestrictToMaskBounds);
                                }
                              }}
                            >
                              <option value="conservative">Conservative</option>
                              <option value="balanced">Balanced</option>
                              <option value="inclusive">Inclusive</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={samRestrictToMaskBounds}
                              onChange={(event) => {
                                const nextChecked = event.target.checked;
                                setSamRestrictToMaskBounds(nextChecked);
                                if (samPoints.length) {
                                  void runSam(samPoints, samEdgeBias, nextChecked);
                                }
                              }}
                            />
                            Restrict scoring to current mask bounds
                          </label>
                          <div className="space-y-2 text-white/80">
                            <p className="text-[11px] leading-5 text-white/70">
                              Click one or more foreground points on the image. Multiple points work together to guide one Segment result for the same object or region.
                            </p>
                            {samError ? <div className="rounded border border-red-300/30 bg-red-500/10 px-2 py-2 text-[11px] text-red-100">{samError}</div> : null}
                          </div>
                          <div className="grid grid-cols-1 gap-2">
                            <button type="button" className="rounded border border-white/15 bg-white/10 px-2 py-1 text-white" onClick={() => { setSamPoints([]); renderWorkspaceOverlay(); }}>
                              Clear points
                            </button>
                            <button type="button" className="rounded border border-white/15 bg-white/10 px-2 py-1 text-white" onClick={() => { clearSamState(); renderWorkspaceOverlay(); }}>
                              Clear Segment
                            </button>
                            <button type="button" className="rounded border border-white/15 bg-white/10 px-2 py-1 text-white disabled:opacity-50" onClick={invertSamProposal} disabled={!samProposal}>
                              Invert proposal
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {key !== "mask" && key !== "samProposal" ? (
                        <div className="mt-3 border-t border-white/10 pt-3">
                          <p className="mb-2 text-[11px] text-white/65">
                            {analysisSettingsDirty ? "Settings changed. Press Re-analyse to refresh this overlay." : "Analysis-backed settings take effect when you press Re-analyse."}
                          </p>
                          <button
                            type="button"
                            className="rounded border border-white/15 bg-white/10 px-2 py-1 text-white"
                            onClick={() => void handleReanalyse()}
                            disabled={modalState === "analysing" || modalState === "reanalysing" || modalState === "previewing" || modalState === "applying"}
                          >
                            {modalState === "reanalysing" ? "Re-analysing..." : "Re-analyse"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
              {analysis?.artifacts.originalMaskUri ? (
                <div className="relative flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setVisibleOverlays((previous) => ({ ...previous, generationMask: !previous.generationMask }))}
                    className={`rounded-full px-2 py-1 ${visibleOverlays.generationMask ? "bg-white text-black" : "bg-white/10 text-white/70"}`}
                    title="Toggle the original generation mask outline"
                  >
                    <span className="inline-flex items-center gap-1">
                      <span className={overlayDotClasses("cyan", overlayProcessedState.generationMask)} />
                      <span>Gen Mask</span>
                    </span>
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                title={reanalyseButtonTitle}
                className={`rounded-full px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50 ${
                  pendingReanalyseChanges.length ? "bg-amber-100 text-amber-900 ring-1 ring-amber-300" : "bg-white/10 text-white/90"
                }`}
                onClick={() => void handleReanalyse()}
                disabled={modalState === "analysing" || modalState === "reanalysing" || modalState === "previewing" || modalState === "applying" || !analysisId}
              >
                {modalState === "reanalysing" ? "Re-analysing..." : "Re-analyse"}
                {pendingReanalyseChanges.length ? "  !" : ""}
              </button>
              </div>
              {segmentHintVisible ? (
                <div className="mt-2 ml-2 inline-flex rounded-lg border border-amber-300/40 bg-amber-100 px-3 py-1.5 text-[11px] text-amber-950 shadow-lg">
                  <span className="inline-flex items-center gap-1">
                    Add points with the
                    <span className="inline-flex items-center rounded-full border border-amber-950/15 px-2 py-0.5">
                      <IconSam />
                    </span>
                    tool to automatically segment a region
                  </span>
                </div>
              ) : null}
            </div>

            <div ref={viewportRef} className="h-full overflow-auto rounded-2xl border border-white/10 bg-[#0b0f14]" onWheel={handleWheel}>
              <div className="relative" style={{ width: stageBoardWidth, height: stageBoardHeight }}>
                <div className="relative" style={{ width: scaledWidth, height: scaledHeight, left: stageLeft, top: stageTop }}>
                  {processingMessage ? (
                    <div className="pointer-events-none absolute inset-x-0 top-20 z-30 flex justify-center px-6">
                      <div className="max-w-3xl space-y-3">
                        <div className="flex items-start gap-3 rounded-xl border border-white/20 bg-slate-900/88 px-4 py-3 text-white shadow-2xl backdrop-blur">
                          <div className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold tracking-wide text-white">{processingMessage.title}</p>
                            <p className="mt-0.5 text-xs leading-5 text-white/85">{processingMessage.detail}</p>
                          </div>
                        </div>
                        {(modalState === "analysing" || modalState === "reanalysing") ? (
                          <div className="rounded-xl border border-white/15 bg-black/55 px-4 py-3 text-white shadow-2xl backdrop-blur">
                            <div className="space-y-2 text-[12px] leading-5 text-white/90">
                              <p className="font-semibold uppercase tracking-wide text-white/90">How to use this step</p>
                              <p>1. Use the different overlays (Diff Map, Edge Map, Auto Map, Segment Map) to analyse changes to the image</p>
                              <p>
                                <span className="mr-2 inline-flex translate-y-[2px] items-center rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-white/80">
                                  <IconSam />
                                </span>
                                tool to segment a region
                              </p>
                              <p>
                                2. Add Auto Map or Segment Map to the Keep Mask or draw using
                                <span className="mx-2 inline-flex translate-y-[2px] items-center gap-1 rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-white/80">
                                  <IconBrush mode="add" />
                                  <IconLasso mode="add" />
                                </span>
                                tools
                              </p>
                              <p>3. PREVIEW to reintroduce details from the original, refine further, and then SAVE</p>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {viewerMode !== "mask" && baseImageUrl ? <img src={baseImageUrl} alt="Quality Match base" className="absolute inset-0 h-full w-full select-none object-contain" draggable={false} /> : null}
                  {compareMode === "split" && compareImageUrl && viewerMode !== "mask" ? (
                    <>
                      <img src={compareImageUrl} alt="Original comparison" className="absolute inset-0 h-full w-full select-none object-contain" style={buildComparisonMaskStyle(splitPosition)} draggable={false} />
                      <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white" style={{ left: `${splitPosition * 100}%` }} />
                    </>
                  ) : null}
                  {compareMode === "blink" && compareImageUrl && viewerMode !== "mask" ? (
                    <img
                      src={compareImageUrl}
                      alt="Blink comparison"
                      className="absolute inset-0 h-full w-full select-none object-contain"
                      style={{ opacity: blinkOn ? 1 : 0 }}
                      draggable={false}
                    />
                  ) : null}
                  {overlayImages.map((overlay) =>
                    visibleOverlays[overlay.key] && overlay.url && viewerMode !== "mask" ? (
                      <img
                        key={overlay.key}
                        src={overlay.url}
                        alt={overlay.key}
                        className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                        style={{
                          opacity: overlay.opacity,
                          filter:
                            overlay.key === "binary"
                              ? "sepia(1) saturate(3.6) hue-rotate(358deg) brightness(1.08)"
                              : undefined,
                        }}
                        draggable={false}
                      />
                    ) : null,
                  )}
                  <canvas
                    ref={stageCanvasRef}
                    width={imageWidth}
                    height={imageHeight}
                    className={`absolute inset-0 h-full w-full ${activeTool === "pan" ? "cursor-grab" : activeTool === "compare" ? "cursor-col-resize" : "cursor-crosshair"}`}
                    onPointerDown={handleStagePointerDown}
                    onPointerMove={handleStagePointerMove}
                    onPointerUp={handleStagePointerUp}
                    onPointerLeave={handleStagePointerUp}
                    onPointerCancel={handleStagePointerUp}
                    onDoubleClick={zoomToMask}
                  />
                </div>
              </div>
            </div>
          </main>

          <aside className="min-h-0 overflow-y-auto border-l border-ink/10 bg-card px-3 py-3">
            <div className="space-y-3">
              <Section title="Keep Mask Actions" infoLabel="Explain mask actions" infoLines={[...QUALITY_MATCH_INFO.maskActions]} open={sectionOpen.maskActions} onToggle={() => toggleSection("maskActions")}>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left" onClick={() => addCanvasIntoDetailMask(proposedMaskCanvasRef.current, "add")}>Add Auto Map to Mask</button>
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left disabled:opacity-50" onClick={() => addCanvasIntoDetailMask(proposalCanvasRef.current, "add")} disabled={!samProposal}>Add Segment Map to Mask</button>
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left disabled:opacity-50" onClick={() => addCanvasIntoDetailMask(generationMaskCanvasRef.current, "add")} disabled={!generationMaskCanvasRef.current}>Add Gen Mask to Mask</button>
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left" onClick={() => runMaskOperation("fill_holes")}>Fill Holes</button>
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left" onClick={() => runMaskOperation("remove_speckles")}>Remove Speckles</button>
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left" onClick={() => runMaskOperation("grow")}>Expand Mask</button>
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left" onClick={() => runMaskOperation("shrink")}>Contract Mask</button>
                  <button type="button" className="rounded border border-ink/20 bg-white px-2 py-1.5 text-left" onClick={() => runMaskOperation("smooth")}>Smooth Edge</button>
                  <label className="mt-1 flex items-start gap-2 rounded border border-ink/20 bg-bg px-2 py-2 text-xs text-ink/80">
                    <input
                      type="checkbox"
                      checked={settings.useSeamlessCloneFallback}
                      onChange={(event) => setSettings((previous) => ({ ...previous, useSeamlessCloneFallback: event.target.checked }))}
                    />
                    <span>
                      Use seamless blend fallback on mask edges
                      <span className="block text-[11px] text-ink/60">
                        Keeps straight keep-mask compositing in the interior and only smooths difficult seams near the boundary.
                      </span>
                    </span>
                  </label>
                </div>
              </Section>

              <Section title="Metrics" infoLabel="Explain preview metrics" infoLines={[...QUALITY_MATCH_INFO.metrics]} open={sectionOpen.metrics} onToggle={() => toggleSection("metrics")}>
                <div className="space-y-3 text-sm">
                  <div className="rounded-lg border border-ink/10 bg-bg p-3">
                    <p className="font-medium text-ink/90">Before</p>
                    <p>Changed: {analysis?.metrics.changedPctBefore ?? "n/a"}%</p>
                    <p>Outside leakage: {analysis?.metrics.outsideLeakageBefore ?? "n/a"}%</p>
                    <p>Boundary spill: {analysis?.metrics.boundarySpillBefore ?? "n/a"}%</p>
                  </div>
                  <div className="rounded-lg border border-ink/10 bg-bg p-3">
                    <p className="font-medium text-ink/90">Preview</p>
                    <p>Changed: {analysis?.metrics.changedPctPreview ?? "n/a"}%</p>
                    <p>Outside leakage: {analysis?.metrics.outsideLeakagePreview ?? "n/a"}%</p>
                    <p>Boundary spill: {analysis?.metrics.boundarySpillPreview ?? "n/a"}%</p>
                  </div>
                  <div className="rounded-lg border border-ink/10 bg-bg p-3 text-xs text-ink/70">
                    <p>Generated coverage: {analysis?.metrics.proposedGeneratedCoveragePct ?? "n/a"}%</p>
                    <p>Original restore: {analysis?.metrics.proposedOriginalRestorePct ?? "n/a"}%</p>
                    <p>Current mask coverage: {(maskCoverage * 100).toFixed(2)}%</p>
                  </div>
                  {analysis?.warnings?.length ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                      {analysis.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Section>

            </div>
          </aside>
        </div>
      </div>
      <InfoModal state={infoModal} onClose={() => setInfoModal(null)} />
    </div>
  );
}

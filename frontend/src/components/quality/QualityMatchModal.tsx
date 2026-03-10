import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";

import { apiClient } from "../../api/client";

type ViewMode = "restoration" | "original" | "generated" | "diff" | "mask" | "preview" | "split";
type ToolMode = "brush_add" | "brush_erase" | "lasso_add" | "lasso_subtract";
type ModalState = "idle" | "analysing" | "analysis_ready" | "editing_mask" | "reanalysing" | "applying" | "completed" | "error";

type QualitySettings = {
  diffThreshold: number;
  minRegionAreaPct: number;
  featherWidthPx: number;
  boundaryProtectionWidthPx: number;
  edgeSuppression: "off" | "low" | "medium" | "high";
  useSeamlessCloneFallback: boolean;
  autoDetectEditRegion: boolean;
};

type AnalyseResponse = Awaited<ReturnType<typeof apiClient.analyseQualityMatch>>;

const DEFAULT_SETTINGS: QualitySettings = {
  diffThreshold: 0.12,
  minRegionAreaPct: 0.0005,
  featherWidthPx: 6,
  boundaryProtectionWidthPx: 8,
  edgeSuppression: "medium",
  useSeamlessCloneFallback: true,
  autoDetectEditRegion: true,
};

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
  onApplied: () => void;
};

function rgbaFromMaskValue(value: number): [number, number, number, number] {
  return value > 0 ? [36, 190, 130, 150] : [0, 0, 0, 0];
}

function cloneImageData(data: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
}

function applyMorphology(mask: ImageData, op: "grow" | "shrink" | "fill_holes" | "remove_speckles"): ImageData {
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
            const v = input[yy * width + xx];
            if (mode === "dilate") {
              if (v) value = 1;
            } else if (!v) {
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
  const [viewMode, setViewMode] = useState<ViewMode>("restoration");
  const [overlayOpacity, setOverlayOpacity] = useState(0.8);
  const [settings, setSettings] = useState<QualitySettings>(DEFAULT_SETTINGS);
  const [analysis, setAnalysis] = useState<AnalyseResponse | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>("brush_add");
  const [brushSize, setBrushSize] = useState(20);
  const [maskDirty, setMaskDirty] = useState(false);
  const [blinkEnabled, setBlinkEnabled] = useState(false);
  const [blinkOn, setBlinkOn] = useState(false);
  const [lassoPoints, setLassoPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [isDrawing, setIsDrawing] = useState(false);

  const editorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const editorMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const editorBaseImageRef = useRef<HTMLImageElement | null>(null);

  const analyse = useCallback(
    async (maskKey?: string, reuseAnalysisId?: string) => {
      if (!taskId || !frameId || !variantId) return;
      setModalState(reuseAnalysisId ? "reanalysing" : "analysing");
      setError(null);
      const response = await apiClient.analyseQualityMatch(taskId, frameId, {
        variantId,
        existingAnalysisId: reuseAnalysisId,
        maskKey,
        settings,
      });
      setAnalysis(response);
      setAnalysisId(response.analysisId);
      setModalState("analysis_ready");
      setMaskDirty(false);
    },
    [frameId, settings, taskId, variantId],
  );

  const renderMaskOverlay = useCallback(() => {
    const canvas = editorCanvasRef.current;
    const maskCanvas = editorMaskCanvasRef.current;
    const baseImage = editorBaseImageRef.current;
    if (!canvas || !maskCanvas || !baseImage) return;
    const ctx = canvas.getContext("2d");
    const maskCtx = maskCanvas.getContext("2d");
    if (!ctx || !maskCtx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
    const mask = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const overlay = new ImageData(mask.width, mask.height);
    for (let i = 0; i < mask.width * mask.height; i += 1) {
      const src = i * 4;
      const value = mask.data[src];
      const [r, g, b, a] = rgbaFromMaskValue(value);
      overlay.data[src] = r;
      overlay.data[src + 1] = g;
      overlay.data[src + 2] = b;
      overlay.data[src + 3] = a;
    }
    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = mask.width;
    overlayCanvas.height = mask.height;
    const overlayCtx = overlayCanvas.getContext("2d");
    if (overlayCtx) {
      overlayCtx.putImageData(overlay, 0, 0);
      ctx.drawImage(overlayCanvas, 0, 0, canvas.width, canvas.height);
    }
  }, []);

  const initMaskFromAnalysis = useCallback(async () => {
    if (!analysis?.artifacts.proposedMergeMaskUri) return;
    const maskImage = new Image();
    maskImage.crossOrigin = "anonymous";
    const source = analysis.artifacts.proposedMergeMaskUri;
    await new Promise<void>((resolve, reject) => {
      maskImage.onload = () => resolve();
      maskImage.onerror = () => reject(new Error("Failed to load proposed mask"));
      maskImage.src = source;
    });

    const baseImage = new Image();
    baseImage.crossOrigin = "anonymous";
    const baseSrc = analysis.artifacts.alignedGeneratedUri || generatedFrameUrl || analysis.artifacts.previewUri;
    await new Promise<void>((resolve, reject) => {
      baseImage.onload = () => resolve();
      baseImage.onerror = () => reject(new Error("Failed to load generated frame"));
      baseImage.src = baseSrc;
    });

    editorBaseImageRef.current = baseImage;
    const maskCanvas = editorMaskCanvasRef.current ?? document.createElement("canvas");
    maskCanvas.width = maskImage.width;
    maskCanvas.height = maskImage.height;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return;
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);
    editorMaskCanvasRef.current = maskCanvas;

    const editorCanvas = editorCanvasRef.current;
    if (editorCanvas) {
      editorCanvas.width = maskImage.width;
      editorCanvas.height = maskImage.height;
      renderMaskOverlay();
    }
  }, [analysis, generatedFrameUrl, renderMaskOverlay]);

  useEffect(() => {
    if (!isOpen || !taskId || !frameId || !variantId) return;
    setError(null);
    setModalState("analysing");
    setSettings(DEFAULT_SETTINGS);
    setAnalysis(null);
    setAnalysisId(null);
    setMaskDirty(false);
    setBlinkEnabled(false);
    setBlinkOn(false);
    void analyse();
  }, [analyse, frameId, isOpen, taskId, variantId]);

  useEffect(() => {
    if (!analysis) return;
    void initMaskFromAnalysis();
  }, [analysis, initMaskFromAnalysis]);

  useEffect(() => {
    if (!blinkEnabled) return;
    const handle = window.setInterval(() => setBlinkOn((value) => !value), 450);
    return () => window.clearInterval(handle);
  }, [blinkEnabled]);

  const uploadCurrentMask = useCallback(async () => {
    if (!taskId || !frameId) throw new Error("Task or frame missing");
    const canvas = editorMaskCanvasRef.current;
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
    if (!put.ok) {
      throw new Error(`Mask upload failed (${put.status})`);
    }
    return init.maskKey;
  }, [analysisId, frameId, taskId]);

  const handleReanalyse = useCallback(async () => {
    try {
      const maskKey = await uploadCurrentMask();
      await analyse(maskKey, analysisId ?? undefined);
    } catch (err) {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Re-analyse failed");
    }
  }, [analyse, analysisId, uploadCurrentMask]);

  const handleReset = useCallback(async () => {
    setSettings(DEFAULT_SETTINGS);
    try {
      await analyse(undefined, analysisId ?? undefined);
    } catch (err) {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Reset failed");
    }
  }, [analyse, analysisId]);

  const handleApply = useCallback(async () => {
    if (!taskId || !frameId || !analysisId) return;
    try {
      setModalState("applying");
      const finalMaskKey = await uploadCurrentMask();
      await apiClient.applyQualityMatch(taskId, frameId, {
        analysisId,
        finalMaskKey,
        settings,
        overwriteGeneratedFrame: true,
      });
      setModalState("completed");
      onApplied();
    } catch (err) {
      setModalState("error");
      setError(err instanceof Error ? err.message : "Apply failed");
    }
  }, [analysisId, frameId, onApplied, settings, taskId, uploadCurrentMask]);

  const processingMessage = useMemo(() => {
    if (modalState === "analysing") {
      return "Analysing original vs generated frame and building initial Quality Match proposal. This can take a little while.";
    }
    if (modalState === "reanalysing") {
      return "Re-analysing with your updated mask/settings. This can take a little while.";
    }
    if (modalState === "applying") {
      return "Applying final merge mask, writing the replacement frame, and saving QC artifacts.";
    }
    return null;
  }, [modalState]);

  const viewerNode = useMemo(() => {
    if (!analysis) return null;
    if (viewMode === "split") {
      return (
        <div className="overflow-hidden rounded-md border border-ink/15 bg-bg">
          <ReactCompareSlider
            itemOne={<ReactCompareSliderImage src={originalFrameUrl || analysis.artifacts.alignedGeneratedUri} alt="Original" style={{ objectFit: "contain" }} />}
            itemTwo={<ReactCompareSliderImage src={analysis.artifacts.previewUri} alt="Final preview" style={{ objectFit: "contain" }} />}
          />
        </div>
      );
    }
    if (viewMode === "restoration") {
      return (
        <div className="relative overflow-hidden rounded-md border border-ink/15 bg-bg">
          <img src={analysis.artifacts.alignedGeneratedUri} alt="Generated aligned" className="w-full object-contain" />
          <img
            src={analysis.artifacts.restorationMapUri}
            alt="Restoration map"
            className="absolute inset-0 h-full w-full object-contain"
            style={{ opacity: overlayOpacity }}
          />
        </div>
      );
    }
    const modeToUrl: Record<Exclude<ViewMode, "split" | "restoration">, string | null | undefined> = {
      original: blinkEnabled && blinkOn ? analysis.artifacts.previewUri : originalFrameUrl || analysis.artifacts.alignedGeneratedUri,
      generated: analysis.artifacts.alignedGeneratedUri || generatedFrameUrl,
      diff: analysis.artifacts.diffHeatmapUri,
      mask: analysis.artifacts.proposedMergeMaskUri,
      preview: analysis.artifacts.previewUri,
    };
    const url = modeToUrl[viewMode as Exclude<ViewMode, "split" | "restoration">];
    return (
      <div className="overflow-hidden rounded-md border border-ink/15 bg-bg">
        {url ? <img src={url} alt={viewMode} className="w-full object-contain" /> : <div className="p-6 text-sm text-ink/60">No preview</div>}
      </div>
    );
  }, [analysis, blinkEnabled, blinkOn, generatedFrameUrl, originalFrameUrl, overlayOpacity, viewMode]);

  const onMaskPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = editorCanvasRef.current;
    const maskCanvas = editorMaskCanvasRef.current;
    if (!canvas || !maskCanvas) return;
    canvas.setPointerCapture(event.pointerId);
    setIsDrawing(true);
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * maskCanvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * maskCanvas.height;
    if (toolMode.startsWith("lasso")) {
      setLassoPoints([{ x, y }]);
      return;
    }
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;
    ctx.globalCompositeOperation = toolMode === "brush_erase" ? "destination-out" : "source-over";
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    setMaskDirty(true);
    renderMaskOverlay();
  };

  const onMaskPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = editorCanvasRef.current;
    const maskCanvas = editorMaskCanvasRef.current;
    if (!canvas || !maskCanvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * maskCanvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * maskCanvas.height;
    if (toolMode.startsWith("lasso")) {
      setLassoPoints((previous) => [...previous, { x, y }]);
      return;
    }
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;
    ctx.globalCompositeOperation = toolMode === "brush_erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = "white";
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y + 0.1);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    setMaskDirty(true);
    renderMaskOverlay();
  };

  const onMaskPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = editorCanvasRef.current;
    const maskCanvas = editorMaskCanvasRef.current;
    if (!canvas || !maskCanvas) return;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (toolMode.startsWith("lasso") && lassoPoints.length >= 3) {
      const ctx = maskCanvas.getContext("2d");
      if (ctx) {
        ctx.globalCompositeOperation = toolMode === "lasso_subtract" ? "destination-out" : "source-over";
        ctx.fillStyle = "white";
        ctx.beginPath();
        ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (const point of lassoPoints.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
      setMaskDirty(true);
      renderMaskOverlay();
    }
    setLassoPoints([]);
    setIsDrawing(false);
  };

  const runMaskOperation = (op: "grow" | "shrink" | "fill_holes" | "remove_speckles") => {
    const maskCanvas = editorMaskCanvasRef.current;
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;
    const current = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const next = applyMorphology(current, op);
    ctx.putImageData(next, 0, 0);
    setMaskDirty(true);
    renderMaskOverlay();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[94vh] w-full max-w-[1500px] overflow-y-auto rounded-2xl border border-ink/15 bg-card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Quality Match Generated Frame</h3>
            <p className="text-sm text-ink/70">{variantLabel}</p>
            {alreadyReviewed ? (
              <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                This frame has already been QC reviewed and Quality Matched. Applying again will overwrite the current generated frame and update the QC log.
              </p>
            ) : null}
          </div>
          <button className="rounded border border-ink/20 bg-white px-3 py-1 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {processingMessage ? (
          <div className="mb-3 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-ink/80">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
              <span>{processingMessage}</span>
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.9fr_1fr]">
          <section className="space-y-3 rounded-lg border border-ink/10 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <select className="rounded border border-ink/20 px-2 py-1 text-sm" value={viewMode} onChange={(e) => setViewMode(e.target.value as ViewMode)}>
                <option value="restoration">Restoration Map</option>
                <option value="split">Split View</option>
                <option value="preview">Final Preview</option>
                <option value="diff">Diff Heatmap</option>
                <option value="mask">Proposed Merge Mask</option>
                <option value="generated">Generated</option>
                <option value="original">Original</option>
              </select>
              <label className="text-xs text-ink/70">
                Overlay opacity
                <input type="range" min={0} max={1} step={0.05} value={overlayOpacity} onChange={(e) => setOverlayOpacity(Number(e.target.value))} />
              </label>
              <label className="flex items-center gap-1 text-xs text-ink/70">
                <input type="checkbox" checked={blinkEnabled} onChange={(e) => setBlinkEnabled(e.target.checked)} />
                Blink Original/Preview
              </label>
            </div>
            {viewerNode ?? (
              <div className="rounded-md border border-ink/15 bg-bg p-6 text-sm text-ink/60">
                {processingMessage ?? "No preview available yet."}
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-ink/10 p-3">
            <h4 className="text-sm font-semibold">Settings</h4>
            <label className="block text-xs text-ink/70">
              Diff sensitivity ({settings.diffThreshold.toFixed(2)})
              <input type="range" min={0.05} max={0.4} step={0.01} value={settings.diffThreshold} onChange={(e) => setSettings((prev) => ({ ...prev, diffThreshold: Number(e.target.value) }))} className="w-full" />
            </label>
            <label className="block text-xs text-ink/70">
              Minimum region size ({(settings.minRegionAreaPct * 100).toFixed(3)}%)
              <input
                type="range"
                min={0}
                max={0.01}
                step={0.0001}
                value={settings.minRegionAreaPct}
                onChange={(e) => setSettings((prev) => ({ ...prev, minRegionAreaPct: Number(e.target.value) }))}
                className="w-full"
              />
            </label>
            <label className="block text-xs text-ink/70">
              Feather width ({settings.featherWidthPx}px)
              <input type="range" min={0} max={32} step={1} value={settings.featherWidthPx} onChange={(e) => setSettings((prev) => ({ ...prev, featherWidthPx: Number(e.target.value) }))} className="w-full" />
            </label>
            <label className="block text-xs text-ink/70">
              Boundary protection ({settings.boundaryProtectionWidthPx}px)
              <input
                type="range"
                min={0}
                max={32}
                step={1}
                value={settings.boundaryProtectionWidthPx}
                onChange={(e) => setSettings((prev) => ({ ...prev, boundaryProtectionWidthPx: Number(e.target.value) }))}
                className="w-full"
              />
            </label>
            <label className="block text-xs text-ink/70">
              Edge suppression
              <select
                className="mt-1 w-full rounded border border-ink/20 px-2 py-1 text-sm"
                value={settings.edgeSuppression}
                onChange={(e) => setSettings((prev) => ({ ...prev, edgeSuppression: e.target.value as QualitySettings["edgeSuppression"] }))}
              >
                <option value="off">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink/70">
              <input
                type="checkbox"
                checked={settings.useSeamlessCloneFallback}
                onChange={(e) => setSettings((prev) => ({ ...prev, useSeamlessCloneFallback: e.target.checked }))}
              />
              Use seamless blend fallback
            </label>
            <label className="flex items-center gap-2 text-xs text-ink/70">
              <input
                type="checkbox"
                checked={settings.autoDetectEditRegion}
                onChange={(e) => setSettings((prev) => ({ ...prev, autoDetectEditRegion: e.target.checked }))}
              />
              Auto-detect edit region if no source mask
            </label>
            <div className="flex flex-wrap gap-2">
              <button className="rounded border border-ink/20 bg-white px-3 py-2 text-sm" disabled={modalState === "analysing" || modalState === "reanalysing" || modalState === "applying"} onClick={() => void handleReanalyse()}>
                {modalState === "reanalysing" ? "Re-analysing..." : "Re-analyse"}
              </button>
              <button className="rounded border border-ink/20 bg-white px-3 py-2 text-sm" disabled={modalState === "analysing" || modalState === "reanalysing" || modalState === "applying"} onClick={() => void handleReset()}>
                Reset
              </button>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-ink/10 p-3">
            <h4 className="text-sm font-semibold">Mask Refinement</h4>
            <div className="flex flex-wrap items-center gap-2">
              <select className="rounded border border-ink/20 px-2 py-1 text-sm" value={toolMode} onChange={(e) => setToolMode(e.target.value as ToolMode)}>
                <option value="brush_add">Brush Add</option>
                <option value="brush_erase">Brush Erase</option>
                <option value="lasso_add">Lasso Add</option>
                <option value="lasso_subtract">Lasso Subtract</option>
              </select>
              <label className="text-xs text-ink/70">
                Brush
                <input type="range" min={4} max={64} step={1} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
              </label>
            </div>
            <div className="overflow-hidden rounded border border-ink/20 bg-bg">
              <canvas
                ref={editorCanvasRef}
                className="h-auto w-full cursor-crosshair"
                onPointerDown={onMaskPointerDown}
                onPointerMove={onMaskPointerMove}
                onPointerUp={onMaskPointerUp}
                onPointerLeave={onMaskPointerUp}
                onPointerCancel={onMaskPointerUp}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="rounded border border-ink/20 bg-white px-2 py-1 text-xs" onClick={() => runMaskOperation("fill_holes")}>
                Fill Hole
              </button>
              <button className="rounded border border-ink/20 bg-white px-2 py-1 text-xs" onClick={() => runMaskOperation("remove_speckles")}>
                Remove Speckles
              </button>
              <button className="rounded border border-ink/20 bg-white px-2 py-1 text-xs" onClick={() => runMaskOperation("grow")}>
                Grow Mask
              </button>
              <button className="rounded border border-ink/20 bg-white px-2 py-1 text-xs" onClick={() => runMaskOperation("shrink")}>
                Shrink Mask
              </button>
            </div>
            <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
              <p>
                Before: changed {analysis?.metrics.changedPctBefore ?? "n/a"}% | outside {analysis?.metrics.outsideLeakageBefore ?? "n/a"}%
              </p>
              <p>
                Preview: changed {analysis?.metrics.changedPctPreview ?? "n/a"}% | outside {analysis?.metrics.outsideLeakagePreview ?? "n/a"}%
              </p>
              {analysis?.warnings?.length ? (
                <ul className="mt-2 list-disc pl-4 text-[11px] text-amber-700">
                  {analysis.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
        </div>

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="rounded border border-ink/20 bg-white px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="rounded border border-ink/20 bg-white px-4 py-2 text-sm" onClick={() => void handleReset()}>
            Reset
          </button>
          <button
            className="rounded bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!analysisId || modalState === "analysing" || modalState === "reanalysing" || modalState === "applying"}
            onClick={() => void handleApply()}
          >
            {modalState === "applying" ? "Applying..." : "Apply and Replace Frame"}
          </button>
        </div>
      </div>
    </div>
  );
}

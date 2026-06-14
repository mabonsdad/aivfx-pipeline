import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../../api/client";
import { StatusNotice } from "../layout/UiFeedback";
import { useCleanupTrackStore, type CleanupPreviewMode } from "../../store/cleanupTrackStore";
import type { SegmentGeneration, TaskDetail, VideoCleanupSettings, VideoCleanupTrack } from "../../types/api";

type VideoCleanupModalProps = {
  isOpen: boolean;
  task: TaskDetail | undefined;
  generation: SegmentGeneration | null;
  onClose: () => void;
  onTrackJobId: (jobId: string) => void;
  refreshTask: () => Promise<void>;
  embedded?: boolean;
};

const DEFAULT_SETTINGS: VideoCleanupSettings = {
  maskFeatherPx: 6,
  maskHardness: 0.7,
  restoreStrength: 1.0,
  maskDilatePx: 0,
  maskErodePx: 0,
  temporalSmoothingRadius: 1,
  autoSuggestCorrections: true,
  suspiciousFrameThreshold: 0.12,
  previewBurnInMask: true,
  previewCheckerOutsideMask: false,
  clampToSegmentBounds: true,
  trackingDensity: "standard",
};

type PointMode = "none" | "positive" | "negative";

type CleanupStageSummary = {
  title: string;
  detail: string;
};

type MaskEditorTool = "brush_add" | "brush_erase" | "lasso_add" | "lasso_erase";

type MaskEditorStroke = {
  tool: MaskEditorTool;
  points: Array<{ x: number; y: number }>;
  last?: { x: number; y: number };
};

type MaskEditorBaseLayer = "generated" | "source";

type RuntimeEstimateInput = {
  frameCount: number;
  fpsNum: number;
  fpsDen: number;
  trackingDensity: VideoCleanupSettings["trackingDensity"];
};

type CleanupSyncAssessment = {
  variant: "info" | "warning" | "error";
  title: string;
  lines: string[];
};

function mergeSettings(track: VideoCleanupTrack | null, pending: Partial<VideoCleanupSettings>): VideoCleanupSettings {
  return {
    ...(track?.settings ?? DEFAULT_SETTINGS),
    ...pending,
  };
}

function trackingDensityLabel(trackingDensity: VideoCleanupSettings["trackingDensity"]): string {
  if (trackingDensity === "high_motion") return "High motion";
  if (trackingDensity === "frame_by_frame") return "Frame-by-frame";
  return "Standard";
}

function trackingDensityMultiplier(trackingDensity: VideoCleanupSettings["trackingDensity"]): number {
  if (trackingDensity === "high_motion") return 2.75;
  if (trackingDensity === "frame_by_frame") return 7.5;
  return 1;
}

function estimateCleanupRuntimeMinutes(input: RuntimeEstimateInput): { minMinutes: number; maxMinutes: number } {
  const { frameCount, fpsNum, fpsDen, trackingDensity } = input;
  const durationSec = (frameCount * fpsDen) / Math.max(1, fpsNum);
  const baselineRatio = Math.max(0.35, durationSec / 8);
  const densityMultiplier = trackingDensityMultiplier(trackingDensity);
  const minMinutes = Math.max(2, Math.round((6 * baselineRatio * densityMultiplier) * 10) / 10);
  const maxMinutes = Math.max(minMinutes + 1, Math.round((8 * baselineRatio * densityMultiplier) * 10) / 10);
  return { minMinutes, maxMinutes };
}

function formatFpsLabel(fps: { num: number; den: number } | null | undefined): string | null {
  if (!fps?.num || !fps?.den) return null;
  const value = fps.num / fps.den;
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}fps`;
}

function formatFrameAndSeconds(frameCount: number | null | undefined, fps: { num: number; den: number } | null | undefined): string | null {
  if (frameCount == null || frameCount < 0) return null;
  if (!fps?.num || !fps?.den) return `${frameCount} frames`;
  const fpsValue = fps.num / fps.den;
  if (!Number.isFinite(fpsValue) || fpsValue <= 0) return `${frameCount} frames`;
  return `${frameCount} frames / ${(frameCount / fpsValue).toFixed(2)}s`;
}

function assessCleanupSync(generation: SegmentGeneration | null): CleanupSyncAssessment | null {
  if (!generation) return null;
  const timing = generation.generationSettings?.sourceSegmentTiming ?? null;
  const stored = generation.generationSettings?.storedOutput ?? null;
  const analysis = generation.mergeAlignmentSuggestion?.suggestion?.analysis ?? null;
  const sourceOffset =
    generation.generationSettings?.timelineAlignment?.sourceFrameOffset ??
    generation.alignment?.sourceFrameOffset ??
    generation.sourceFrameOffset ??
    analysis?.sourceFrameOffset ??
    0;
  const startDrift = analysis?.earlyMedianDriftFrames ?? 0;
  const endDrift = analysis?.lateMedianDriftFrames ?? 0;
  const residualEnd = analysis?.residualEndFrames ?? 0;
  const sourceTiming = formatFrameAndSeconds(timing?.durationFrames, timing?.fps ?? null);
  const outputTiming = formatFrameAndSeconds(stored?.frameCount, stored?.fps ?? null);
  const sourceFps = formatFpsLabel(timing?.fps ?? null);
  const outputFps = formatFpsLabel(stored?.fps ?? null);
  const timingLineParts = [sourceTiming ? `source ${sourceTiming}` : null, outputTiming ? `output ${outputTiming}` : null].filter(Boolean);
  const fpsLineParts = [sourceFps ? `source ${sourceFps}` : null, outputFps ? `output ${outputFps}` : null].filter(Boolean);

  if (!analysis) {
    return {
      variant: "warning",
      title: "Timing has not been checked yet",
      lines: [
        "Run Suggest alignment in Post Process before cleanup if the model may have dropped opening frames or drifted by the end of the clip.",
        ...(timingLineParts.length ? [timingLineParts.join(" · ")] : []),
        ...(fpsLineParts.length ? [fpsLineParts.join(" · ")] : []),
        "Cleanup restores source pixels outside the tracked keep region. It does not correct timing drift.",
      ],
    };
  }

  const alignmentLine = `Start offset ${sourceOffset >= 0 ? `+${sourceOffset}` : sourceOffset}f · early drift ${startDrift >= 0 ? `+${startDrift}` : startDrift}f · late drift ${endDrift >= 0 ? `+${endDrift}` : endDrift}f`;
  const residualLine = `End residual ${residualEnd >= 0 ? `+${residualEnd}` : residualEnd}f · suggested playback ${(analysis.suggestedPlaybackRate ?? 1).toFixed(4)}x`;

  if (analysis.recommendation === "rerender_recommended") {
    return {
      variant: "error",
      title: "Timing should be fixed before cleanup",
      lines: [
        alignmentLine,
        residualLine,
        ...(timingLineParts.length ? [timingLineParts.join(" · ")] : []),
        "Merge analysis recommends rerendering. Cleanup will not solve drift or unstable timing through the shot.",
      ],
    };
  }

  if (
    analysis.recommendation === "retime_recommended" ||
    analysis.recommendation === "piecewise_reconcile_recommended" ||
    Math.abs(endDrift) > 1 ||
    Math.abs(residualEnd) > 1
  ) {
    return {
      variant: "warning",
      title: "Timing is drifting across the clip",
      lines: [
        alignmentLine,
        residualLine,
        ...(timingLineParts.length ? [timingLineParts.join(" · ")] : []),
        analysis.recommendation === "piecewise_reconcile_recommended"
          ? "Uniform retime is unlikely to be enough here. Cleanup should wait until timing is reconciled more locally across the shot."
          : "Use merge alignment or uniform retime first. Cleanup should come after timing is close enough.",
      ],
    };
  }

  return {
    variant: "info",
    title: "Timing looks close enough for cleanup",
    lines: [
      alignmentLine,
      ...(timingLineParts.length ? [timingLineParts.join(" · ")] : []),
      ...(fpsLineParts.length ? [fpsLineParts.join(" · ")] : []),
      "Cleanup can now focus on restoring source pixels outside the tracked keep region rather than trying to hide temporal issues.",
    ],
  };
}

function cleanupStageSummary(track: VideoCleanupTrack | null): CleanupStageSummary | null {
  if (!track) return null;
  const densityLabel = trackingDensityLabel(track.settings.trackingDensity);
  if (track.status === "preparing") {
    return {
      title: "Preparing clips",
      detail: `${densityLabel} tracking selected. Extracting source and generated frames, normalising inputs, and staging the seed keep mask.`,
    };
  }
  if (track.status === "tracking") {
    return {
      title: "Tracking keep mask",
      detail: `${densityLabel} tracking is running SAM on anchor frames, then filling the rest of the clip from those tracked masks.`,
    };
  }
  if (track.status === "applying") {
    return {
      title: "Rendering cleaned output",
      detail: "Compositing generated content inside the keep mask and restoring original pixels outside it.",
    };
  }
  return null;
}

function isLassoTool(tool: MaskEditorTool): boolean {
  return tool === "lasso_add" || tool === "lasso_erase";
}

function toolOperation(tool: MaskEditorTool): "add" | "erase" {
  return tool === "brush_erase" || tool === "lasso_erase" ? "erase" : "add";
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Unable to encode mask image"));
    }, type);
  });
}

async function loadBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load image (${response.status})`);
  }
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

function ToolRailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-14 w-14 items-center justify-center rounded-2xl border transition ${
        active ? "border-accent bg-accent text-white shadow-sm" : "border-ink/10 bg-white text-ink/70 hover:bg-bg"
      }`}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function IconBrush({ mode }: { mode: "add" | "subtract" }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14.5 4.5 19.5 9.5" />
      <path d="M6 18c0-1.8 1.2-3 3-3h1.5l8-8a2.1 2.1 0 0 0-3-3l-8 8V13c0 1.8-1.2 3-3 3-1 0-1.8.4-2.5 1.1C1.4 17.8 1 18.7 1 20c1.4-.7 2.8-1 5-1Z" />
      {mode === "add" ? <path d="M19 15v6M16 18h6" /> : <path d="M16 18h6" />}
    </svg>
  );
}

function IconLasso({ mode }: { mode: "add" | "subtract" }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 4.5c-3.3 0-6 2.5-6 5.5 0 2.8 2.4 5.1 5.5 5.5" />
      <path d="M8 4.5c4.8 0 9 2.8 9 6.5 0 2.2-1.5 4-3.8 5" />
      <path d="M7.5 15.5 10 18l-2.5 2.5L5 18l2.5-2.5Z" />
      {mode === "add" ? <path d="M17 15v6M14 18h6" /> : <path d="M14 18h6" />}
    </svg>
  );
}

export default function VideoCleanupModal({
  isOpen,
  task,
  generation,
  onClose,
  onTrackJobId,
  refreshTask,
  embedded = false,
}: VideoCleanupModalProps) {
  const {
    selectedFrameIndexLocal,
    setSelectedFrameIndexLocal,
    previewMode,
    setPreviewMode,
    isSavingCorrection,
    setIsSavingCorrection,
    isApplying,
    setIsApplying,
    pendingSettings,
    setPendingSettings,
    reset,
  } = useCleanupTrackStore();
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string>("");
  const [pointMode, setPointMode] = useState<PointMode>("none");
  const [positivePoints, setPositivePoints] = useState<Array<{ x: number; y: number }>>([]);
  const [negativePoints, setNegativePoints] = useState<Array<{ x: number; y: number }>>([]);
  const [uiError, setUiError] = useState<string | null>(null);
  const frameImageRef = useRef<HTMLImageElement | null>(null);
  const [isMaskEditorOpen, setMaskEditorOpen] = useState(false);
  const [maskEditorTool, setMaskEditorTool] = useState<MaskEditorTool>("brush_add");
  const [maskBrushSize, setMaskBrushSize] = useState(24);
  const [isMaskEditorLoading, setMaskEditorLoading] = useState(false);
  const [isMaskEditorDirty, setMaskEditorDirty] = useState(false);
  const [isMaskEditorSaving, setMaskEditorSaving] = useState(false);
  const [maskEditorBaseLayer, setMaskEditorBaseLayer] = useState<MaskEditorBaseLayer>("generated");
  const [editorStatusMessage, setEditorStatusMessage] = useState<string | null>(null);
  const [pendingCorrectionFrame, setPendingCorrectionFrame] = useState<number | null>(null);
  const [deletingTrackId, setDeletingTrackId] = useState<string | null>(null);
  const maskEditorImageRef = useRef<HTMLImageElement | null>(null);
  const maskEditorOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const maskEditorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskEditorStrokeRef = useRef<MaskEditorStroke | null>(null);

  const segment = useMemo(
    () => (generation ? task?.segments.find((item) => item.segmentId === generation.segmentId) ?? null : null),
    [generation, task?.segments],
  );

  const matchingTracks = useMemo(
    () =>
      [...(task?.videoCleanupTracks ?? [])]
        .filter((item) => item.generationId === generation?.genId)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [generation?.genId, task?.videoCleanupTracks],
  );

  const availableAnalyses = useMemo(() => {
    if (!task || !segment) return [];
    const values = Object.values(task.qualityMatchAnalyses ?? {});
    const preferredVariantId = generation?.sourceFirstFrameVariantId ?? null;
    return values
      .filter((analysis) => analysis.frameId === segment.startFrameId)
      .filter((analysis) => !preferredVariantId || analysis.variantId === preferredVariantId || analysis.artifacts?.finalKey || analysis.artifacts?.proposedMergeMaskKey)
      .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime());
  }, [generation?.sourceFirstFrameVariantId, segment, task]);

  useEffect(() => {
    if (!isOpen) {
      reset();
      setActiveTrackId(null);
      setSelectedAnalysisId("");
      setPointMode("none");
      setPositivePoints([]);
      setNegativePoints([]);
      setUiError(null);
      setEditorStatusMessage(null);
      setPendingCorrectionFrame(null);
      setMaskEditorBaseLayer("generated");
      return;
    }
    setActiveTrackId((previous) => previous ?? matchingTracks[0]?.trackId ?? null);
    setSelectedAnalysisId((previous) => previous || availableAnalyses[0]?.analysisId || "");
  }, [availableAnalyses, isOpen, matchingTracks, reset]);

  const activeTrackQuery = useQuery({
    queryKey: ["video-cleanup-track", task?.taskId, activeTrackId],
    queryFn: async () => {
      if (!task?.taskId || !activeTrackId) throw new Error("Cleanup track unavailable");
      const response = await apiClient.getVideoCleanupTrack(task.taskId, activeTrackId);
      return response.track;
    },
    enabled: isOpen && !!task?.taskId && !!activeTrackId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["created", "preparing", "tracking", "applying"].includes(status) ? 4000 : false;
    },
    staleTime: 2000,
    refetchOnWindowFocus: false,
  });

  const activeTrack = activeTrackQuery.data ?? matchingTracks.find((item) => item.trackId === activeTrackId) ?? null;
  const effectiveSettings = mergeSettings(activeTrack, pendingSettings);
  const manifestFrames = activeTrack?.review.previewManifest?.frames ?? [];
  const selectedManifestFrame = manifestFrames[selectedFrameIndexLocal] ?? manifestFrames[0] ?? null;
  const runtimeEstimate = useMemo(
    () =>
      estimateCleanupRuntimeMinutes({
        frameCount: activeTrack?.source.frameCount ?? segment?.durationFrames ?? 192,
        fpsNum: activeTrack?.source.fpsNum ?? task?.video.editSource?.fps.num ?? 24,
        fpsDen: activeTrack?.source.fpsDen ?? task?.video.editSource?.fps.den ?? 1,
        trackingDensity: activeTrack?.settings.trackingDensity ?? effectiveSettings.trackingDensity,
      }),
    [activeTrack?.settings.trackingDensity, activeTrack?.source.fpsDen, activeTrack?.source.fpsNum, activeTrack?.source.frameCount, effectiveSettings.trackingDensity, segment?.durationFrames, task?.video.editSource?.fps.den, task?.video.editSource?.fps.num],
  );
  const stageSummary = useMemo(() => cleanupStageSummary(activeTrack), [activeTrack]);
  const syncAssessment = useMemo(() => assessCleanupSync(generation), [generation]);
  const maskEditorBaseImageUrl = useMemo(() => {
    if (!selectedManifestFrame) return null;
    if (maskEditorBaseLayer === "source") {
      return selectedManifestFrame.sourceFrameUrl ?? selectedManifestFrame.generatedFrameUrl ?? null;
    }
    return selectedManifestFrame.generatedFrameUrl ?? selectedManifestFrame.sourceFrameUrl ?? null;
  }, [maskEditorBaseLayer, selectedManifestFrame]);

  useEffect(() => {
    if (!activeTrack) return;
    setPendingSettings(activeTrack.settings);
    const frameCount = activeTrack.review.previewManifest?.frameCount ?? activeTrack.source.frameCount ?? 1;
    if (selectedFrameIndexLocal >= frameCount) {
      setSelectedFrameIndexLocal(0);
    }
  }, [activeTrack?.trackId, selectedFrameIndexLocal, setPendingSettings, setSelectedFrameIndexLocal]);

  useEffect(() => {
    if (pendingCorrectionFrame === null || !activeTrack) return;
    if (activeTrack.status === "review_ready") {
      setEditorStatusMessage(`Correction applied to Check ${pendingCorrectionFrame + 1}. Local masks and preview frames have been regenerated.`);
      setPendingCorrectionFrame(null);
    }
  }, [activeTrack, pendingCorrectionFrame]);

  const reviewVideoUrl = useMemo(() => {
    if (!activeTrack) return null;
    if (previewMode === "generated") return activeTrack.review.generatedPreviewUrl ?? activeTrack.review.previewVideoUrl ?? generation?.downloadUrl ?? null;
    if (previewMode === "overlay") return activeTrack.review.overlayStripUrl ?? activeTrack.review.previewVideoUrl ?? null;
    if (previewMode === "checker") return activeTrack.review.checkerVideoUrl ?? activeTrack.review.previewVideoUrl ?? null;
    return activeTrack.review.cleanedPreviewUrl ?? activeTrack.review.previewVideoUrl ?? null;
  }, [activeTrack, generation?.downloadUrl, previewMode]);

  const selectedFrameUrl = useMemo(() => {
    if (!selectedManifestFrame) return null;
    if (previewMode === "generated") return selectedManifestFrame.generatedFrameUrl ?? null;
    if (previewMode === "overlay") return selectedManifestFrame.overlayUrl ?? null;
    if (previewMode === "checker") return selectedManifestFrame.checkerUrl ?? null;
    return selectedManifestFrame.cleanedUrl ?? null;
  }, [previewMode, selectedManifestFrame]);

  function refreshMaskEditorOverlay(previewPoints: Array<{ x: number; y: number }> = []) {
    const overlayCanvas = maskEditorOverlayRef.current;
    const maskCanvas = maskEditorCanvasRef.current;
    const image = maskEditorImageRef.current;
    if (!overlayCanvas || !maskCanvas || !image) return;
    const bounds = image.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
      overlayCanvas.width = width;
      overlayCanvas.height = height;
    }
    const context = overlayCanvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.save();
    context.fillStyle = "rgba(46, 214, 126, 0.28)";
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(maskCanvas, 0, 0, width, height);
    context.restore();
    context.save();
    context.globalAlpha = 0.85;
    context.strokeStyle = "rgba(14, 119, 92, 0.95)";
    context.lineWidth = 2;
    context.drawImage(maskCanvas, 0, 0, width, height);
    context.restore();
    if (previewPoints.length >= 2) {
      context.save();
      context.strokeStyle = "rgba(34, 34, 34, 0.9)";
      context.fillStyle = "rgba(34, 34, 34, 0.16)";
      context.lineWidth = 2;
      context.setLineDash([8, 6]);
      context.beginPath();
      context.moveTo(previewPoints[0].x, previewPoints[0].y);
      for (const point of previewPoints.slice(1)) {
        context.lineTo(point.x, point.y);
      }
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
    }
  }

  async function loadMaskEditor() {
    if (!selectedManifestFrame?.generatedFrameUrl) return;
    setMaskEditorLoading(true);
    setUiError(null);
    try {
      const generatedBitmap = await loadBitmap(selectedManifestFrame.generatedFrameUrl);
      const maskCanvas = maskEditorCanvasRef.current;
      if (!maskCanvas) return;
      maskCanvas.width = generatedBitmap.width;
      maskCanvas.height = generatedBitmap.height;
      const context = maskCanvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      if (selectedManifestFrame.maskUrl) {
        const maskBitmap = await loadBitmap(selectedManifestFrame.maskUrl);
        context.drawImage(maskBitmap, 0, 0, maskCanvas.width, maskCanvas.height);
        maskBitmap.close();
      }
      generatedBitmap.close();
      setMaskEditorDirty(false);
      window.requestAnimationFrame(() => refreshMaskEditorOverlay());
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to load cleanup mask editor");
    } finally {
      setMaskEditorLoading(false);
    }
  }

  function maskEditorPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number; displayX: number; displayY: number } | null {
    const overlayCanvas = maskEditorOverlayRef.current;
    const maskCanvas = maskEditorCanvasRef.current;
    if (!overlayCanvas || !maskCanvas) return null;
    const bounds = overlayCanvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const displayX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const displayY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    const scaleX = maskCanvas.width / bounds.width;
    const scaleY = maskCanvas.height / bounds.height;
    return {
      x: displayX * scaleX,
      y: displayY * scaleY,
      displayX,
      displayY,
    };
  }

  function applyMaskStroke(x: number, y: number, previous: { x: number; y: number } | undefined, operation: "add" | "erase") {
    const maskCanvas = maskEditorCanvasRef.current;
    if (!maskCanvas) return;
    const context = maskCanvas.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation = operation === "erase" ? "destination-out" : "source-over";
    context.fillStyle = "rgba(255,255,255,1)";
    context.strokeStyle = "rgba(255,255,255,1)";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = maskBrushSize;
    if (previous) {
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(x, y);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(x, y, maskBrushSize / 2, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  function applyMaskLasso(points: Array<{ x: number; y: number }>, operation: "add" | "erase") {
    if (points.length < 3) return;
    const maskCanvas = maskEditorCanvasRef.current;
    if (!maskCanvas) return;
    const context = maskCanvas.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation = operation === "erase" ? "destination-out" : "source-over";
    context.fillStyle = "rgba(255,255,255,1)";
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.closePath();
    context.fill();
    context.restore();
  }

  function openMaskEditor() {
    setMaskEditorBaseLayer("generated");
    setMaskEditorOpen(true);
  }

  async function saveMaskEditor() {
    if (!task?.taskId || !activeTrack || !maskEditorCanvasRef.current) return;
    setUiError(null);
    setEditorStatusMessage(null);
    setMaskEditorSaving(true);
    setIsSavingCorrection(true);
    try {
      const maskBlob = await canvasToBlob(maskEditorCanvasRef.current, "image/png");
      const init = await apiClient.initVideoCleanupKeyframeUpload(task.taskId, activeTrack.trackId, {
        frameIndexLocal: selectedFrameIndexLocal,
        filename: `cleanup-mask-${selectedFrameIndexLocal.toString().padStart(4, "0")}.png`,
        contentType: "image/png",
      });
      const uploaded = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: maskBlob,
      });
      if (!uploaded.ok) {
        throw new Error(`Mask upload failed (${uploaded.status})`);
      }
      const completed = await apiClient.completeVideoCleanupKeyframeUpload(task.taskId, activeTrack.trackId, {
        frameIndexLocal: selectedFrameIndexLocal,
        uploadKey: init.uploadKey,
        propagationMode: "windowed",
      });
      onTrackJobId(completed.jobId);
      setPendingCorrectionFrame(selectedFrameIndexLocal);
      setEditorStatusMessage(`Saved Check ${selectedFrameIndexLocal + 1}. Re-tracking the local window around this frame now.`);
      setMaskEditorOpen(false);
      setMaskEditorDirty(false);
      await refreshTask();
      await activeTrackQuery.refetch();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to save corrected mask");
    } finally {
      setMaskEditorSaving(false);
      setIsSavingCorrection(false);
    }
  }

  useEffect(() => {
    if (!isMaskEditorOpen) return;
    void loadMaskEditor();
  }, [isMaskEditorOpen, selectedManifestFrame?.frameIndexLocal, selectedManifestFrame?.maskUrl, selectedManifestFrame?.generatedFrameUrl]);

  async function handleCreateTrack() {
    if (!task?.taskId || !generation || !segment || !selectedAnalysisId) return;
    setUiError(null);
    try {
      const created = await apiClient.createVideoCleanupTrack(task.taskId, segment.segmentId, generation.genId, {
        firstMaskSource: {
          type: "quality_match_analysis",
          analysisId: selectedAnalysisId,
        },
        settings: effectiveSettings,
      });
      setActiveTrackId(created.trackId);
      onTrackJobId(created.jobId);
      await refreshTask();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to create cleanup track");
    }
  }

  async function handleSamAssist() {
    if (!task?.taskId || !activeTrack) return;
    if (positivePoints.length === 0 && negativePoints.length === 0) {
      setUiError("Add one or more positive or negative points first.");
      return;
    }
    setUiError(null);
    setEditorStatusMessage(null);
    setIsSavingCorrection(true);
    try {
      const queued = await apiClient.samAssistVideoCleanupTrack(task.taskId, activeTrack.trackId, {
        frameIndexLocal: selectedFrameIndexLocal,
        positivePoints,
        negativePoints,
        existingMaskKey: selectedManifestFrame?.maskKey,
        restrictToMaskBounds: true,
        edgeBias: "balanced",
        propagationMode: "windowed",
      });
      onTrackJobId(queued.jobId);
      setPendingCorrectionFrame(selectedFrameIndexLocal);
      setEditorStatusMessage(`Running SAM assist on Check ${selectedFrameIndexLocal + 1} and re-tracking the nearby frames.`);
      setPositivePoints([]);
      setNegativePoints([]);
      await refreshTask();
      await activeTrackQuery.refetch();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to run SAM assist");
    } finally {
      setIsSavingCorrection(false);
    }
  }

  async function handleRefreshPreview() {
    if (!task?.taskId || !activeTrack) return;
    setUiError(null);
    try {
      const queued = await apiClient.previewVideoCleanupTrack(task.taskId, activeTrack.trackId, {
        settings: effectiveSettings,
      });
      onTrackJobId(queued.jobId);
      await refreshTask();
      await activeTrackQuery.refetch();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to refresh cleanup preview");
    }
  }

  async function handleApply() {
    if (!task?.taskId || !activeTrack) return;
    setUiError(null);
    setIsApplying(true);
    try {
      const queued = await apiClient.applyVideoCleanupTrack(task.taskId, activeTrack.trackId, {
        settings: effectiveSettings,
        createSegmentGenerationVariant: true,
      });
      onTrackJobId(queued.jobId);
      await refreshTask();
      await activeTrackQuery.refetch();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to apply cleanup");
    } finally {
      setIsApplying(false);
    }
  }

  async function handleDeleteTrack(trackId: string) {
    if (!task?.taskId) return;
    const confirmed = window.confirm("Delete this cleanup track and all of its generated cleanup assets?");
    if (!confirmed) return;
    setUiError(null);
    setDeletingTrackId(trackId);
    try {
      await apiClient.deleteVideoCleanupTrack(task.taskId, trackId);
      if (activeTrackId === trackId) {
        const nextTrack = matchingTracks.find((item) => item.trackId !== trackId) ?? null;
        setActiveTrackId(nextTrack?.trackId ?? null);
      }
      await refreshTask();
      await activeTrackQuery.refetch();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to delete cleanup track");
    } finally {
      setDeletingTrackId(null);
    }
  }

  function handleFrameClick(event: React.MouseEvent<HTMLImageElement>) {
    if (pointMode === "none") return;
    const element = frameImageRef.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const scaleX = element.naturalWidth / Math.max(1, bounds.width);
    const scaleY = element.naturalHeight / Math.max(1, bounds.height);
    const point = {
      x: Math.max(0, Math.round((event.clientX - bounds.left) * scaleX)),
      y: Math.max(0, Math.round((event.clientY - bounds.top) * scaleY)),
    };
    if (pointMode === "positive") {
      setPositivePoints((previous) => [...previous, point].slice(-16));
    } else {
      setNegativePoints((previous) => [...previous, point].slice(-16));
    }
  }

  function handleMaskEditorPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = maskEditorPoint(event);
    const overlayCanvas = maskEditorOverlayRef.current;
    if (!point || !overlayCanvas) return;
    overlayCanvas.setPointerCapture(event.pointerId);
    const stroke: MaskEditorStroke = {
      tool: maskEditorTool,
      points: [{ x: point.x, y: point.y }],
      last: { x: point.x, y: point.y },
    };
    maskEditorStrokeRef.current = stroke;
    if (isLassoTool(maskEditorTool)) {
      refreshMaskEditorOverlay([{ x: point.displayX, y: point.displayY }]);
      return;
    }
    applyMaskStroke(point.x, point.y, undefined, toolOperation(maskEditorTool));
    setMaskEditorDirty(true);
    refreshMaskEditorOverlay();
  }

  function handleMaskEditorPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = maskEditorPoint(event);
    const stroke = maskEditorStrokeRef.current;
    if (!point || !stroke) return;
    if (isLassoTool(stroke.tool)) {
      const nextPoints = [...stroke.points, { x: point.x, y: point.y }];
      maskEditorStrokeRef.current = { ...stroke, points: nextPoints, last: { x: point.x, y: point.y } };
      const overlayCanvas = maskEditorOverlayRef.current;
      if (!overlayCanvas) return;
      const bounds = overlayCanvas.getBoundingClientRect();
      const displayPoints = nextPoints.map((entry) => ({
        x: (entry.x / Math.max(1, maskEditorCanvasRef.current?.width ?? 1)) * bounds.width,
        y: (entry.y / Math.max(1, maskEditorCanvasRef.current?.height ?? 1)) * bounds.height,
      }));
      refreshMaskEditorOverlay(displayPoints);
      return;
    }
    applyMaskStroke(point.x, point.y, stroke.last, toolOperation(stroke.tool));
    maskEditorStrokeRef.current = { ...stroke, last: { x: point.x, y: point.y }, points: [...stroke.points, { x: point.x, y: point.y }] };
    setMaskEditorDirty(true);
    refreshMaskEditorOverlay();
  }

  function handleMaskEditorPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const overlayCanvas = maskEditorOverlayRef.current;
    if (overlayCanvas?.hasPointerCapture(event.pointerId)) {
      overlayCanvas.releasePointerCapture(event.pointerId);
    }
    const stroke = maskEditorStrokeRef.current;
    if (!stroke) return;
    if (isLassoTool(stroke.tool)) {
      applyMaskLasso(stroke.points, toolOperation(stroke.tool));
      setMaskEditorDirty(true);
    }
    maskEditorStrokeRef.current = null;
    refreshMaskEditorOverlay();
  }

  if ((!isOpen && !embedded) || !generation || !task) return null;

  const cleanupLayoutClass = embedded
    ? "grid min-h-0 flex-1 gap-0 xl:grid-cols-[260px_minmax(0,1fr)]"
    : "grid min-h-0 flex-1 gap-0 lg:grid-cols-[300px_minmax(0,1fr)_340px]";

  const content = (
      <div className={`${embedded ? "relative flex min-h-[68vh] w-full flex-col overflow-hidden rounded-2xl border border-ink/15 bg-card text-ink" : "relative flex h-[92vh] w-[min(1400px,96vw)] flex-col overflow-hidden rounded-2xl border border-ink/15 bg-card text-ink"}`} onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-ink/10 px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-ink/45">Post Process Cleanup</p>
            <h3 className="text-xl font-semibold">Tracked keep-mask cleanup for {generation.luma.model}</h3>
            <p className="text-sm text-ink/60">Best used after extension or stitch review, once timing is close enough. This tool restores source pixels outside the tracked keep region; it does not fix motion drift.</p>
          </div>
          {!embedded ? (
            <button type="button" className="rounded-full border border-ink/15 px-3 py-1.5 text-sm text-ink/70 hover:bg-bg" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>

        <div className={cleanupLayoutClass}>
          <aside className="overflow-y-auto border-r border-ink/10 bg-bg/55 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">Tracks</p>
            <div className="mt-3 space-y-2">
              {matchingTracks.map((track) => {
                const isActive = track.trackId === activeTrackId;
                return (
                  <div
                    key={track.trackId}
                    className={`rounded-xl border px-3 py-3 ${isActive ? "border-accent/35 bg-white shadow-sm" : "border-ink/10 bg-white"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        className="block min-w-0 flex-1 text-left"
                        onClick={() => setActiveTrackId(track.trackId)}
                      >
                        <p className="text-sm font-semibold">Track {track.trackId.slice(-6)}</p>
                        <p className="mt-1 text-xs uppercase text-ink/50">{track.status.replace(/_/g, " ")}</p>
                        <p className="mt-1 text-[11px] text-ink/55">{new Date(track.updatedAt).toLocaleString()}</p>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={deletingTrackId === track.trackId}
                        onClick={() => void handleDeleteTrack(track.trackId)}
                      >
                        {deletingTrackId === track.trackId ? "Deleting" : "Delete"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 rounded-xl border border-ink/10 bg-white p-3">
              <p className="text-sm font-semibold">Create cleanup track</p>
              <p className="mt-1 text-xs text-ink/60">Seed from a start-frame Quality Match analysis, then track that keep region through the chosen output.</p>
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-medium text-ink/55">Tracking density</span>
                <select
                  className="w-full rounded-md border border-ink/15 bg-white px-3 py-2 text-sm"
                  value={effectiveSettings.trackingDensity}
                  onChange={(event) =>
                    setPendingSettings((previous) => ({
                      ...previous,
                      trackingDensity: event.target.value as VideoCleanupSettings["trackingDensity"],
                    }))
                  }
                >
                  <option value="standard">Standard</option>
                  <option value="high_motion">High motion</option>
                  <option value="frame_by_frame">Frame-by-frame</option>
                </select>
              </label>
              <p className="mt-2 text-xs text-ink/60">
                {effectiveSettings.trackingDensity === "standard"
                  ? "Best default for normal motion. Uses sparse SAM anchors with interpolation between them."
                  : effectiveSettings.trackingDensity === "high_motion"
                    ? "Use denser SAM anchors for quicker movement and more complex shape changes. Processing time is roughly 2-3x longer."
                    : "Runs SAM on every frame. Best for very rapid or complex motion, but this is much slower."}
              </p>
              <select
                className="mt-3 w-full rounded-md border border-ink/15 bg-white px-3 py-2 text-sm"
                value={selectedAnalysisId}
                onChange={(event) => setSelectedAnalysisId(event.target.value)}
              >
                {availableAnalyses.length === 0 ? <option value="">No compatible Quality Match analyses found</option> : null}
                {availableAnalyses.map((analysis) => (
                  <option key={analysis.analysisId} value={analysis.analysisId}>
                    {analysis.analysisId.slice(-6)} · {analysis.variantId.slice(-6)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="mt-3 w-full rounded-md bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedAnalysisId}
                onClick={() => void handleCreateTrack()}
              >
                Create Cleanup Track
              </button>
              <p className="mt-2 text-xs text-ink/55">
                Estimated runtime for this clip: {runtimeEstimate.minMinutes}-{runtimeEstimate.maxMinutes} minutes with {trackingDensityLabel(effectiveSettings.trackingDensity).toLowerCase()} tracking.
              </p>
              <p className="mt-2 text-xs text-ink/55">
                Current implementation seeds from the start frame only. If the clip has opening-frame drop or accumulating drift, resolve timing first rather than forcing cleanup to absorb it.
              </p>
            </div>

            {uiError ? <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{uiError}</p> : null}
            {editorStatusMessage ? <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{editorStatusMessage}</p> : null}
            {activeTrack?.status === "failed" && activeTrack.error ? (
              <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{activeTrack.error}</p>
            ) : null}
          </aside>

          <main className="min-h-0 overflow-y-auto p-5">
            {!activeTrack ? (
              <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-ink/15 bg-bg text-sm text-ink/60">
                Create or select a cleanup track to review mask propagation.
              </div>
            ) : (
              <div className="space-y-4">
                {syncAssessment ? (
                  <StatusNotice variant={syncAssessment.variant} title={syncAssessment.title}>
                    <div className="space-y-1.5">
                      {syncAssessment.lines.map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </div>
                  </StatusNotice>
                ) : null}
                {stageSummary ? (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p className="font-semibold">{stageSummary.title}</p>
                    <p className="mt-1 text-sm text-amber-800">{stageSummary.detail}</p>
                    <p className="mt-2 text-xs text-amber-700">
                      Standard tracking on a short clip usually takes a few minutes. This {trackingDensityLabel(activeTrack.settings.trackingDensity).toLowerCase()} track is estimated at roughly {runtimeEstimate.minMinutes}-{runtimeEstimate.maxMinutes} minutes.
                    </p>
                  </div>
                ) : null}
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {(["generated", "overlay", "checker", "cleaned"] as CleanupPreviewMode[]).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`rounded-full px-3 py-1.5 text-xs font-medium ${previewMode === mode ? "bg-accent text-white" : "bg-bg text-ink/70"}`}
                          onClick={() => setPreviewMode(mode)}
                        >
                          {mode}
                        </button>
                      ))}
                      <span className="ml-auto rounded-full bg-bg px-3 py-1 text-xs uppercase tracking-[0.18em] text-ink/45">{activeTrack.status.replace(/_/g, " ")}</span>
                    </div>

                    {reviewVideoUrl ? (
                      <video
                        key={`${activeTrack.trackId}:${previewMode}:${reviewVideoUrl}`}
                        src={reviewVideoUrl}
                        controls
                        className="aspect-video w-full rounded-2xl border border-ink/10 bg-black object-contain"
                      />
                    ) : (
                      <div className="flex aspect-video items-center justify-center rounded-2xl border border-dashed border-ink/15 bg-bg text-sm text-ink/60">
                        {stageSummary ? `${stageSummary.title}. Preview video will appear when this stage finishes.` : "Preview video will appear after tracking completes."}
                      </div>
                    )}

                    {selectedFrameUrl ? (
                      <div className="rounded-2xl border border-ink/10 bg-white p-3">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">Frame {selectedFrameIndexLocal + 1}</p>
                            <p className="text-xs text-ink/60">
                              Coverage {selectedManifestFrame?.coveragePct?.toFixed(2) ?? "n/a"}% · Suspicion {selectedManifestFrame?.suspicionScore?.toFixed(3) ?? "n/a"}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" className={`rounded-md px-2 py-1 text-xs ${pointMode === "positive" ? "bg-emerald-600 text-white" : "bg-bg text-ink/70"}`} onClick={() => setPointMode((current) => (current === "positive" ? "none" : "positive"))}>
                              + point
                            </button>
                            <button type="button" className={`rounded-md px-2 py-1 text-xs ${pointMode === "negative" ? "bg-rose-600 text-white" : "bg-bg text-ink/70"}`} onClick={() => setPointMode((current) => (current === "negative" ? "none" : "negative"))}>
                              - point
                            </button>
                            <button type="button" className="rounded-md bg-bg px-2 py-1 text-xs text-ink/70" onClick={() => { setPositivePoints([]); setNegativePoints([]); }}>
                              Clear points
                            </button>
                          </div>
                        </div>
                        <img
                          ref={frameImageRef}
                          src={selectedFrameUrl}
                          alt={`Cleanup frame ${selectedFrameIndexLocal + 1}`}
                          className={`max-h-[52vh] w-full rounded-xl border border-ink/10 object-contain ${pointMode === "none" ? "" : "cursor-crosshair"}`}
                          onClick={handleFrameClick}
                        />
                        <div className="mt-3 flex flex-wrap gap-2 text-xs">
                          {positivePoints.map((point, index) => (
                            <span key={`p-${index}-${point.x}-${point.y}`} className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-700">
                              + {point.x}, {point.y}
                            </span>
                          ))}
                          {negativePoints.map((point, index) => (
                            <span key={`n-${index}-${point.x}-${point.y}`} className="rounded-full bg-rose-100 px-2 py-1 text-rose-700">
                              - {point.x}, {point.y}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {manifestFrames.length > 1 ? (
                      <div className="rounded-2xl border border-ink/10 bg-white p-3">
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, manifestFrames.length - 1)}
                          value={selectedFrameIndexLocal}
                          onChange={(event) => setSelectedFrameIndexLocal(Number(event.target.value))}
                          className="w-full"
                        />
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(activeTrack.review.suggestedCorrectionFrames ?? []).slice(0, 12).map((frameIndex) => (
                            <button
                              key={frameIndex}
                              type="button"
                              className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800"
                              onClick={() => setSelectedFrameIndexLocal(frameIndex)}
                            >
                              Check {frameIndex + 1}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-ink/10 bg-white p-4">
                    <p className="text-sm font-semibold">Selected frame references</p>
                    <div className="mt-3 grid gap-3">
                      {selectedManifestFrame?.generatedFrameUrl ? (
                        <div>
                          <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-ink/45">Generated</p>
                          <img src={selectedManifestFrame.generatedFrameUrl} alt="Generated frame" className="w-full rounded-lg border border-ink/10 object-contain" />
                        </div>
                      ) : null}
                      {selectedManifestFrame?.sourceFrameUrl ? (
                        <div>
                          <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-ink/45">Source</p>
                          <img src={selectedManifestFrame.sourceFrameUrl} alt="Source frame" className="w-full rounded-lg border border-ink/10 object-contain" />
                        </div>
                      ) : null}
                      {selectedManifestFrame?.maskUrl ? (
                        <div>
                          <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-ink/45">Tracked mask</p>
                          <img src={selectedManifestFrame.maskUrl} alt="Mask frame" className="w-full rounded-lg border border-ink/10 bg-white object-contain" />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </main>

          <aside className="overflow-y-auto border-l border-ink/10 bg-bg/55 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">Tune & Correct</p>
            <div className="mt-4 space-y-4">
              <div className="rounded-xl border border-ink/10 bg-white p-3">
                <p className="text-sm font-semibold">Mask correction editor</p>
                <button
                  type="button"
                  className="mt-3 w-full rounded-md bg-ink px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!activeTrack || !selectedManifestFrame || isSavingCorrection}
                  onClick={openMaskEditor}
                >
                  Edit mask here
                </button>
                <button
                  type="button"
                  className="mt-2 w-full rounded-md border border-ink/15 px-4 py-2 text-sm text-ink/80 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!activeTrack || isSavingCorrection || (positivePoints.length === 0 && negativePoints.length === 0)}
                  onClick={() => void handleSamAssist()}
                >
                  Run SAM assist on this frame
                </button>
              </div>

              <div className="rounded-xl border border-ink/10 bg-white p-3">
                <p className="text-sm font-semibold">Cleanup settings</p>
                <p className="mt-1 text-xs text-ink/55">Tracking density for this track: {trackingDensityLabel(activeTrack?.settings.trackingDensity ?? effectiveSettings.trackingDensity)}</p>
                <div className="mt-3 space-y-3 text-sm">
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink/55">Edge softness ({effectiveSettings.maskFeatherPx}px)</span>
                    <input type="range" min={0} max={24} value={effectiveSettings.maskFeatherPx} onChange={(event) => setPendingSettings((previous) => ({ ...previous, maskFeatherPx: Number(event.target.value) }))} className="w-full" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink/55">Edge hardness ({effectiveSettings.maskHardness.toFixed(2)})</span>
                    <input type="range" min={0} max={1} step={0.05} value={effectiveSettings.maskHardness} onChange={(event) => setPendingSettings((previous) => ({ ...previous, maskHardness: Number(event.target.value) }))} className="w-full" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink/55">Restore strength ({effectiveSettings.restoreStrength.toFixed(2)})</span>
                    <input type="range" min={0} max={1} step={0.05} value={effectiveSettings.restoreStrength} onChange={(event) => setPendingSettings((previous) => ({ ...previous, restoreStrength: Number(event.target.value) }))} className="w-full" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink/55">Expand keep region ({effectiveSettings.maskDilatePx}px)</span>
                    <input type="range" min={0} max={16} value={effectiveSettings.maskDilatePx} onChange={(event) => setPendingSettings((previous) => ({ ...previous, maskDilatePx: Number(event.target.value) }))} className="w-full" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink/55">Shrink keep region ({effectiveSettings.maskErodePx}px)</span>
                    <input type="range" min={0} max={16} value={effectiveSettings.maskErodePx} onChange={(event) => setPendingSettings((previous) => ({ ...previous, maskErodePx: Number(event.target.value) }))} className="w-full" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink/55">Temporal smoothing ({effectiveSettings.temporalSmoothingRadius})</span>
                    <input type="range" min={0} max={3} value={effectiveSettings.temporalSmoothingRadius} onChange={(event) => setPendingSettings((previous) => ({ ...previous, temporalSmoothingRadius: Number(event.target.value) }))} className="w-full" />
                  </label>
                </div>
                <button type="button" className="mt-4 w-full rounded-md border border-ink/15 px-4 py-2 text-sm text-ink/80 disabled:cursor-not-allowed disabled:opacity-50" disabled={!activeTrack} onClick={() => void handleRefreshPreview()}>
                  Refresh preview
                </button>
              </div>

              <div className="rounded-xl border border-ink/10 bg-white p-3">
                <p className="text-sm font-semibold">Apply cleanup</p>
                <p className="mt-1 text-xs text-ink/60">Render a cleaned segment and attach it back to the task as a post-cleanup generation variant for final merge review.</p>
                {activeTrack?.apply.outputSegmentUrl ? (
                  <a href={activeTrack.apply.outputSegmentUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-accent underline">
                    Download current cleaned output
                  </a>
                ) : null}
                <button
                  type="button"
                  className="mt-4 w-full rounded-md bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!activeTrack || isApplying}
                  onClick={() => void handleApply()}
                >
                  {isApplying ? "Applying..." : "Apply cleanup"}
                </button>
              </div>
            </div>
          </aside>
        </div>
        {isMaskEditorOpen ? (
          <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/65 p-4" onClick={() => setMaskEditorOpen(false)}>
            <div
              className="flex h-[90vh] w-[min(1380px,96vw)] flex-col overflow-hidden rounded-2xl border border-ink/15 bg-card text-ink"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between border-b border-ink/10 px-5 py-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-ink/45">Cleanup Mask Editor</p>
                  <h4 className="text-lg font-semibold">Frame {selectedFrameIndexLocal + 1}</h4>
                </div>
                <button type="button" className="rounded-full border border-ink/15 px-3 py-1.5 text-sm text-ink/70 hover:bg-bg" onClick={() => setMaskEditorOpen(false)}>
                  Close
                </button>
              </div>

              <div className="grid min-h-0 flex-1 gap-0 xl:grid-cols-[84px_minmax(0,1fr)_260px]">
                <aside className="flex flex-col gap-3 border-r border-ink/10 bg-white px-3 py-4">
                  <ToolRailButton label="Brush add" active={maskEditorTool === "brush_add"} onClick={() => setMaskEditorTool("brush_add")}>
                    <IconBrush mode="add" />
                  </ToolRailButton>
                  <ToolRailButton label="Brush erase" active={maskEditorTool === "brush_erase"} onClick={() => setMaskEditorTool("brush_erase")}>
                    <IconBrush mode="subtract" />
                  </ToolRailButton>
                  <div className="rounded-2xl border border-ink/10 bg-bg px-2 py-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-ink/55">Size</div>
                    <input type="range" min={4} max={96} step={2} value={maskBrushSize} onChange={(event) => setMaskBrushSize(Number(event.target.value))} className="w-full" />
                  </div>
                  <ToolRailButton label="Lasso add" active={maskEditorTool === "lasso_add"} onClick={() => setMaskEditorTool("lasso_add")}>
                    <IconLasso mode="add" />
                  </ToolRailButton>
                  <ToolRailButton label="Lasso erase" active={maskEditorTool === "lasso_erase"} onClick={() => setMaskEditorTool("lasso_erase")}>
                    <IconLasso mode="subtract" />
                  </ToolRailButton>
                </aside>

                <main className="min-h-0 overflow-y-auto bg-bg/35 p-5">
                  <div className="flex h-full flex-col gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2 rounded-full border border-ink/10 bg-white px-1 py-1 text-xs">
                        <button
                          type="button"
                          className={`rounded-full px-3 py-1 ${maskEditorBaseLayer === "generated" ? "bg-ink text-white" : "text-ink/70 hover:bg-bg"}`}
                          onClick={() => setMaskEditorBaseLayer("generated")}
                        >
                          Generated
                        </button>
                        <button
                          type="button"
                          className={`rounded-full px-3 py-1 ${maskEditorBaseLayer === "source" ? "bg-ink text-white" : "text-ink/70 hover:bg-bg"}`}
                          onClick={() => setMaskEditorBaseLayer("source")}
                        >
                          Original
                        </button>
                      </div>
                      <div className="rounded-full bg-white px-3 py-1 text-xs uppercase tracking-[0.16em] text-ink/45">
                        {maskEditorTool.replace("_", " ")}
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-1 items-center justify-center rounded-3xl border border-ink/10 bg-white p-4">
                      {maskEditorBaseImageUrl ? (
                        <div className="relative inline-block max-w-full overflow-hidden rounded-2xl border border-ink/10 bg-black/5">
                          <img
                            ref={maskEditorImageRef}
                            src={maskEditorBaseImageUrl}
                            alt={`Cleanup frame ${selectedFrameIndexLocal + 1}`}
                            className="block max-h-[68vh] max-w-full object-contain"
                            onLoad={() => refreshMaskEditorOverlay()}
                          />
                          <canvas
                            ref={maskEditorOverlayRef}
                            className={`absolute inset-0 h-full w-full touch-none ${isMaskEditorLoading ? "" : "cursor-crosshair"}`}
                            onPointerDown={handleMaskEditorPointerDown}
                            onPointerMove={handleMaskEditorPointerMove}
                            onPointerUp={handleMaskEditorPointerUp}
                            onPointerLeave={handleMaskEditorPointerUp}
                            onPointerCancel={handleMaskEditorPointerUp}
                          />
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-ink/15 bg-bg p-6 text-sm text-ink/60">Frame image unavailable for mask editing.</div>
                      )}
                    </div>
                    {isMaskEditorLoading ? <p className="text-sm text-ink/60">Loading tracked mask...</p> : null}
                  </div>
                </main>

                <aside className="overflow-y-auto border-l border-ink/10 bg-white p-4">
                  <div className="space-y-3">
                    <div className="rounded-xl border border-ink/10 bg-bg/40 p-3 text-sm text-ink/65">
                      Saving this mask creates a cleanup keyframe and re-tracks the nearby frames before rebuilding the Check previews.
                    </div>
                    <button
                      type="button"
                      className="w-full rounded-md bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isMaskEditorLoading || isMaskEditorSaving || !isMaskEditorDirty}
                      onClick={() => void saveMaskEditor()}
                    >
                      {isMaskEditorSaving ? "Saving..." : "Save and re-track"}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-md border border-ink/15 px-4 py-2 text-sm text-ink/80 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isMaskEditorLoading || isMaskEditorSaving}
                      onClick={() => void loadMaskEditor()}
                    >
                      Reset to tracked mask
                    </button>
                    {selectedManifestFrame?.sourceFrameUrl ? (
                      <img src={selectedManifestFrame.sourceFrameUrl} alt="Original reference frame" className="w-full rounded-xl border border-ink/10 object-contain" />
                    ) : null}
                    {selectedManifestFrame?.generatedFrameUrl ? (
                      <img src={selectedManifestFrame.generatedFrameUrl} alt="Generated reference frame" className="w-full rounded-xl border border-ink/10 object-contain" />
                    ) : null}
                  </div>
                </aside>
              </div>
              <canvas ref={maskEditorCanvasRef} className="hidden" />
            </div>
          </div>
        ) : null}
      </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      {content}
    </div>
  );
}

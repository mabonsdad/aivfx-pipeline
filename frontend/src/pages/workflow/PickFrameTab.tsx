import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type PointerEvent, type RefObject } from "react";

import { HelpInfoButton, PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import FrameLimitInfoButton from "../../components/workflow/FrameLimitInfoButton";
import type { SegmentRecord, TaskDetail } from "../../types/api";

type CropAspect = "16:9" | "9:16";
type CropHandle = "move" | "nw" | "ne" | "sw" | "se";

type CropDraft = {
  aspect: CropAspect;
  x: number;
  y: number;
  width: number;
  height: number;
  featherPx: number;
};

type DragState = {
  handle: CropHandle;
  startClientX: number;
  startClientY: number;
  initial: CropDraft;
  sourcePerClientX: number;
  sourcePerClientY: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxAspectRect(sourceW: number, sourceH: number, aspect: CropAspect): Pick<CropDraft, "x" | "y" | "width" | "height"> {
  const ratio = aspect === "16:9" ? 16 / 9 : 9 / 16;
  let width = sourceW;
  let height = Math.round(width / ratio);
  if (height > sourceH) {
    height = sourceH;
    width = Math.round(height * ratio);
  }
  const x = Math.max(0, Math.round((sourceW - width) / 2));
  const y = Math.max(0, Math.round((sourceH - height) / 2));
  return { x, y, width, height };
}

function clampRectToSource(rect: CropDraft, sourceW: number, sourceH: number): CropDraft {
  const width = Math.max(2, Math.min(sourceW, Math.round(rect.width)));
  const height = Math.max(2, Math.min(sourceH, Math.round(rect.height)));
  const x = Math.max(0, Math.min(sourceW - width, Math.round(rect.x)));
  const y = Math.max(0, Math.min(sourceH - height, Math.round(rect.y)));
  return { ...rect, x, y, width, height };
}

function resizeFromCorner(
  initial: CropDraft,
  handle: Exclude<CropHandle, "move">,
  dxSource: number,
  dySource: number,
  sourceW: number,
  sourceH: number,
): CropDraft {
  const ratio = initial.aspect === "16:9" ? 16 / 9 : 9 / 16;
  const minW = 32;
  const minH = 32;

  let anchorX = initial.x;
  let anchorY = initial.y;
  let rawW = initial.width;
  let rawH = initial.height;

  if (handle === "nw") {
    anchorX = initial.x + initial.width;
    anchorY = initial.y + initial.height;
    rawW = anchorX - (initial.x + dxSource);
    rawH = anchorY - (initial.y + dySource);
  } else if (handle === "ne") {
    anchorX = initial.x;
    anchorY = initial.y + initial.height;
    rawW = (initial.x + initial.width + dxSource) - anchorX;
    rawH = anchorY - (initial.y + dySource);
  } else if (handle === "sw") {
    anchorX = initial.x + initial.width;
    anchorY = initial.y;
    rawW = anchorX - (initial.x + dxSource);
    rawH = (initial.y + initial.height + dySource) - anchorY;
  } else {
    anchorX = initial.x;
    anchorY = initial.y;
    rawW = (initial.x + initial.width + dxSource) - anchorX;
    rawH = (initial.y + initial.height + dySource) - anchorY;
  }

  let width = Math.max(minW, rawW);
  let height = Math.max(minH, rawH);
  if (width / height > ratio) {
    width = Math.max(minW, Math.round(height * ratio));
  } else {
    height = Math.max(minH, Math.round(width / ratio));
  }

  let maxW = sourceW;
  let maxH = sourceH;
  if (handle === "nw") {
    maxW = anchorX;
    maxH = anchorY;
  } else if (handle === "ne") {
    maxW = sourceW - anchorX;
    maxH = anchorY;
  } else if (handle === "sw") {
    maxW = anchorX;
    maxH = sourceH - anchorY;
  } else if (handle === "se") {
    maxW = sourceW - anchorX;
    maxH = sourceH - anchorY;
  }
  if (width > maxW || height > maxH) {
    const scale = Math.min(maxW / width, maxH / height);
    width = Math.max(minW, Math.floor(width * scale));
    height = Math.max(minH, Math.floor(height * scale));
    if (width / height > ratio) {
      width = Math.max(minW, Math.round(height * ratio));
    } else {
      height = Math.max(minH, Math.round(width / ratio));
    }
  }

  let x = initial.x;
  let y = initial.y;
  if (handle === "nw") {
    x = anchorX - width;
    y = anchorY - height;
  } else if (handle === "ne") {
    x = anchorX;
    y = anchorY - height;
  } else if (handle === "sw") {
    x = anchorX - width;
    y = anchorY;
  } else if (handle === "se") {
    x = anchorX;
    y = anchorY;
  }

  return clampRectToSource({ ...initial, x, y, width, height }, sourceW, sourceH);
}

export type PickFrameTabCtx = {
  timelinePlaybackUrl: string;
  timelineVideoRef: RefObject<HTMLVideoElement>;
  frameCount: (task: TaskDetail | undefined) => number;
  task: TaskDetail | undefined;
  fpsValue: (task: TaskDetail | undefined) => number;
  currentFrameIndex: number;
  setCurrentFrameIndex: (frameIndex: number) => void;
  FrameSelectCard: ComponentType<{
    title: string;
    frame: { frameId: string; frameIndex: number; timecode: string; imageUrl?: string } | null;
    selectLabel: string;
    onSelect: () => void;
    onClear: () => void;
  }>;
  firstFrame: { frameId: string; frameIndex: number; timecode: string; imageUrl?: string } | null;
  captureCurrentFrameFor: (boundary: "first" | "last") => Promise<void>;
  setFirstFrameId: (frameId: string | null) => void;
  timelineDelta: { frames: number; seconds: number; overLimit: boolean };
  hasHardDurationLimit: boolean;
  lumaHardLimitFrames: number;
  lumaHardLimitSeconds: number;
  lastFrame: { frameId: string; frameIndex: number; timecode: string; imageUrl?: string } | null;
  setLastFrameId: (frameId: string | null) => void;
  selectedRange: {
    startFrame: number;
    endFrameInclusive: number;
    endFrameExclusive: number;
    durationFrames: number;
    durationSec: number;
    overLimit: boolean;
    limitMessage: string | null;
  } | null;
  generationInputMode: "start_video" | "start_end" | "start_only";
  lumaModel: string;
  videoWorkMode: "whole_video" | "custom_segment" | null;
  defaultVideoSegment: SegmentRecord | null;
  wholeVideoNeedsChunking: boolean;
  wholeVideoSinglePassLimitSeconds: number;
  onChooseWholeVideo: () => void;
  onChooseCustomSegment: () => void;
  onBeginCustomSegmentEdit: () => void;
  onCancelWorkingRangeDraft: () => void;
  onContinueToEditFrames: () => void;
  selectedSegmentId: string | null;
  selectedSegment: SegmentRecord | null;
  segmentDraftFallbackAvailable: boolean;
  setSelectedSegmentId: (segmentId: string | null) => void;
  ensureSegmentForSelectedFrames: () => Promise<string | null>;
  saveSegmentCrop: (crop: { aspect: CropAspect; x: number; y: number; width: number; height: number; featherPx?: number } | null) => Promise<string | null>;
  isSavingSegmentCrop: boolean;
};

type PickFrameTabProps = {
  ctx: PickFrameTabCtx;
};

export default function PickFrameTab({ ctx }: PickFrameTabProps) {
  const {
    timelinePlaybackUrl,
    timelineVideoRef,
    frameCount,
    task,
    fpsValue,
    currentFrameIndex,
    setCurrentFrameIndex,
    FrameSelectCard,
    firstFrame,
    captureCurrentFrameFor,
    setFirstFrameId,
    timelineDelta,
    lastFrame,
    setLastFrameId,
    selectedRange,
    generationInputMode,
    defaultVideoSegment,
    wholeVideoNeedsChunking,
    wholeVideoSinglePassLimitSeconds,
    onBeginCustomSegmentEdit,
    onCancelWorkingRangeDraft,
    onContinueToEditFrames,
    selectedSegmentId,
    selectedSegment,
    setSelectedSegmentId,
    ensureSegmentForSelectedFrames,
    saveSegmentCrop,
    isSavingSegmentCrop,
  } = ctx;

  const sourceWidth = Number(task?.video?.editSource?.width ?? 0);
  const sourceHeight = Number(task?.video?.editSource?.height ?? 0);
  const totalFrameCount = frameCount(task);
  const sourceFps = fpsValue(task);
  const sourceDurationSec = sourceFps > 0 ? totalFrameCount / sourceFps : 0;
  const canOpenCropTool = Boolean(selectedSegmentId || selectedRange);
  const [isWorkingRangeModalOpen, setIsWorkingRangeModalOpen] = useState(false);

  const [isCropModalOpen, setIsCropModalOpen] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);
  const [modalLayoutTick, setModalLayoutTick] = useState(0);
  const [modalScrubSec, setModalScrubSec] = useState(0);
  const [uiError, setUiError] = useState<string | null>(null);
  const workingRangeVideoRef = useRef<HTMLVideoElement | null>(null);
  const modalVideoRef = useRef<HTMLVideoElement | null>(null);
  const modalVideoWrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const previewWindow = useMemo(() => {
    const fps = fpsValue(task);
    if (!fps || fps <= 0) return null;
    if (selectedSegment) {
      return {
        startSec: selectedSegment.startFrame / fps,
        endSec: selectedSegment.endFrameExclusive / fps,
      };
    }
    if (selectedRange) {
      return {
        startSec: selectedRange.startFrame / fps,
        endSec: selectedRange.endFrameExclusive / fps,
      };
    }
    return null;
  }, [fpsValue, selectedRange, selectedSegment, task]);

  const isFullFrame = useMemo(() => {
    if (!cropDraft || sourceWidth <= 0 || sourceHeight <= 0) return true;
    return cropDraft.x === 0 && cropDraft.y === 0 && cropDraft.width === sourceWidth && cropDraft.height === sourceHeight;
  }, [cropDraft, sourceHeight, sourceWidth]);
  const visibleSegments = useMemo(() => (task?.segments ?? []).filter((segment) => !segment.internalOnly), [task?.segments]);
  const uncroppedSegments = useMemo(
    () => visibleSegments.filter((segment) => !segment.crop?.enabled),
    [visibleSegments],
  );
  const selectedBaseSegment = useMemo(() => {
    if (!selectedSegment) return defaultVideoSegment ?? uncroppedSegments[0] ?? null;
    if (!selectedSegment.crop?.enabled) return selectedSegment;
    return (
      uncroppedSegments.find(
        (segment) =>
          segment.startFrame === selectedSegment.startFrame &&
          segment.endFrameExclusive === selectedSegment.endFrameExclusive,
      ) ?? selectedSegment
    );
  }, [defaultVideoSegment, selectedSegment, uncroppedSegments]);
  const orderedSegments = useMemo(() => {
    if (!visibleSegments.length) return visibleSegments;
    const grouped = new Map<string, SegmentRecord[]>();
    for (const segment of visibleSegments) {
      const key = `${segment.startFrame}:${segment.endFrameExclusive}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(segment);
      grouped.set(key, bucket);
    }
    const representatives = Array.from(grouped.values()).map((segments) => {
      const uncropped = segments.find((segment) => !segment.crop?.enabled);
      return uncropped ?? segments[0];
    });
    const defaultId = defaultVideoSegment?.segmentId ?? null;
    return representatives.sort((a, b) => {
      if (a.segmentId === defaultId) return -1;
      if (b.segmentId === defaultId) return 1;
      return a.startFrame - b.startFrame || a.endFrameExclusive - b.endFrameExclusive;
    });
  }, [defaultVideoSegment?.segmentId, visibleSegments]);
  const cropOptions = useMemo(() => {
    if (!selectedBaseSegment) return [];
    const matching = visibleSegments.filter(
      (segment) =>
        segment.startFrame === selectedBaseSegment.startFrame &&
        segment.endFrameExclusive === selectedBaseSegment.endFrameExclusive,
    );
    return [...matching].sort((a, b) => {
      const aCrop = Boolean(a.crop?.enabled);
      const bCrop = Boolean(b.crop?.enabled);
      if (aCrop !== bCrop) return aCrop ? 1 : -1;
      return a.segmentId.localeCompare(b.segmentId);
    });
  }, [selectedBaseSegment, visibleSegments]);

  const openWorkingRangeModal = useCallback(() => {
    if (selectedSegmentId || !selectedRange) {
      onBeginCustomSegmentEdit();
    }
    setIsWorkingRangeModalOpen(true);
  }, [onBeginCustomSegmentEdit, selectedRange, selectedSegmentId]);

  const closeWorkingRangeModal = useCallback(() => {
    onCancelWorkingRangeDraft();
    setIsWorkingRangeModalOpen(false);
    setUiError(null);
  }, [onCancelWorkingRangeDraft]);

  const saveWorkingRange = useCallback(async () => {
    setUiError(null);
    try {
      const segmentId = await ensureSegmentForSelectedFrames();
      if (!segmentId) {
        throw new Error("Pick a valid start and end frame before saving this working range.");
      }
      setIsWorkingRangeModalOpen(false);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Failed to save working range.");
    }
  }, [ensureSegmentForSelectedFrames]);

  const openCropModal = useCallback(async () => {
    if (!canOpenCropTool || sourceWidth <= 0 || sourceHeight <= 0) return;
    let segment: SegmentRecord | null = selectedBaseSegment ?? selectedSegment;
    if (!segment) {
      const ensured = await ensureSegmentForSelectedFrames();
      if (!ensured) return;
      segment = task?.segments.find((item) => item.segmentId === ensured) ?? null;
    }
    if (!segment) return;
    const defaultAspect: CropAspect =
      (segment?.crop?.aspect as CropAspect | undefined) ??
      (sourceWidth >= sourceHeight ? "16:9" : "9:16");
    if (segment?.crop?.enabled) {
      setCropDraft({
        aspect: defaultAspect,
        x: segment.crop.x,
        y: segment.crop.y,
        width: segment.crop.width,
        height: segment.crop.height,
        featherPx: segment.crop.featherPx ?? 0,
      });
    } else {
      setCropDraft({
        aspect: defaultAspect,
        x: 0,
        y: 0,
        width: sourceWidth,
        height: sourceHeight,
        featherPx: segment?.crop?.featherPx ?? 0,
      });
    }
    setIsCropModalOpen(true);
  }, [canOpenCropTool, ensureSegmentForSelectedFrames, selectedBaseSegment, selectedSegment, sourceHeight, sourceWidth, task?.segments]);

  useEffect(() => {
    if (!isCropModalOpen) return;
    const video = modalVideoRef.current;
    if (!video || !previewWindow) return;
    const onLoaded = () => {
      video.currentTime = previewWindow.startSec;
      video.pause();
      setModalScrubSec(previewWindow.startSec);
    };
    video.addEventListener("loadedmetadata", onLoaded);
    return () => video.removeEventListener("loadedmetadata", onLoaded);
  }, [isCropModalOpen, previewWindow]);

  useEffect(() => {
    if (!isCropModalOpen) return;
    const refreshLayout = () => setModalLayoutTick((value) => value + 1);
    const raf = window.requestAnimationFrame(refreshLayout);
    window.addEventListener("resize", refreshLayout);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", refreshLayout);
    };
  }, [isCropModalOpen]);

  const onModalVideoTimeUpdate = useCallback(() => {
    if (!previewWindow) return;
    const video = modalVideoRef.current;
    if (!video) return;
    const clamped = clamp(video.currentTime, previewWindow.startSec, previewWindow.endSec);
    if (Math.abs(video.currentTime - clamped) > 0.001) {
      video.currentTime = clamped;
    }
    setModalScrubSec(clamped);
  }, [previewWindow]);

  useEffect(() => {
    if (!isCropModalOpen || !previewWindow) return;
    const video = modalVideoRef.current;
    if (!video) return;
    const clamped = clamp(modalScrubSec, previewWindow.startSec, previewWindow.endSec);
    if (Math.abs(video.currentTime - clamped) > 0.001) {
      video.currentTime = clamped;
    }
  }, [isCropModalOpen, modalScrubSec, previewWindow]);

  const setAspect = useCallback(
    (aspect: CropAspect) => {
      setCropDraft((previous) => {
        if (!previous || sourceWidth <= 0 || sourceHeight <= 0) return previous;
        if (previous.aspect === aspect) return previous;
        if (isFullFrame) {
          const full = maxAspectRect(sourceWidth, sourceHeight, aspect);
          return { ...previous, aspect, ...full };
        }
        const cx = previous.x + previous.width / 2;
        const cy = previous.y + previous.height / 2;
        const ratio = aspect === "16:9" ? 16 / 9 : 9 / 16;
        let width = previous.width;
        let height = Math.round(width / ratio);
        if (width > sourceWidth) {
          width = sourceWidth;
          height = Math.round(width / ratio);
        }
        if (height > sourceHeight) {
          height = sourceHeight;
          width = Math.round(height * ratio);
        }
        if (width > sourceWidth) {
          width = sourceWidth;
          height = Math.round(width / ratio);
        }
        let x = Math.round(cx - width / 2);
        let y = Math.round(cy - height / 2);
        x = Math.max(0, Math.min(sourceWidth - width, x));
        y = Math.max(0, Math.min(sourceHeight - height, y));
        return { ...previous, aspect, x, y, width, height };
      });
    },
    [isFullFrame, sourceHeight, sourceWidth],
  );

  const clearCrop = useCallback(() => {
    if (sourceWidth <= 0 || sourceHeight <= 0) return;
    setCropDraft((previous) => {
      if (!previous) return previous;
      return { ...previous, x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    });
  }, [sourceHeight, sourceWidth]);

  const startDrag = useCallback(
    (handle: CropHandle, event: PointerEvent<HTMLDivElement>) => {
      if (!cropDraft || sourceWidth <= 0 || sourceHeight <= 0 || !modalVideoRef.current) return;
      event.preventDefault();
      const rect = modalVideoRef.current.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      dragRef.current = {
        handle,
        startClientX: event.clientX,
        startClientY: event.clientY,
        initial: cropDraft,
        sourcePerClientX: sourceWidth / rect.width,
        sourcePerClientY: sourceHeight / rect.height,
      };

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        moveEvent.preventDefault();
        const dxSource = (moveEvent.clientX - drag.startClientX) * drag.sourcePerClientX;
        const dySource = (moveEvent.clientY - drag.startClientY) * drag.sourcePerClientY;
        if (drag.handle === "move") {
          const next = clampRectToSource(
            {
              ...drag.initial,
              x: drag.initial.x + dxSource,
              y: drag.initial.y + dySource,
            },
            sourceWidth,
            sourceHeight,
          );
          setCropDraft(next);
          return;
        }
        const next = resizeFromCorner(drag.initial, drag.handle, dxSource, dySource, sourceWidth, sourceHeight);
        setCropDraft(next);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("touchend", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    },
    [cropDraft, sourceHeight, sourceWidth],
  );

  const applyCrop = useCallback(async () => {
    if (!cropDraft) return;
    setUiError(null);
    try {
      if (isFullFrame) {
        if (selectedBaseSegment) {
          setSelectedSegmentId(selectedBaseSegment.segmentId);
          setFirstFrameId(selectedBaseSegment.startFrameId);
          setLastFrameId(selectedBaseSegment.endFrameId);
          setCurrentFrameIndex(selectedBaseSegment.startFrame);
        }
      } else {
        await saveSegmentCrop({
          aspect: cropDraft.aspect,
          x: cropDraft.x,
          y: cropDraft.y,
          width: cropDraft.width,
          height: cropDraft.height,
          featherPx: cropDraft.featherPx,
        });
      }
      setIsCropModalOpen(false);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Failed to save crop");
    }
  }, [cropDraft, isFullFrame, saveSegmentCrop, selectedBaseSegment, setCurrentFrameIndex, setFirstFrameId, setLastFrameId, setSelectedSegmentId]);

  const cropStyle = useMemo(() => {
    if (!cropDraft || sourceWidth <= 0 || sourceHeight <= 0 || !modalVideoWrapRef.current || !modalVideoRef.current) return null;
    const wrapRect = modalVideoWrapRef.current.getBoundingClientRect();
    const videoRect = modalVideoRef.current.getBoundingClientRect();
    if (videoRect.width <= 0 || videoRect.height <= 0 || wrapRect.width <= 0 || wrapRect.height <= 0) return null;
    const scaleX = videoRect.width / sourceWidth;
    const scaleY = videoRect.height / sourceHeight;
    return {
      left: (videoRect.left - wrapRect.left) + cropDraft.x * scaleX,
      top: (videoRect.top - wrapRect.top) + cropDraft.y * scaleY,
      width: cropDraft.width * scaleX,
      height: cropDraft.height * scaleY,
      scaleX,
      scaleY,
    };
  }, [cropDraft, modalLayoutTick, sourceHeight, sourceWidth, isCropModalOpen]);

  const sourceAspectRatio = sourceWidth > 0 && sourceHeight > 0 ? `${sourceWidth} / ${sourceHeight}` : "16 / 9";
  return (
    <div className="space-y-4">
      {uiError ? (
        <StatusNotice variant="error">
          <p>{uiError}</p>
        </StatusNotice>
      ) : null}
      <div className="rounded-2xl border border-ink/10 bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <div>
              <p className="text-sm font-semibold text-ink">Select Working Range</p>
              <p className="text-xs text-ink/60">Choose a segment of the video to work on or use the whole video</p>
            </div>
          </div>
          <HelpInfoButton
            title="Working ranges"
            lines={[
              "The full source video is available as the default working range.",
              "Create shorter working ranges when you only want to work on part of the video.",
              "Saved working ranges can be reused across Create, Outputs, Post Process, and Reports.",
            ]}
          />
          <button
            type="button"
            onClick={openWorkingRangeModal}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Create New Working Range
          </button>
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {orderedSegments.map((seg, index) => {
            const endFrame = Math.max(seg.endFrameExclusive - 1, seg.startFrame);
            const startFrameImage = task?.frames?.[seg.startFrameId]?.imageUrl;
            const endFrameImage = task?.frames?.[seg.endFrameId]?.imageUrl;
            const isSelected = seg.segmentId === selectedBaseSegment?.segmentId;
            const rangeWarning =
              generationInputMode === "start_video" && seg.durationFrames > 192
                ? "Above frame limit for this mode - chunking required"
                : generationInputMode === "start_end" && seg.durationFrames > 240
                  ? "Above frame limit: output shorter than source"
                  : generationInputMode === "start_only" && seg.durationFrames > 240
                    ? "Above frame limit: output shorter than source"
                    : null;
            return (
              <button
                key={seg.segmentId}
                type="button"
                onClick={() => {
                  setSelectedSegmentId(seg.segmentId);
                  setCurrentFrameIndex(seg.startFrame);
                  setFirstFrameId(seg.startFrameId);
                  setLastFrameId(seg.endFrameId);
                }}
                className={`w-full rounded-lg border p-2.5 text-left transition ${
                  isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white hover:border-ink/20"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-ink">{defaultVideoSegment?.segmentId === seg.segmentId ? "Whole video" : `Working range ${index}`}</p>
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    {defaultVideoSegment?.segmentId === seg.segmentId ? <span className="text-ink/60">DEFAULT</span> : null}
                    {seg.crop?.enabled ? <span className="text-red-600">CROPPED</span> : null}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink/65">Start f{seg.startFrame}</p>
                    {startFrameImage ? (
                      <img
                        src={startFrameImage}
                        alt={`Start frame ${seg.startFrame}`}
                        className="h-20 w-32 rounded border border-ink/10 bg-bg object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="flex h-20 w-32 items-center justify-center rounded border border-ink/10 bg-bg text-xs text-ink/45">No preview</div>
                    )}
                  </div>
                  <div className="flex min-w-[5.5rem] flex-col items-center justify-center pt-6 text-center text-xs text-ink/65">
                    <p>{seg.durationFrames} frames</p>
                    <div className="my-1 text-sm leading-none text-ink/45">→</div>
                    <p>{seg.durationSec.toFixed(2)}s</p>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink/65">End f{endFrame}</p>
                    {endFrameImage ? (
                      <img
                        src={endFrameImage}
                        alt={`End frame ${endFrame}`}
                        className="h-20 w-32 rounded border border-ink/10 bg-bg object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="flex h-20 w-32 items-center justify-center rounded border border-ink/10 bg-bg text-xs text-ink/45">No preview</div>
                    )}
                  </div>
                </div>
                {rangeWarning ? (
                  <div className="mt-3 flex items-start gap-2 text-xs text-amber-700">
                    <p>{rangeWarning}</p>
                    <FrameLimitInfoButton label="Frame limits for working ranges" mode={generationInputMode} />
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-ink/10 bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">Select Region (optional)</p>
            <p className="text-xs text-ink/60">Crop into a region of the video to regenerate - Nb. works best for static shots and/or if all action in one part of video</p>
          </div>
          <button
            type="button"
            disabled={!canOpenCropTool}
            onClick={() => {
              void openCropModal();
            }}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create New Cropped Region
          </button>
          <HelpInfoButton
            title="Select Region"
            lines={[
              "Cropping focuses regeneration on one region of the frame.",
              "It works best for static shots or where the action stays in one area of the image.",
              "Overcropping or using it on fast camera movement can make results less stable.",
            ]}
          />
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {cropOptions.map((segment) => {
            const previewUrl = task?.frames?.[segment.startFrameId]?.imageUrl ?? null;
            const isSelected = segment.segmentId === selectedSegmentId;
            const crop = segment.crop?.enabled ? segment.crop : null;
            const title =
              !crop && defaultVideoSegment?.segmentId === segment.segmentId
                ? "Whole Video (no crop)"
                : !crop
                  ? "No crop"
                  : `Crop ${crop.aspect}`;
            const meta = crop
              ? [`Aspect ${crop.aspect}`, `x:${crop.x} y:${crop.y}`, `w:${crop.width} h:${crop.height}`]
              : [`Aspect ${sourceWidth}:${sourceHeight}`, `x:0 y:0`, `w:${sourceWidth} h:${sourceHeight}`];
            return (
              <button
                key={segment.segmentId}
                type="button"
                onClick={() => {
                  setSelectedSegmentId(segment.segmentId);
                  setCurrentFrameIndex(segment.startFrame);
                  setFirstFrameId(segment.startFrameId);
                  setLastFrameId(segment.endFrameId);
                }}
                className={`w-full rounded-lg border p-2.5 text-left transition ${
                  isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white hover:border-ink/20"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-20 w-32 items-center justify-center rounded border border-ink/10 bg-bg">
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt={title}
                        className="h-full w-full rounded object-contain"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="text-xs text-ink/45">No preview</div>
                    )}
                  </div>
                  <div className="space-y-1 text-sm text-ink/70">
                    <p className="font-medium text-ink">{title}</p>
                    {meta.map((line) => (
                      <p key={line} className="text-xs">
                        {line}
                      </p>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!selectedSegmentId && !defaultVideoSegment}
          onClick={onContinueToEditFrames}
        >
          Next
        </button>
      </div>

      {isWorkingRangeModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[95vh] w-full max-w-5xl overflow-auto rounded-lg bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h4 className="text-lg font-semibold">Create Working Range</h4>
                <p className="text-sm text-ink/60">Choose a start and end frame from the source video, then save the range for reuse.</p>
              </div>
              <button
                type="button"
                className="rounded border border-ink/20 px-2 py-1 text-sm"
                onClick={closeWorkingRangeModal}
              >
                Cancel
              </button>
            </div>
            <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
              {timelinePlaybackUrl ? (
                <video
                  ref={workingRangeVideoRef}
                  className="max-h-[360px] max-w-full rounded-lg border border-ink/10 bg-black"
                  src={timelinePlaybackUrl}
                  controls
                  preload="metadata"
                  onTimeUpdate={(e) => {
                    const totalFrames = frameCount(task);
                    if (!totalFrames) return;
                    const fps = fpsValue(task);
                    const nextFrame = Math.max(0, Math.min(totalFrames - 1, Math.round(e.currentTarget.currentTime * fps)));
                    if (nextFrame !== currentFrameIndex) {
                      setCurrentFrameIndex(nextFrame);
                    }
                  }}
                />
              ) : (
                <p className="text-sm text-ink/70">Ingest must complete before timeline is available.</p>
              )}
              <div className="space-y-3">
                <div className="rounded-lg border border-ink/15 bg-bg p-3">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-ink">Working range selection</p>
                    <HelpInfoButton
                      title="Create a working range"
                      lines={[
                        "Use the source player and slider to choose the start and end frames for a shorter saved range.",
                        "If you cancel without saving, the previously selected working range stays in place.",
                      ]}
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Current frame: {currentFrameIndex}</label>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, frameCount(task) - 1)}
                    value={currentFrameIndex}
                    onChange={(e) => setCurrentFrameIndex(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
              <FrameSelectCard
                title="Start Frame"
                frame={firstFrame}
                selectLabel="Select Start Frame"
                onSelect={() => {
                  onBeginCustomSegmentEdit();
                  void captureCurrentFrameFor("first");
                }}
                onClear={() => {
                  onBeginCustomSegmentEdit();
                  setFirstFrameId(null);
                }}
              />

              <div className="flex w-24 flex-col items-center justify-center text-center">
                <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>{timelineDelta.frames} frames</p>
                <p className="my-1 text-xl text-ink/70">→</p>
                <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>{timelineDelta.seconds.toFixed(2)}s</p>
              </div>

              <FrameSelectCard
                title="End Frame"
                frame={lastFrame}
                selectLabel="Select End Frame"
                onSelect={() => {
                  onBeginCustomSegmentEdit();
                  void captureCurrentFrameFor("last");
                }}
                onClear={() => {
                  onBeginCustomSegmentEdit();
                  setLastFrameId(null);
                }}
              />
            </div>

            {selectedRange ? (
              <div className="mt-4 space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                <p className={`text-xs ${selectedRange.overLimit ? "text-red-600" : "text-ink/70"}`}>
                  Selected range: f{selectedRange.startFrame} to f{selectedRange.endFrameInclusive} ({selectedRange.durationFrames} frames /{" "}
                  {selectedRange.durationSec.toFixed(2)}s)
                </p>
                {selectedRange.overLimit ? (
                  <StatusNotice variant="warning">
                    <p className="text-xs">{selectedRange.limitMessage}</p>
                  </StatusNotice>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={closeWorkingRangeModal} className="rounded border border-ink/20 bg-white px-3 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                disabled={!selectedRange}
                onClick={() => {
                  void saveWorkingRange();
                }}
                className="rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save Working Range
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCropModalOpen && cropDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[95vh] w-full max-w-5xl overflow-auto rounded-lg bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="text-lg font-semibold">Create Cropped Region</h4>
              <button
                type="button"
                className="rounded border border-ink/20 px-2 py-1 text-sm"
                onClick={() => setIsCropModalOpen(false)}
              >
                Cancel
              </button>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setAspect("16:9")}
                className={`rounded border px-3 py-1 text-sm ${cropDraft.aspect === "16:9" ? "border-accent bg-accent/10" : "border-ink/20 bg-white"}`}
              >
                Landscape (16:9)
              </button>
              <button
                type="button"
                onClick={() => setAspect("9:16")}
                className={`rounded border px-3 py-1 text-sm ${cropDraft.aspect === "9:16" ? "border-accent bg-accent/10" : "border-ink/20 bg-white"}`}
              >
                Portrait (9:16)
              </button>
              <label className="ml-2 text-sm text-ink/70">
                Feather px
                <input
                  type="number"
                  min={0}
                  max={200}
                  value={cropDraft.featherPx}
                  onChange={(event) =>
                    setCropDraft((previous) =>
                      previous ? { ...previous, featherPx: Math.max(0, Math.min(200, Number(event.target.value) || 0)) } : previous,
                    )
                  }
                  className="ml-2 w-20 rounded border border-ink/20 px-2 py-1"
                />
              </label>
            </div>
            <div ref={modalVideoWrapRef} className="relative mx-auto w-fit max-w-[92vw]">
              <video
                ref={modalVideoRef}
                src={timelinePlaybackUrl}
                preload="metadata"
                className="block h-auto max-h-[60vh] w-auto max-w-[92vw] rounded-md bg-black"
                onTimeUpdate={onModalVideoTimeUpdate}
                onPlay={(event) => {
                  event.currentTarget.pause();
                }}
              />
              {cropStyle ? (
                <div
                  role="presentation"
                  className={`absolute ${isFullFrame ? "border-2 border-dashed border-sky-500/80" : "border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]"}`}
                  style={{
                    left: `${cropStyle.left}px`,
                    top: `${cropStyle.top}px`,
                    width: `${cropStyle.width}px`,
                    height: `${cropStyle.height}px`,
                    touchAction: "none",
                  }}
                  onPointerDown={(event) => startDrag("move", event)}
                >
                  {!isFullFrame && cropDraft.featherPx > 0 ? (
                    <div
                      className="pointer-events-none absolute border border-dashed border-accent/70"
                      style={{
                        left: `${Math.min(cropDraft.featherPx * cropStyle.scaleX, Math.max(0, cropStyle.width / 2 - 1))}px`,
                        top: `${Math.min(cropDraft.featherPx * cropStyle.scaleY, Math.max(0, cropStyle.height / 2 - 1))}px`,
                        right: `${Math.min(cropDraft.featherPx * cropStyle.scaleX, Math.max(0, cropStyle.width / 2 - 1))}px`,
                        bottom: `${Math.min(cropDraft.featherPx * cropStyle.scaleY, Math.max(0, cropStyle.height / 2 - 1))}px`,
                      }}
                    />
                  ) : null}
                  {(["nw", "ne", "sw", "se"] as const).map((handle) => {
                    const pos: Record<typeof handle, string> = {
                      nw: "-left-2 -top-2 cursor-nwse-resize",
                      ne: "-right-2 -top-2 cursor-nesw-resize",
                      sw: "-left-2 -bottom-2 cursor-nesw-resize",
                      se: "-right-2 -bottom-2 cursor-nwse-resize",
                    };
                    return (
                      <div
                        key={handle}
                        role="button"
                        aria-label={`Resize ${handle}`}
                        className={`absolute h-4 w-4 rounded-full border-2 border-white bg-accent shadow ${pos[handle]}`}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          startDrag(handle, event);
                        }}
                        style={{ touchAction: "none" }}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
            {previewWindow ? (
              <div className="mt-3 space-y-1">
                <label className="block text-xs font-medium text-ink/70">
                  Preview frame position: {modalScrubSec.toFixed(2)}s
                </label>
                <input
                  type="range"
                  min={previewWindow.startSec}
                  max={previewWindow.endSec}
                  step={Math.max(0.01, 1 / Math.max(1, fpsValue(task)))}
                  value={modalScrubSec}
                  onChange={(event) => setModalScrubSec(Number(event.target.value))}
                  className="w-full"
                />
              </div>
            ) : null}
            <div className="mt-2 space-y-2">
              <StatusNotice variant="warning">
                <p className="text-xs">Do not crop too tight as the AI needs context. Overcropping can lead to unrealistic output detail.</p>
              </StatusNotice>
              <StatusNotice variant="warning">
                <p className="text-xs">Use cropping cautiously on moving shots. It is most reliable on fixed-camera footage and conservative motion settings.</p>
              </StatusNotice>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={clearCrop} className="rounded border border-ink/20 bg-white px-3 py-2 text-sm">
                Clear
              </button>
              <button
                type="button"
                disabled={isSavingSegmentCrop}
                onClick={() => void applyCrop()}
                className="rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PendingButtonLabel isPending={isSavingSegmentCrop} idle="Crop" pending="Saving crop..." />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type PointerEvent, type RefObject } from "react";

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
  } | null;
  lumaModel: string;
  selectedSegmentId: string | null;
  selectedSegment: SegmentRecord | null;
  setSelectedSegmentId: (segmentId: string | null) => void;
  ensureSegmentForSelectedFrames: () => Promise<string | null>;
  saveSegmentCrop: (crop: { aspect: CropAspect; x: number; y: number; width: number; height: number; featherPx?: number } | null) => Promise<void>;
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
    hasHardDurationLimit,
    lumaHardLimitFrames,
    lumaHardLimitSeconds,
    lastFrame,
    setLastFrameId,
    selectedRange,
    lumaModel,
    selectedSegmentId,
    selectedSegment,
    setSelectedSegmentId,
    ensureSegmentForSelectedFrames,
    saveSegmentCrop,
    isSavingSegmentCrop,
  } = ctx;

  const sourceWidth = Number(task?.video?.editSource?.width ?? 0);
  const sourceHeight = Number(task?.video?.editSource?.height ?? 0);
  const canOpenCropTool = Boolean(selectedSegmentId || selectedRange);
  const isSegmentCropped = Boolean(selectedSegment?.crop?.enabled);

  const [isCropModalOpen, setIsCropModalOpen] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null);
  const [modalLayoutTick, setModalLayoutTick] = useState(0);
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

  const openCropModal = useCallback(async () => {
    if (!canOpenCropTool || sourceWidth <= 0 || sourceHeight <= 0) return;
    let segment = selectedSegment;
    if (!segment) {
      const ensured = await ensureSegmentForSelectedFrames();
      if (!ensured) return;
      segment = task?.segments.find((item) => item.segmentId === ensured) ?? null;
    }
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
  }, [canOpenCropTool, ensureSegmentForSelectedFrames, selectedSegment, sourceHeight, sourceWidth, task?.segments]);

  useEffect(() => {
    if (!isCropModalOpen) return;
    const video = modalVideoRef.current;
    if (!video || !previewWindow) return;
    const onLoaded = () => {
      video.currentTime = previewWindow.startSec;
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
    if (video.currentTime < previewWindow.startSec) {
      video.currentTime = previewWindow.startSec;
    } else if (video.currentTime > previewWindow.endSec) {
      video.currentTime = previewWindow.startSec;
      void video.play().catch(() => undefined);
    }
  }, [previewWindow]);

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
      if (!cropDraft || sourceWidth <= 0 || sourceHeight <= 0 || !modalVideoWrapRef.current) return;
      event.preventDefault();
      const rect = modalVideoWrapRef.current.getBoundingClientRect();
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
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [cropDraft, sourceHeight, sourceWidth],
  );

  const applyCrop = useCallback(async () => {
    if (!cropDraft) return;
    try {
      if (!selectedSegmentId) {
        const segmentId = await ensureSegmentForSelectedFrames();
        if (!segmentId) return;
        setSelectedSegmentId(segmentId);
      }
      if (isFullFrame) {
        await saveSegmentCrop(null);
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
      window.alert(error instanceof Error ? error.message : "Failed to save crop");
    }
  }, [cropDraft, ensureSegmentForSelectedFrames, isFullFrame, saveSegmentCrop, selectedSegmentId, setSelectedSegmentId]);

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

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Pick Frame & Segment Selection</h3>
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        {timelinePlaybackUrl ? (
          <div className="relative w-fit max-w-full">
            <video
              ref={timelineVideoRef}
              className="max-h-[360px] max-w-full rounded-lg border border-ink/10"
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
            {isSegmentCropped ? (
              <div className="absolute left-2 top-2 rounded bg-red-600 px-2 py-0.5 text-xs font-semibold tracking-wide text-white">CROPPED</div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-ink/70">Ingest must complete before timeline is available.</p>
        )}
        <div className="space-y-3">
          <div className="rounded-lg border border-ink/15 bg-bg p-3 text-xs text-ink/70 whitespace-pre-line">
            {
              "Select a start and end frame to define the segment of video you want the AI to edit or add effects to.\n\nUse the slider to pick the frames.\n\nMoving to the next step saves the segment."
            }
          </div>
          <div className={`rounded-lg border p-3 ${canOpenCropTool ? "border-ink/15 bg-white" : "border-ink/10 bg-bg opacity-60"}`}>
            <p className="text-sm font-semibold text-ink">Segment cropping tool (optional)</p>
            <p className="mt-1 text-xs text-ink/70">
              You can crop into a region of the video so the AI works on it at a larger scale, and then recombine it later.
            </p>
            <button
              type="button"
              disabled={!canOpenCropTool}
              onClick={() => {
                void openCropModal();
              }}
              className="mt-3 rounded-md border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              Crop Segment
            </button>
          </div>
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

      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
        <FrameSelectCard
          title="Start Frame"
          frame={firstFrame}
          selectLabel="Select Start Frame"
          onSelect={() => captureCurrentFrameFor("first")}
          onClear={() => setFirstFrameId(null)}
        />

        <div className="flex w-24 flex-col items-center justify-center text-center">
          <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>{timelineDelta.frames} frames</p>
          <p className="my-1 text-xl text-ink/70">→</p>
          <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>{timelineDelta.seconds.toFixed(2)}s</p>
          <p className="mt-1 text-[10px] text-ink/50">
            {hasHardDurationLimit ? `limit ${lumaHardLimitFrames}f / ${lumaHardLimitSeconds}s` : "Runway input constrained by 64MB"}
          </p>
        </div>

        <FrameSelectCard
          title="End Frame"
          frame={lastFrame}
          selectLabel="Select End Frame"
          onSelect={() => captureCurrentFrameFor("last")}
          onClear={() => setLastFrameId(null)}
        />
      </div>

      {selectedRange ? (
        <div className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
          <p className={`text-xs ${selectedRange.overLimit ? "text-red-600" : "text-ink/70"}`}>
            Selected range: {selectedRange.startFrame} {"->"} {selectedRange.endFrameInclusive} ({selectedRange.durationFrames} frames /{" "}
            {selectedRange.durationSec.toFixed(2)}s)
          </p>
          {selectedRange.overLimit ? (
            <p className="text-xs text-red-600">
              This exceeds the current model limit ({lumaHardLimitSeconds}s for {lumaModel}). You can still save the segment, but generation will be
              blocked until under the hard limit.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2">
        <p className="text-sm font-medium text-ink/80">Available segments - click to reuse a segment</p>
        {task?.segments.map((seg) => (
          <button
            key={seg.segmentId}
            onClick={() => {
              setSelectedSegmentId(seg.segmentId);
              setCurrentFrameIndex(seg.startFrame);
              setFirstFrameId(seg.startFrameId);
              setLastFrameId(seg.endFrameId);
            }}
            className={`rounded-lg border p-3 text-left ${seg.segmentId === selectedSegmentId ? "border-accent bg-accent/10" : "border-ink/10"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">{seg.segmentId}</p>
              {seg.crop?.enabled ? <span className="text-xs font-semibold text-red-600">CROPPED</span> : null}
            </div>
            <p className="text-sm text-ink/70">
              {seg.startFrame} {"->"} {seg.endFrameExclusive} ({seg.durationSec}s)
            </p>
          </button>
        ))}
      </div>

      {isCropModalOpen && cropDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[95vh] w-full max-w-5xl overflow-auto rounded-lg bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="text-lg font-semibold">Crop Segment</h4>
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
                controls
                preload="metadata"
                className="block h-auto max-h-[60vh] w-auto max-w-[92vw] rounded-md border border-ink/15 bg-black"
                onTimeUpdate={onModalVideoTimeUpdate}
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
            <p className="mt-2 text-xs text-amber-700">
              Do not crop too tight as the AI needs context. Overcropping can lead to output that has unrealistic detail.
            </p>
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
                {isSavingSegmentCrop ? "Saving..." : "Crop"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

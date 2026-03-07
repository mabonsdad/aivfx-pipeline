import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";

import { apiClient } from "./api/client";
import { currentUser, login, logout } from "./lib/auth";
import { useUiStore } from "./store/uiStore";
import type {
  CustomReportOutputRef,
  CustomReportRecord,
  FrameRecord,
  FrameVariant,
  SegmentGeneration,
  SegmentRecord,
  TaskDetail,
} from "./types/api";

type TabId = "timeline" | "frames" | "generate" | "merge" | "assets" | "report";
type GenerateInputMode = "start_video" | "start_end" | "start_only";
type VideoModel =
  | "ray-2"
  | "ray-flash-2"
  | "runway-gen4.5"
  | "kling-2.6"
  | "veo-3.1"
  | "veo-3.1-fast"
  | "wan2.2-a14b"
  | "wan2.2-animate";

type NewTaskStage = "idle" | "creating" | "uploading" | "ingesting" | "error";

type LibraryAsset = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  mediaType: "image" | "video";
  customReportRef?: CustomReportOutputRef;
  deletePayload:
    | { assetType: "upload" }
    | { assetType: "frame_capture"; frameId: string }
    | { assetType: "frame_variant"; frameId: string; variantId: string }
    | { assetType: "segment_generation"; genId: string }
    | { assetType: "export"; exportId: string };
};

type PatchEngine = "nano_banana_pro" | "chatgpt" | "runware_flux_fill" | "runware_ace_pp";
type PatchToolMode = "brush_add" | "brush_erase" | "lasso_add" | "lasso_erase";

type MaskPoint = {
  x: number;
  y: number;
};

type PatchReferenceImage = {
  file: File;
  previewUrl: string;
  uploadedKey?: string;
  frameId?: string;
};

type ReportGenerationRow = {
  generation: SegmentGeneration;
  segment: SegmentRecord | null;
  startFrame: FrameRecord | null;
  endFrame: FrameRecord | null;
  startVariant: FrameVariant | null;
  endVariant: FrameVariant | null;
  originalUrl: string | null;
  maskUrl: string | null;
  editedUrl: string | null;
  endFrameUrl: string | null;
  generatedVideoUrl: string | null;
};

type ReportView = "outputs" | "qc_frame" | "qc_video";

type ReportOutputGroup = "video_generations" | "start_frames" | "end_frames";

type ReportOutputCard = {
  id: string;
  taskId: string;
  group: ReportOutputGroup;
  title: string;
  subtitle: string;
  createdAt: string;
  modelLabel: string;
  promptLabel: string;
  imageUrl: string | null;
  videoUrl: string | null;
  selectionRef: CustomReportOutputRef;
};

type QcFrameRow = {
  id: string;
  frame: FrameRecord;
  variant: FrameVariant;
  role: "start" | "end" | "unlinked";
  linkedGenerations: ReportGenerationRow[];
  qcGeneration: ReportGenerationRow | null;
};

type VideoGenerationGroup = "start_video" | "start_equals_end" | "start_end" | "start_only";

type EditFrameCandidate = {
  id: string;
  kind: "original" | "variant";
  imageUrl: string;
  label: string;
  createdAt?: string;
  variantId?: string;
  variant?: FrameVariant;
  isSelected: boolean;
};

const VIDEO_THUMBNAIL_CACHE = new Map<string, string | null>();
const VIDEO_FRAME_THUMBNAIL_CACHE = new Map<string, string | null>();

type VideoFrameStripItem = {
  frameIndex: number;
  imageUrl: string | null;
};

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function frameWindow(centerFrame: number, before: number, after: number, minFrame: number, maxFrame: number): number[] {
  if (maxFrame < minFrame) return [];
  const values: number[] = [];
  for (let frame = centerFrame - before; frame <= centerFrame + after; frame += 1) {
    if (frame < minFrame || frame > maxFrame) continue;
    values.push(frame);
  }
  return values;
}

function formatFramesAndSeconds(frames: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  return `${frames}f / ${(frames / safeFps).toFixed(2)}s`;
}

function normalizeTaskNameInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 15);
}

function humanizeFilename(value: string): string {
  const withoutExt = value.replace(/\.[^/.]+$/, "");
  return withoutExt.replace(/[_-]+/g, " ").trim();
}

function keyBasenameFromS3Key(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function safeTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function reportOutputRefKey(ref: CustomReportOutputRef): string {
  if (ref.assetType === "segment_generation") {
    return `segment_generation:${ref.genId}`;
  }
  return `frame_variant:${ref.frameId}:${ref.variantId}`;
}

function classifyVideoGeneration(row: ReportGenerationRow): VideoGenerationGroup {
  const model = row.generation.luma.model;
  if (model === "ray-2" || model === "ray-flash-2" || model === "wan2.2-animate") {
    return "start_video";
  }
  if (model === "runway-gen4.5" || model === "wan2.2-a14b") {
    return "start_only";
  }
  const firstKey = row.generation.sourceFirstFrameResolvedKey ?? row.generation.inputFirstFrameKey ?? null;
  const lastKey = row.generation.sourceLastFrameResolvedKey ?? row.generation.inputLastFrameKey ?? null;
  if (!lastKey) {
    return "start_only";
  }
  if (firstKey && firstKey === lastKey) {
    return "start_equals_end";
  }
  return "start_end";
}

function truncateIdentifier(value: string, maxLength = 12): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function formatCompactTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown time";
  const asDate = new Date(iso);
  if (Number.isNaN(asDate.getTime())) return iso;
  return asDate.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function frameCount(task: TaskDetail | undefined): number {
  return task?.video?.editSource?.frameCount ?? 0;
}

function fpsValue(task: TaskDetail | undefined): number {
  const fps = task?.video?.editSource?.fps;
  if (!fps || !fps.den) return 30;
  return fps.num / fps.den;
}

function lumaModelMaxDurationSeconds(
  model: VideoModel,
): number {
  if (model === "ray-2") return 10;
  if (model === "ray-flash-2") return 15;
  if (model === "runway-gen4.5") return 10;
  if (model === "kling-2.6") return 10;
  if (model === "veo-3.1" || model === "veo-3.1-fast") return 8;
  if (model === "wan2.2-a14b") return 5;
  if (model === "wan2.2-animate") return 10;
  return 60;
}

const GENERATION_MODELS_BY_INPUT: Record<GenerateInputMode, Array<{ value: VideoModel; label: string }>> = {
  start_video: [
    { value: "ray-flash-2", label: "ray-flash-2" },
    { value: "ray-2", label: "ray-2" },
  ],
  start_end: [
    { value: "kling-2.6", label: "kling-2.6 (start/end frames)" },
    { value: "veo-3.1", label: "veo-3.1 (start/end frames, no audio)" },
    { value: "veo-3.1-fast", label: "veo-3.1-fast (start/end frames, no audio)" },
  ],
  start_only: [
    { value: "wan2.2-a14b", label: "wan2.2-a14b (start frame image-to-video)" },
    { value: "runway-gen4.5", label: "runway-gen4.5 (start frame image-to-video)" },
    { value: "veo-3.1", label: "veo-3.1 (start/end capable, uses start if end unchanged)" },
    { value: "veo-3.1-fast", label: "veo-3.1-fast (start/end capable, uses start if end unchanged)" },
    { value: "kling-2.6", label: "kling-2.6 (start/end capable, uses start if end unchanged)" },
  ],
};

function FrameSelectCard({
  title,
  frame,
  selectLabel,
  onSelect,
  onClear,
}: {
  title: string;
  frame: { frameId: string; frameIndex: number; timecode: string; imageUrl?: string } | null;
  selectLabel: string;
  onSelect: () => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <p className="mb-2 text-sm font-semibold">{title}</p>
      {frame?.imageUrl ? (
        <div>
          <img src={frame.imageUrl} alt={`${title} preview`} className="max-h-28 w-full rounded-md bg-bg object-contain" />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-ink/70">
              frame {frame.frameIndex} ({frame.timecode})
            </p>
            <button
              onClick={onClear}
              className="rounded border border-ink/20 bg-white px-2 py-1 text-xs"
              title="Clear selected frame"
            >
              Clear Frame selection
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={onSelect}
          className="w-full rounded-md border border-accent bg-accent/10 px-3 py-4 text-left transition hover:bg-accent/20"
        >
          <span className="block text-sm font-semibold text-ink">{selectLabel}</span>
          <span className="text-xs text-ink/70">at selected timeline position</span>
        </button>
      )}
    </div>
  );
}

function VideoThumbnail({
  videoUrl,
  label,
  onClick,
  disabled,
  cacheKey,
  interactive = true,
  thumbClassName = "aspect-video",
}: {
  videoUrl?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  cacheKey?: string;
  interactive?: boolean;
  thumbClassName?: string;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl(null);
    if (!videoUrl) return;
    const key = cacheKey || videoUrl;
    if (key && VIDEO_THUMBNAIL_CACHE.has(key)) {
      setThumbnailUrl(VIDEO_THUMBNAIL_CACHE.get(key) ?? null);
      return;
    }

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = videoUrl;

    const capture = () => {
      if (cancelled) return;
      if (!video.videoWidth || !video.videoHeight) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
        if (key) VIDEO_THUMBNAIL_CACHE.set(key, dataUrl);
        setThumbnailUrl(dataUrl);
      } catch {
        if (key) VIDEO_THUMBNAIL_CACHE.set(key, null);
        setThumbnailUrl(null);
      }
    };

    const handleLoadedData = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        capture();
        return;
      }
      const previewTime = Math.min(1, Math.max(0, video.duration / 3));
      if (previewTime <= 0) {
        capture();
        return;
      }
      video.currentTime = previewTime;
    };

    const handleSeeked = () => capture();
    const handleError = () => {
      if (!cancelled) {
        if (key) VIDEO_THUMBNAIL_CACHE.set(key, null);
        setThumbnailUrl(null);
      }
    };

    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);
    video.load();

    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      video.pause();
      video.src = "";
    };
  }, [cacheKey, videoUrl]);

  const thumbnailContent = thumbnailUrl ? (
    <img src={thumbnailUrl} alt={label} className={`${thumbClassName} w-full rounded-md bg-bg object-contain`} />
  ) : (
    <div className={`flex ${thumbClassName} w-full items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/60`}>
      Video thumbnail unavailable
    </div>
  );

  if (!interactive) {
    return <div className="block w-full">{thumbnailContent}</div>;
  }

  return (
    <button
      type="button"
      className="block w-full disabled:cursor-not-allowed disabled:opacity-60"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Video unavailable" : `Use ${label}`}
    >
      {thumbnailContent}
    </button>
  );
}

function useVideoFrameStrip({
  videoUrl,
  fps,
  frameIndices,
  cachePrefix,
}: {
  videoUrl?: string | null;
  fps: number;
  frameIndices: number[];
  cachePrefix: string;
}): VideoFrameStripItem[] {
  const [items, setItems] = useState<VideoFrameStripItem[]>([]);
  const signature = useMemo(() => frameIndices.join(","), [frameIndices]);

  useEffect(() => {
    let cancelled = false;
    if (!videoUrl || !Number.isFinite(fps) || fps <= 0 || frameIndices.length === 0) {
      setItems([]);
      return;
    }

    const safeFps = fps;
    const uniqueFrames = Array.from(new Set(frameIndices)).sort((a, b) => a - b);
    const initial = uniqueFrames.map((frameIndex) => {
      const key = `${cachePrefix}:${videoUrl}:${frameIndex}`;
      return { frameIndex, imageUrl: VIDEO_FRAME_THUMBNAIL_CACHE.get(key) ?? null };
    });
    setItems(initial);

    const run = async () => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.src = videoUrl;

      const waitForMetadata = new Promise<void>((resolve, reject) => {
        const handleLoaded = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error("Could not read video metadata"));
        };
        const cleanup = () => {
          video.removeEventListener("loadedmetadata", handleLoaded);
          video.removeEventListener("error", handleError);
        };
        video.addEventListener("loadedmetadata", handleLoaded);
        video.addEventListener("error", handleError);
      });

      try {
        video.load();
        await waitForMetadata;
      } catch {
        if (!cancelled) {
          setItems(uniqueFrames.map((frameIndex) => ({ frameIndex, imageUrl: null })));
        }
        video.pause();
        video.src = "";
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, video.videoWidth || 1);
      canvas.height = Math.max(1, video.videoHeight || 1);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        if (!cancelled) {
          setItems(uniqueFrames.map((frameIndex) => ({ frameIndex, imageUrl: null })));
        }
        video.pause();
        video.src = "";
        return;
      }

      const results: VideoFrameStripItem[] = [];
      const durationSec = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
      const maxSeekSec = Math.max(0, durationSec - 0.001);

      for (const frameIndex of uniqueFrames) {
        if (cancelled) break;
        const cacheKey = `${cachePrefix}:${videoUrl}:${frameIndex}`;
        if (VIDEO_FRAME_THUMBNAIL_CACHE.has(cacheKey)) {
          results.push({ frameIndex, imageUrl: VIDEO_FRAME_THUMBNAIL_CACHE.get(cacheKey) ?? null });
          continue;
        }

        const targetSec = Math.max(0, Math.min(maxSeekSec, frameIndex / safeFps));
        try {
          if (Math.abs(video.currentTime - targetSec) > 0.0005) {
            const seekPromise = new Promise<void>((resolve, reject) => {
              const handleSeeked = () => {
                cleanup();
                resolve();
              };
              const handleError = () => {
                cleanup();
                reject(new Error("seek failed"));
              };
              const cleanup = () => {
                video.removeEventListener("seeked", handleSeeked);
                video.removeEventListener("error", handleError);
              };
              video.addEventListener("seeked", handleSeeked);
              video.addEventListener("error", handleError);
            });
            video.currentTime = targetSec;
            await seekPromise;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
          VIDEO_FRAME_THUMBNAIL_CACHE.set(cacheKey, dataUrl);
          results.push({ frameIndex, imageUrl: dataUrl });
        } catch {
          VIDEO_FRAME_THUMBNAIL_CACHE.set(cacheKey, null);
          results.push({ frameIndex, imageUrl: null });
        }
      }

      video.pause();
      video.src = "";
      if (!cancelled) {
        setItems(results);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [cachePrefix, fps, frameIndices, signature, videoUrl]);

  return items;
}

function MergeTrackStrip({
  title,
  items,
  anchorFrame,
  overlapStart,
  overlapEnd,
  prefix,
}: {
  title: string;
  items: VideoFrameStripItem[];
  anchorFrame: number;
  overlapStart?: number;
  overlapEnd?: number;
  prefix: string;
}) {
  const itemWidthPx = 96;
  const anchorIndex = items.findIndex((item) => item.frameIndex === anchorFrame);
  const overlapMin = overlapStart != null && overlapEnd != null ? Math.min(overlapStart, overlapEnd) : null;
  const overlapMax = overlapStart != null && overlapEnd != null ? Math.max(overlapStart, overlapEnd) : null;
  const overlapStartIndex = overlapMin != null ? items.findIndex((item) => item.frameIndex === overlapMin) : -1;
  const overlapEndIndex = overlapMax != null ? items.findIndex((item) => item.frameIndex === overlapMax) : -1;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-ink/70">
        <p className="font-medium text-ink/80">{title}</p>
        <p>
          cut {prefix}
          {anchorFrame}
        </p>
      </div>
      <div className="overflow-x-auto rounded border border-ink/15 bg-white">
        <div className="relative inline-flex min-w-full">
          {items.map((item) => {
            const inOverlap = overlapMin != null && overlapMax != null && item.frameIndex >= overlapMin && item.frameIndex <= overlapMax;
            return (
              <div
                key={`${title}:${item.frameIndex}`}
                className={`shrink-0 border-r border-ink/15 ${
                  inOverlap ? "bg-amber-50" : "bg-bg"
                } last:border-r-0`}
                style={{ width: `${itemWidthPx}px` }}
              >
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={`${prefix}${item.frameIndex}`} className="h-16 w-full object-contain" />
                ) : (
                  <div className="flex h-16 w-full items-center justify-center text-[10px] text-ink/60">no frame</div>
                )}
                <p className="truncate px-1 py-1 text-[10px] text-ink/70">
                  {prefix}
                  {item.frameIndex}
                </p>
              </div>
            );
          })}
          {anchorIndex >= 0 ? (
            <div
              className="pointer-events-none absolute bottom-0 top-0 w-[2px] bg-teal-600"
              style={{ left: `${anchorIndex * itemWidthPx}px` }}
              title="Merge cut"
            />
          ) : null}
          {overlapStartIndex >= 0 ? (
            <div
              className="pointer-events-none absolute bottom-0 top-0 w-px border-l border-dashed border-amber-500"
              style={{ left: `${overlapStartIndex * itemWidthPx}px` }}
              title="Feather start"
            />
          ) : null}
          {overlapEndIndex >= 0 ? (
            <div
              className="pointer-events-none absolute bottom-0 top-0 w-px border-l border-dashed border-amber-500"
              style={{ left: `${(overlapEndIndex + 1) * itemWidthPx}px` }}
              title="Feather end"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MergeBoundaryPreview({
  title,
  subtitle,
  firstTrack,
  secondTrack,
}: {
  title: string;
  subtitle: string;
  firstTrack: {
    title: string;
    items: VideoFrameStripItem[];
    anchorFrame: number;
    overlapStart?: number;
    overlapEnd?: number;
    prefix: string;
  };
  secondTrack: {
    title: string;
    items: VideoFrameStripItem[];
    anchorFrame: number;
    overlapStart?: number;
    overlapEnd?: number;
    prefix: string;
  };
}) {
  return (
    <div className="space-y-2 rounded-lg border border-ink/10 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-ink/60">{subtitle}</p>
      </div>
      <div className="space-y-2">
        <MergeTrackStrip {...firstTrack} />
        <MergeTrackStrip {...secondTrack} />
        <p className="text-[11px] text-ink/60">
          Solid teal line = merge cut. Dashed amber lines = feather blend boundaries.
        </p>
      </div>
    </div>
  );
}

function uploadFileWithProgress(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("content-type", contentType);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed due to network error"));
    xhr.send(file);
  });
}

export default function App() {
  const queryClient = useQueryClient();
  const {
    selectedTaskId,
    currentFrameIndex,
    selectedFrameId,
    selectedSegmentId,
    setSelectedTaskId,
    setCurrentFrameIndex,
    setSelectedFrameId,
    setSelectedSegmentId,
  } = useUiStore();

  const [isAuthed, setIsAuthed] = useState(false);
  const [tab, setTab] = useState<TabId>("timeline");
  const [reportTaskId, setReportTaskId] = useState<string | null>(null);
  const [reportView, setReportView] = useState<ReportView>("outputs");
  const [activeCustomReportId, setActiveCustomReportId] = useState<string | null>(null);
  const [selectedReportOutputs, setSelectedReportOutputs] = useState<Record<string, { taskId: string; ref: CustomReportOutputRef }>>({});
  const [customReportNotice, setCustomReportNotice] = useState<string | null>(null);
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("New VFX Task");
  const [newTaskFile, setNewTaskFile] = useState<File | null>(null);
  const [newTaskStage, setNewTaskStage] = useState<NewTaskStage>("idle");
  const [newTaskError, setNewTaskError] = useState<string | null>(null);
  const [newTaskUploadPercent, setNewTaskUploadPercent] = useState(0);
  const [pendingCreateJobId, setPendingCreateJobId] = useState<string | null>(null);
  const [uploadAssetsVisible, setUploadAssetsVisible] = useState(6);
  const [frameAssetsVisible, setFrameAssetsVisible] = useState(6);
  const [videoAssetsVisible, setVideoAssetsVisible] = useState(6);
  const [jobsVisible, setJobsVisible] = useState(6);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<"nano_banana" | "nano_banana_pro" | "chatgpt">("nano_banana_pro");
  const [patchPrompt, setPatchPrompt] = useState("");
  const [patchEngine, setPatchEngine] = useState<PatchEngine>("nano_banana_pro");
  const [runwareRepaintingScale, setRunwareRepaintingScale] = useState(0.7);
  const [patchReferenceImages, setPatchReferenceImages] = useState<{ first: PatchReferenceImage | null; last: PatchReferenceImage | null }>({
    first: null,
    last: null,
  });
  const [patchToolMode, setPatchToolMode] = useState<PatchToolMode>("brush_add");
  const [patchBrushSize, setPatchBrushSize] = useState(24);
  const [featherPx, setFeatherPx] = useState(24);
  const [edgeAwareRefine, setEdgeAwareRefine] = useState(true);
  const [edgeAwareStrength, setEdgeAwareStrength] = useState(0.45);
  const [edgeAwareRadiusPx, setEdgeAwareRadiusPx] = useState(6);
  const [maskGrowPx, setMaskGrowPx] = useState(0);
  const [maskHasPaint, setMaskHasPaint] = useState(false);
  const [generationInputMode, setGenerationInputMode] = useState<GenerateInputMode>("start_video");
  const [generationModelByInput, setGenerationModelByInput] = useState<Record<GenerateInputMode, VideoModel>>({
    start_video: "ray-flash-2",
    start_end: "kling-2.6",
    start_only: "wan2.2-a14b",
  });
  const [lumaModel, setLumaModel] = useState<VideoModel>("ray-flash-2");
  const [advancedMode, setAdvancedMode] = useState("flex_1");
  const [lumaPrompt, setLumaPrompt] = useState("");
  const [editSourceVariantIds, setEditSourceVariantIds] = useState<{ first: string | null; last: string | null }>({
    first: null,
    last: null,
  });
  const [compareVariantIds, setCompareVariantIds] = useState<{ first: string | null; last: string | null }>({
    first: null,
    last: null,
  });
  const [selectedGenIds, setSelectedGenIds] = useState<string[]>([]);
  const [selectedPreviewGenId, setSelectedPreviewGenId] = useState<string>("");
  const [temporalFeatherFrames, setTemporalFeatherFrames] = useState(0);
  const [mergeInsertStartFrame, setMergeInsertStartFrame] = useState(0);
  const [mergeTrimStartFrames, setMergeTrimStartFrames] = useState(0);
  const [mergeTrimEndFrames, setMergeTrimEndFrames] = useState(0);
  const [mergeConfiguredGenId, setMergeConfiguredGenId] = useState("");
  const [imagePreviewModal, setImagePreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [videoPreviewModal, setVideoPreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [reportGraphModal, setReportGraphModal] = useState<{ url: string; label: string } | null>(null);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [firstFrameId, setFirstFrameId] = useState<string | null>(null);
  const [lastFrameId, setLastFrameId] = useState<string | null>(null);
  const [editFrameTab, setEditFrameTab] = useState<"first" | "last">("first");
  const timelineVideoRef = useRef<HTMLVideoElement | null>(null);
  const compareOriginalRef = useRef<HTMLVideoElement | null>(null);
  const compareVariantRef = useRef<HTMLVideoElement | null>(null);
  const syncLockRef = useRef(false);
  const patchOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchDrawStateRef = useRef<{ tool: PatchToolMode; points: MaskPoint[]; last: MaskPoint | null } | null>(null);
  const requestedAutoQcRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    currentUser().then((user) => setIsAuthed(!!user));
  }, []);

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: async () => (await apiClient.listTasks()).tasks,
    enabled: isAuthed,
  });
  const normalizedNewTaskName = useMemo(() => normalizeTaskNameInput(newTaskName), [newTaskName]);
  const taskNameAlreadyExists = useMemo(() => {
    const target = normalizedNewTaskName.toLowerCase();
    if (!target) return false;
    return (tasksQuery.data ?? []).some((taskItem) => taskItem.name.toLowerCase() === target);
  }, [normalizedNewTaskName, tasksQuery.data]);
  const showTaskNameExistsWarning =
    taskNameAlreadyExists &&
    newTaskStage !== "creating" &&
    newTaskStage !== "uploading" &&
    newTaskStage !== "ingesting";

  useEffect(() => {
    const modelForInput = generationModelByInput[generationInputMode];
    if (modelForInput !== lumaModel) {
      setLumaModel(modelForInput);
    }
  }, [generationInputMode, generationModelByInput, lumaModel]);

  useEffect(() => {
    if (!selectedTaskId && tasksQuery.data?.length) {
      setSelectedTaskId(tasksQuery.data[0].taskId);
    }
  }, [selectedTaskId, setSelectedTaskId, tasksQuery.data]);

  const taskQuery = useQuery({
    queryKey: ["task", selectedTaskId],
    queryFn: async () => apiClient.getTask(selectedTaskId as string),
    enabled: isAuthed && !!selectedTaskId,
    refetchInterval: tab === "generate" ? 4 * 60 * 1000 : false,
  });
  const reportTaskQuery = useQuery({
    queryKey: ["task", "report", reportTaskId],
    queryFn: async () => apiClient.getTask(reportTaskId as string),
    enabled: isAuthed && tab === "report" && !!reportTaskId,
  });
  const pendingCreateJobQuery = useQuery({
    queryKey: ["job", pendingCreateJobId],
    queryFn: () => apiClient.getJob(pendingCreateJobId as string),
    enabled: isAuthed && !!pendingCreateJobId,
    refetchInterval: (q: { state: { data?: { status?: string } } }) => {
      const status = q?.state?.data?.status;
      return status === "queued" || status === "running" ? 2000 : false;
    },
  });
  const assetTaskQueries = useQueries({
    queries: (tasksQuery.data ?? []).map((taskItem) => ({
      queryKey: ["task", "assets", taskItem.taskId],
      queryFn: () => apiClient.getTask(taskItem.taskId),
      enabled: isAuthed && tab === "assets",
      refetchOnWindowFocus: false as const,
    })),
  });

  const task = taskQuery.data;
  const reportTask = reportTaskQuery.data;
  const assetTasks = useMemo(
    () => assetTaskQueries.map((query) => query.data).filter((item): item is TaskDetail => Boolean(item)),
    [assetTaskQueries],
  );
  const orderedSegments = useMemo(() => [...(task?.segments ?? [])].reverse(), [task?.segments]);
  const segmentsById = useMemo(
    () => new Map((task?.segments ?? []).map((segment) => [segment.segmentId, segment])),
    [task?.segments],
  );
  const reportSegmentsById = useMemo(
    () => new Map((reportTask?.segments ?? []).map((segment) => [segment.segmentId, segment])),
    [reportTask?.segments],
  );
  const assetsLoading = tab === "assets" && assetTaskQueries.some((query) => query.isPending || query.isFetching) && assetTasks.length === 0;
  const selectedSegment = task?.segments.find((s) => s.segmentId === selectedSegmentId) ?? null;
  const firstFrame = task && firstFrameId ? task.frames[firstFrameId] ?? null : null;
  const lastFrame = task && lastFrameId ? task.frames[lastFrameId] ?? null : null;
  const editFirstFrame = (firstFrameId ? task?.frames[firstFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.startFrameId] : null) ?? null;
  const editLastFrame = (lastFrameId ? task?.frames[lastFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.endFrameId] : null) ?? null;
  const activeEditFrame = editFrameTab === "first" ? editFirstFrame : editLastFrame;
  const activeEditVariants = useMemo(
    () =>
      [...(activeEditFrame?.variants ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [activeEditFrame?.variants],
  );
  const activeEditSourceVariantId = editSourceVariantIds[editFrameTab];
  const activeCompareVariantId = compareVariantIds[editFrameTab];
  const activeSelectedVariant = useMemo(
    () =>
      activeEditSourceVariantId
        ? activeEditVariants.find((variant) => variant.variantId === activeEditSourceVariantId) ?? null
        : null,
    [activeEditSourceVariantId, activeEditVariants],
  );
  const activeCompareVariant = useMemo(
    () =>
      activeCompareVariantId
        ? activeEditVariants.find((variant) => variant.variantId === activeCompareVariantId) ?? null
        : null,
    [activeCompareVariantId, activeEditVariants],
  );
  const activeEditSourceImageUrl = activeSelectedVariant?.imageUrl ?? activeEditFrame?.imageUrl ?? null;
  const activeCompareImageUrl = activeCompareVariant?.imageUrl ?? activeEditFrame?.imageUrl ?? null;
  const activeEditCandidates = useMemo<EditFrameCandidate[]>(() => {
    if (!activeEditFrame?.imageUrl) return [];
    const candidates: EditFrameCandidate[] = [
      {
        id: `${activeEditFrame.frameId}:original`,
        kind: "original",
        imageUrl: activeEditFrame.imageUrl,
        label: "Original frame",
        createdAt: activeEditFrame.createdAt,
        isSelected: !activeCompareVariantId,
      },
    ];
    for (const variant of activeEditVariants) {
      if (!variant.imageUrl) continue;
      candidates.push({
        id: variant.variantId,
        kind: "variant",
        imageUrl: variant.imageUrl,
        label: `${variant.model} / ${variant.type}`,
        createdAt: variant.createdAt,
        variantId: variant.variantId,
        variant,
        isSelected: activeCompareVariantId === variant.variantId,
      });
    }
    return candidates;
  }, [activeCompareVariantId, activeEditFrame, activeEditVariants]);
  const activeFrameDimensions = useMemo(() => {
    const width = task?.video?.editSource?.width;
    const height = task?.video?.editSource?.height;
    if (!activeEditFrame || !width || !height) return null;
    return { width, height };
  }, [activeEditFrame, task?.video?.editSource?.height, task?.video?.editSource?.width]);
  const activeFrameWidth = activeFrameDimensions?.width ?? null;
  const activeFrameHeight = activeFrameDimensions?.height ?? null;
  const activePatchReference = patchReferenceImages[editFrameTab];
  const reportRows = useMemo(() => {
    if (!reportTask) {
      return { rows: [] as ReportGenerationRow[] };
    }
    const frameById = reportTask.frames ?? {};
    const allRows: ReportGenerationRow[] = Object.values(reportTask.segmentGenerations ?? {})
      .filter((generation) => generation.status !== "failed")
      .map((generation) => {
      const segment = reportSegmentsById.get(generation.segmentId) ?? null;
      const startFrame = segment ? frameById[segment.startFrameId] ?? null : null;
      const endFrame = segment ? frameById[segment.endFrameId] ?? null : null;
      const startVariantId = generation.sourceFirstFrameVariantId ?? startFrame?.selectedVariantId ?? null;
      const endVariantId = generation.sourceLastFrameVariantId ?? endFrame?.selectedVariantId ?? null;
      const startVariant = startVariantId ? startFrame?.variants.find((variant) => variant.variantId === startVariantId) ?? null : null;
      const endVariant = endVariantId ? endFrame?.variants.find((variant) => variant.variantId === endVariantId) ?? null : null;
      return {
        generation,
        segment,
        startFrame,
        endFrame,
        startVariant,
        endVariant,
        originalUrl: startFrame?.imageUrl ?? generation.sourceFirstFrameCaptureUrl ?? null,
        maskUrl: (startVariant?.patchMeta?.maskUrl as string | undefined) ?? null,
        editedUrl: startVariant?.imageUrl ?? generation.inputFirstFrameUrl ?? null,
        endFrameUrl: endVariant?.imageUrl ?? generation.inputLastFrameUrl ?? endFrame?.imageUrl ?? null,
        generatedVideoUrl: generation.downloadUrl ?? null,
      };
    });
    const sortScore = (row: ReportGenerationRow) => (row.generatedVideoUrl ? 0 : 1);
    allRows.sort((a, b) => sortScore(a) - sortScore(b) || safeTimestamp(b.generation.createdAt) - safeTimestamp(a.generation.createdAt));
    return { rows: allRows };
  }, [reportSegmentsById, reportTask]);
  const reportCustomReports = useMemo(
    () =>
      [...(reportTask?.customReports ?? [])].sort((a, b) => safeTimestamp(b.updatedAt) - safeTimestamp(a.updatedAt)),
    [reportTask?.customReports],
  );
  const activeCustomReport = useMemo(
    () => reportCustomReports.find((report) => report.reportId === activeCustomReportId) ?? null,
    [activeCustomReportId, reportCustomReports],
  );
  const selectedOutputRefsByTask = useMemo(() => {
    const grouped: Record<string, CustomReportOutputRef[]> = {};
    for (const item of Object.values(selectedReportOutputs)) {
      if (!grouped[item.taskId]) {
        grouped[item.taskId] = [];
      }
      grouped[item.taskId].push(item.ref);
    }
    return grouped;
  }, [selectedReportOutputs]);
  const reportOutputCards = useMemo(() => {
    if (!reportTask) {
      return {
        videoGenerations: [] as ReportOutputCard[],
        startFrames: [] as ReportOutputCard[],
        endFrames: [] as ReportOutputCard[],
      };
    }
    const startFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.startFrameId));
    const endFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.endFrameId));
    const videoCards: ReportOutputCard[] = reportRows.rows
      .filter((row) => Boolean(row.generatedVideoUrl))
      .map((row) => ({
        id: `report-card:gen:${row.generation.genId}`,
        taskId: reportTask.taskId,
        group: "video_generations",
        title: row.segment ? `Segment ${row.segment.segmentId}` : row.generation.genId,
        subtitle: row.segment ? describeSegment(row.segment) : row.generation.segmentId,
        createdAt: row.generation.createdAt,
        modelLabel: row.generation.luma.model,
        promptLabel: row.generation.luma.prompt?.trim() || "No prompt provided",
        imageUrl: null,
        videoUrl: row.generatedVideoUrl,
        selectionRef: { assetType: "segment_generation", genId: row.generation.genId },
      }));
    const startCards: ReportOutputCard[] = [];
    const endCards: ReportOutputCard[] = [];
    for (const frame of Object.values(reportTask.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.imageUrl) continue;
        const baseCard: ReportOutputCard = {
          id: `report-card:variant:${frame.frameId}:${variant.variantId}`,
          taskId: reportTask.taskId,
          group: startFrameIds.has(frame.frameId) ? "start_frames" : "end_frames",
          title: `Frame ${frame.frameIndex} (${frame.timecode})`,
          subtitle: startFrameIds.has(frame.frameId)
            ? "Start frame edit"
            : endFrameIds.has(frame.frameId)
              ? "End frame edit"
              : "Unlinked frame edit",
          createdAt: variant.createdAt,
          modelLabel: `${variant.model} (${variant.type})`,
          promptLabel: `Prompt hash ${truncateIdentifier(variant.promptHash, 16)}`,
          imageUrl: variant.imageUrl,
          videoUrl: null,
          selectionRef: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
        };
        if (startFrameIds.has(frame.frameId)) {
          startCards.push(baseCard);
        } else if (endFrameIds.has(frame.frameId)) {
          endCards.push(baseCard);
        } else {
          startCards.push(baseCard);
        }
      }
    }
    const byCreated = (a: ReportOutputCard, b: ReportOutputCard) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt);
    videoCards.sort(byCreated);
    startCards.sort(byCreated);
    endCards.sort(byCreated);
    return { videoGenerations: videoCards, startFrames: startCards, endFrames: endCards };
  }, [reportRows.rows, reportTask]);
  const activeReportGenerationIds = useMemo(() => {
    const ids = new Set<string>();
    if (!activeCustomReport) return ids;
    for (const ref of activeCustomReport.outputRefs ?? []) {
      if (ref.assetType === "segment_generation") {
        ids.add(ref.genId);
      }
    }
    return ids;
  }, [activeCustomReport]);
  const activeReportFrameVariantKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!activeCustomReport) return keys;
    for (const ref of activeCustomReport.outputRefs ?? []) {
      if (ref.assetType === "frame_variant") {
        keys.add(`${ref.frameId}:${ref.variantId}`);
      }
    }
    return keys;
  }, [activeCustomReport]);
  const scopedVideoRows = useMemo(() => {
    const rows = reportRows.rows.filter((row) => Boolean(row.generatedVideoUrl));
    if (!activeCustomReport) {
      return rows;
    }
    return rows.filter((row) => activeReportGenerationIds.has(row.generation.genId));
  }, [activeCustomReport, activeReportGenerationIds, reportRows.rows]);
  const qcFrameRows = useMemo(() => {
    if (!reportTask) return [] as QcFrameRow[];
    const startFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.startFrameId));
    const endFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.endFrameId));
    const generationRowsByVariant = new Map<string, ReportGenerationRow[]>();
    for (const row of reportRows.rows) {
      for (const variantId of [row.generation.sourceFirstFrameVariantId, row.generation.sourceLastFrameVariantId]) {
        if (!variantId) continue;
        const existing = generationRowsByVariant.get(variantId) ?? [];
        generationRowsByVariant.set(variantId, [...existing, row]);
      }
    }
    const rows: QcFrameRow[] = [];
    for (const frame of Object.values(reportTask.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.imageUrl) continue;
        const refKey = `${frame.frameId}:${variant.variantId}`;
        const linkedGenerations = generationRowsByVariant.get(variant.variantId) ?? [];
        if (activeCustomReport) {
          const includedByRef = activeReportFrameVariantKeys.has(refKey);
          const includedByGeneration = linkedGenerations.some((row) => activeReportGenerationIds.has(row.generation.genId));
          if (!includedByRef && !includedByGeneration) {
            continue;
          }
        }
        const qcGeneration =
          linkedGenerations.find((row) => row.generation.qc?.status === "complete") ??
          linkedGenerations.find((row) => row.generation.qc?.status === "running") ??
          linkedGenerations[0] ??
          null;
        const role: "start" | "end" | "unlinked" = startFrameIds.has(frame.frameId)
          ? "start"
          : endFrameIds.has(frame.frameId)
            ? "end"
            : "unlinked";
        rows.push({
          id: `qc-frame:${frame.frameId}:${variant.variantId}`,
          frame,
          variant,
          role,
          linkedGenerations,
          qcGeneration,
        });
      }
    }
    return rows.sort((a, b) => safeTimestamp(b.variant.createdAt) - safeTimestamp(a.variant.createdAt));
  }, [activeCustomReport, activeReportFrameVariantKeys, activeReportGenerationIds, reportRows.rows, reportTask]);
  const qcVideoRowsByGroup = useMemo(() => {
    const grouped: Record<VideoGenerationGroup, ReportGenerationRow[]> = {
      start_video: [],
      start_equals_end: [],
      start_end: [],
      start_only: [],
    };
    for (const row of scopedVideoRows) {
      grouped[classifyVideoGeneration(row)].push(row);
    }
    return grouped;
  }, [scopedVideoRows]);
  const scopedQcGenerationIds = useMemo(() => {
    if (reportView === "qc_video") {
      return scopedVideoRows.map((row) => row.generation.genId);
    }
    if (reportView === "qc_frame") {
      const ids = new Set<string>();
      for (const row of qcFrameRows) {
        for (const linked of row.linkedGenerations) {
          ids.add(linked.generation.genId);
        }
      }
      return [...ids];
    }
    return [] as string[];
  }, [qcFrameRows, reportView, scopedVideoRows]);

  useEffect(() => {
    setReportView("outputs");
    setActiveCustomReportId(null);
  }, [reportTaskId]);

  useEffect(() => {
    if (!activeCustomReportId) return;
    if (!reportCustomReports.some((report) => report.reportId === activeCustomReportId)) {
      setActiveCustomReportId(null);
      setReportView("outputs");
    }
  }, [activeCustomReportId, reportCustomReports]);

  useEffect(() => {
    setFirstFrameId(null);
    setLastFrameId(null);
    setEditSourceVariantIds({ first: null, last: null });
    setCompareVariantIds({ first: null, last: null });
    setPatchReferenceImages((previous) => {
      for (const item of [previous.first, previous.last]) {
        if (item?.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return { first: null, last: null };
    });
  }, [selectedTaskId]);

  useEffect(() => {
    setEditSourceVariantIds((previous) => {
      let changed = false;
      const next = { ...previous };
      if (previous.first && !editFirstFrame?.variants.some((variant) => variant.variantId === previous.first)) {
        next.first = null;
        changed = true;
      }
      if (previous.last && !editLastFrame?.variants.some((variant) => variant.variantId === previous.last)) {
        next.last = null;
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [editFirstFrame?.frameId, editFirstFrame?.variants, editLastFrame?.frameId, editLastFrame?.variants]);

  useEffect(() => {
    setCompareVariantIds((previous) => {
      let changed = false;
      const next = { ...previous };
      if (previous.first && !editFirstFrame?.variants.some((variant) => variant.variantId === previous.first)) {
        next.first = null;
        changed = true;
      }
      if (previous.last && !editLastFrame?.variants.some((variant) => variant.variantId === previous.last)) {
        next.last = null;
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [editFirstFrame?.frameId, editFirstFrame?.variants, editLastFrame?.frameId, editLastFrame?.variants]);

  useEffect(() => {
    return () => {
      for (const item of [patchReferenceImages.first, patchReferenceImages.last]) {
        if (item?.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
    };
  }, [patchReferenceImages.first, patchReferenceImages.last]);

  useEffect(() => {
    if (firstFrameId && !task?.frames[firstFrameId]) setFirstFrameId(null);
    if (lastFrameId && !task?.frames[lastFrameId]) setLastFrameId(null);
  }, [firstFrameId, lastFrameId, task]);

  useEffect(() => {
    if (tab === "generate" && selectedTaskId) {
      queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    }
  }, [queryClient, selectedTaskId, tab]);

  useEffect(() => {
    if (tab === "assets") {
      setUploadAssetsVisible(6);
      setFrameAssetsVisible(6);
      setVideoAssetsVisible(6);
    }
  }, [tab]);

  useEffect(() => {
    if (!activeFrameWidth || !activeFrameHeight) {
      setMaskHasPaint(false);
      patchDrawStateRef.current = null;
      return;
    }
    const width = activeFrameWidth;
    const height = activeFrameHeight;
    const maskCanvas = patchMaskCanvasRef.current ?? document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext("2d");
    if (maskCtx) {
      maskCtx.clearRect(0, 0, width, height);
    }
    patchMaskCanvasRef.current = maskCanvas;
    const overlay = patchOverlayCanvasRef.current;
    if (overlay) {
      overlay.width = width;
      overlay.height = height;
    }
    patchDrawStateRef.current = null;
    setMaskHasPaint(false);
    renderPatchOverlay();
  }, [activeEditFrame?.frameId, activeFrameWidth, activeFrameHeight]);

  useEffect(() => {
    const status = pendingCreateJobQuery.data?.status;
    if (newTaskStage !== "ingesting" || !status) return;
    if (status === "complete") {
      setNewTaskStage("idle");
      setPendingCreateJobId(null);
      setNewTaskError(null);
      setIsNewTaskModalOpen(false);
      setTab("timeline");
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (selectedTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      }
      return;
    }
    if (status === "failed") {
      setNewTaskStage("error");
      setNewTaskError(pendingCreateJobQuery.data?.error || "Ingest failed");
      setPendingCreateJobId(null);
    }
  }, [newTaskStage, pendingCreateJobQuery.data, queryClient, selectedTaskId]);

  useEffect(() => {
    const frameId = activeEditFrame?.frameId ?? null;
    if (frameId && frameId !== selectedFrameId) {
      setSelectedFrameId(frameId);
    }
  }, [activeEditFrame?.frameId, selectedFrameId, setSelectedFrameId]);

  useEffect(() => {
    const maxFrame = Math.max(0, frameCount(task) - 1);
    if (currentFrameIndex > maxFrame) setCurrentFrameIndex(maxFrame);
  }, [currentFrameIndex, setCurrentFrameIndex, task]);

  useEffect(() => {
    if (!task?.video?.editSource) return;
    const videoEl = timelineVideoRef.current;
    if (!videoEl) return;
    const fps = fpsValue(task);
    const targetSeconds = currentFrameIndex / fps;
    if (Math.abs(videoEl.currentTime - targetSeconds) > 0.06) {
      videoEl.currentTime = targetSeconds;
    }
  }, [currentFrameIndex, task]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!task?.video?.editSource) return;
      if (ev.key === "ArrowRight") {
        setCurrentFrameIndex(Math.min(frameCount(task) - 1, currentFrameIndex + 1));
      } else if (ev.key === "ArrowLeft") {
        setCurrentFrameIndex(Math.max(0, currentFrameIndex - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentFrameIndex, setCurrentFrameIndex, task]);

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => apiClient.deleteTask(taskId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setSelectedTaskId(null);
    },
  });
  const deleteAssetMutation = useMutation({
    mutationFn: async ({
      taskId,
      payload,
    }: {
      taskId: string;
      payload: {
        assetType: "upload" | "frame_capture" | "frame_variant" | "segment_generation" | "export";
        frameId?: string;
        variantId?: string;
        genId?: string;
        exportId?: string;
      };
    }) => apiClient.deleteAsset(taskId, payload),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", variables.taskId] });
    },
  });

  const captureMutation = useMutation({
    mutationFn: async ({ frameIndex }: { frameIndex: number }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.captureFrame(selectedTaskId, frameIndex);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const createSegmentMutation = useMutation({
    mutationFn: async ({ startFrameIndex, endFrameExclusive }: { startFrameIndex: number; endFrameExclusive: number }) => {
      if (!selectedTaskId) throw new Error("Select task");
      const totalFrames = frameCount(task);
      if (totalFrames > 0 && (startFrameIndex < 0 || endFrameExclusive > totalFrames || endFrameExclusive <= startFrameIndex)) {
        throw new Error("Invalid frame range for segment");
      }
      const fps = fpsValue(task);
      const durationFrames = Math.max(1, endFrameExclusive - startFrameIndex);
      const durationSeconds = Math.max(1, Math.ceil(durationFrames / fps));
      const created = await apiClient.createSegment(selectedTaskId, {
        startFrameIndex,
        durationSeconds,
      });
      await apiClient.patchSegment(selectedTaskId, created.segmentId, {
        startFrameIndex,
        endFrameExclusive,
      });
      return created;
    },
    onSuccess: async (result) => {
      setSelectedSegmentId(result.segmentId);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const fullEditMutation = useMutation({
    mutationFn: async (frameId: string) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.fullEdit(selectedTaskId, frameId, {
        model,
        prompt,
        sourceVariantId: activeEditSourceVariantId ?? "original",
      });
    },
    onSuccess: (result) => setJobIds((prev) => Array.from(new Set([...prev, result.jobId]))),
  });

  const patchEditMutation = useMutation({
    mutationFn: async (frameId: string) => {
      if (!selectedTaskId) throw new Error("Select a task");
      if (!activeFrameDimensions) throw new Error("Frame dimensions unavailable");
      const hasMaskPaint = maskContainsPaint();
      setMaskHasPaint(hasMaskPaint);
      if (!hasMaskPaint) throw new Error("Draw a mask before generating a patch variant");
      const patchRect = {
        x: 0,
        y: 0,
        width: activeFrameDimensions.width,
        height: activeFrameDimensions.height,
      };
      const init = await apiClient.patchInit(selectedTaskId, frameId, {
        patchRect,
        featherPx,
        bleedPx: 0,
        hasMask: true,
        sourceVariantId: activeEditSourceVariantId ?? "original",
      });
      if (!init.maskUploadUrl || !init.maskKey) {
        throw new Error("Mask upload URL missing");
      }
      const maskBlob = await new Promise<Blob>((resolve, reject) => {
        const canvas = patchMaskCanvasRef.current;
        if (!canvas) {
          reject(new Error("Mask canvas unavailable"));
          return;
        }
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Failed to export mask"));
            return;
          }
          resolve(blob);
        }, "image/png");
      });
      await fetch(init.maskUploadUrl, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: maskBlob,
      });

      let referenceImageKey: string | undefined;
      if (patchEngine === "runware_ace_pp") {
        const reference = activePatchReference;
        if (!reference?.file) {
          throw new Error("Runware ACE++ requires one reference image");
        }
        if (reference.uploadedKey && reference.frameId === frameId) {
          referenceImageKey = reference.uploadedKey;
        } else {
          const uploadResp = await apiClient.createReferenceUploads(selectedTaskId, frameId, {
            files: [{ filename: reference.file.name, contentType: reference.file.type || "image/png" }],
          });
          const upload = uploadResp.uploads[0];
          if (!upload) {
            throw new Error("Reference upload URL missing");
          }
          const uploadResult = await fetch(upload.uploadUrl, {
            method: "PUT",
            headers: { "content-type": reference.file.type || "image/png" },
            body: reference.file,
          });
          if (!uploadResult.ok) {
            throw new Error(`Reference upload failed (${uploadResult.status})`);
          }
          referenceImageKey = upload.key;
          setPatchReferenceImages((previous) => {
            const existing = previous[editFrameTab];
            if (!existing) return previous;
            return {
              ...previous,
              [editFrameTab]: {
                ...existing,
                uploadedKey: upload.key,
                frameId,
              },
            };
          });
        }
      }

      return apiClient.patchSubmit(selectedTaskId, frameId, {
        model: patchEngine,
        prompt: patchPrompt,
        patchKey: init.patchKey,
        maskKey: init.maskKey,
        patchRect,
        featherPx,
        bleedPx: 0,
        referenceImageKey,
        runwareRepaintingScale: patchEngine === "runware_ace_pp" ? runwareRepaintingScale : undefined,
        edgeAwareRefine,
        edgeAwareStrength,
        edgeAwareRadiusPx,
        maskGrowPx,
        sourceVariantId: activeEditSourceVariantId ?? "original",
      });
    },
    onSuccess: (result) => setJobIds((prev) => Array.from(new Set([...prev, result.jobId]))),
  });

  const selectVariantMutation = useMutation({
    mutationFn: async ({ frameId, variantId }: { frameId: string; variantId: string }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.selectVariant(selectedTaskId, frameId, variantId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const generateSegmentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !selectedSegmentId) throw new Error("Select a segment");
      return apiClient.generateSegment(selectedTaskId, selectedSegmentId, {
        lumaModel,
        mode:
          lumaModel === "runway-gen4.5"
            ? "runway_i2v"
            : lumaModel === "kling-2.6"
              ? "kling_start_end"
              : lumaModel === "veo-3.1" || lumaModel === "veo-3.1-fast"
                ? "veo_start_end"
                : lumaModel === "wan2.2-a14b"
                  ? "wan_a14b_i2v"
                  : lumaModel === "wan2.2-animate"
                    ? "wan_animate_replace"
                : advancedMode,
        prompt: lumaModel === "wan2.2-animate" ? undefined : lumaPrompt.trim() || undefined,
        firstFrameVariantId: compareVariantIds.first || undefined,
        lastFrameVariantId: compareVariantIds.last || undefined,
      });
    },
    onSuccess: (result) => {
      setJobIds((prev) => Array.from(new Set([...prev, result.jobId])));
      setTab("generate");
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId) throw new Error("Select a task");
      const generationAdjustments =
        mergeTargetGeneration && selectedGenIds.includes(mergeTargetGeneration.genId)
          ? {
              [mergeTargetGeneration.genId]: {
                startFrameOverride: mergeInsertStartFrameClamped,
                trimStartFrames: mergeTrimStartClamped,
                trimEndFrames: mergeTrimEndClamped,
              },
            }
          : undefined;
      return apiClient.merge(selectedTaskId, {
        selectedSegmentGenerationIds: selectedGenIds,
        temporalFeatherFrames: mergeFeatherClamped,
        generationAdjustments,
      });
    },
    onSuccess: (result) => {
      setJobIds((prev) => Array.from(new Set([...prev, result.jobId])));
      setTab("merge");
    },
  });

  const runQcMutation = useMutation({
    mutationFn: async ({ taskId, generationIds }: { taskId: string; generationIds?: string[] }) =>
      apiClient.runQc(taskId, generationIds?.length ? { generationIds } : undefined),
    onSuccess: async (result, variables) => {
      setJobIds((previous) => Array.from(new Set([...previous, result.jobId])));
      await queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", variables.taskId] });
    },
  });

  useEffect(() => {
    if (tab !== "report" || !reportTask || reportView === "outputs") return;
    const missing = scopedQcGenerationIds.filter((genId) => {
      const generation = reportTask.segmentGenerations?.[genId];
      return Boolean(
        generation &&
          generation.status === "complete" &&
          generation.outputKey &&
          generation.sourceFirstFrameVariantId &&
          !generation.qc,
      );
    });
    if (!missing.length) return;
    const runKey = `${reportTask.taskId}:${reportView}:${activeCustomReportId ?? "default"}:${missing.sort().join(",")}`;
    if (requestedAutoQcRef.current.has(runKey)) return;
    requestedAutoQcRef.current.add(runKey);
    void (async () => {
      for (let index = 0; index < missing.length; index += 20) {
        const generationIds = missing.slice(index, index + 20);
        try {
          await runQcMutation.mutateAsync({ taskId: reportTask.taskId, generationIds });
        } catch {
          break;
        }
      }
    })();
  }, [activeCustomReportId, reportTask, reportView, runQcMutation, scopedQcGenerationIds, tab]);

  const createCustomReportMutation = useMutation({
    mutationFn: ({
      taskId,
      reportType,
      outputRefs,
      name,
    }: {
      taskId: string;
      reportType: "qc_frame" | "qc_video";
      outputRefs: CustomReportOutputRef[];
      name?: string;
    }) => apiClient.createCustomReport(taskId, { reportType, outputRefs, name }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", variables.taskId] });
    },
  });

  const deleteCustomReportMutation = useMutation({
    mutationFn: ({ taskId, reportId }: { taskId: string; reportId: string }) => apiClient.deleteCustomReport(taskId, reportId),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", variables.taskId] });
    },
  });

  const jobQueries = useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: ["job", jobId],
      queryFn: () => apiClient.getJob(jobId),
      refetchInterval: (q: { state: { data?: { status?: string } } }) => {
        const status = q?.state?.data?.status;
        return status === "queued" || status === "running" ? 3000 : false;
      },
    })),
  });

  const seenDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const jq of jobQueries) {
      const data = jq.data;
      if (!data) continue;
      if ((data.status === "complete" || data.status === "failed") && !seenDoneRef.current.has(data.jobId)) {
        seenDoneRef.current.add(data.jobId);
        queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      }
    }
  }, [jobQueries, queryClient, selectedTaskId]);
  const sortedJobs = useMemo(
    () =>
      jobQueries
        .map((query) => query.data)
        .filter((job): job is NonNullable<typeof job> => Boolean(job))
        .sort(
          (a, b) =>
            new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
            new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
        ),
    [jobQueries],
  );

  const segmentGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {})
        .filter((generation) => generation.status !== "failed")
        .sort(
        (a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt),
      ),
    [task?.segmentGenerations],
  );
  const selectedSegmentGenerations = useMemo(
    () =>
      segmentGenerations
        .filter((gen) => !selectedSegmentId || gen.segmentId === selectedSegmentId)
        .sort((a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt)),
    [segmentGenerations, selectedSegmentId],
  );
  const selectedMergeGenerations = useMemo(
    () =>
      selectedGenIds
        .map((genId) => task?.segmentGenerations?.[genId])
        .filter((generation): generation is SegmentGeneration => Boolean(generation))
        .sort((a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt)),
    [selectedGenIds, task?.segmentGenerations],
  );
  const selectedPreviewGeneration =
    selectedSegmentGenerations.find((gen) => gen.genId === selectedPreviewGenId) ?? selectedSegmentGenerations[0] ?? null;
  const sortedExports = useMemo(
    () => [...(task?.exports ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [task?.exports],
  );
  const mergeTargetGeneration = selectedMergeGenerations[0] ?? null;
  const mergeTargetSegment = mergeTargetGeneration ? segmentsById.get(mergeTargetGeneration.segmentId) ?? null : null;
  const mergeFps = fpsValue(task);
  const mergeOriginalStartFrame = mergeTargetSegment?.startFrame ?? 0;
  const mergeOriginalEndFrameExclusive = mergeTargetSegment?.endFrameExclusive ?? mergeOriginalStartFrame + 1;
  const mergeOriginalDurationFrames = Math.max(1, mergeOriginalEndFrameExclusive - mergeOriginalStartFrame);
  const mergeProviderDurationSec =
    asNumber(mergeTargetGeneration?.providerDurationSec) ??
    asNumber(mergeTargetGeneration?.generationSettings?.providerDurationSec) ??
    mergeTargetSegment?.durationSec ??
    mergeOriginalDurationFrames / (mergeFps || 30);
  const mergeGeneratedDurationFrames = Math.max(1, Math.round(Math.max(1 / Math.max(1, mergeFps), mergeProviderDurationSec) * mergeFps));
  const mergeMaxFrameIndex = Math.max(0, frameCount(task) - 1);
  const mergeInsertStartFrameClamped = clampInteger(mergeInsertStartFrame, 0, mergeMaxFrameIndex);
  const mergeTrimStartClamped = clampInteger(mergeTrimStartFrames, 0, Math.max(0, mergeGeneratedDurationFrames - 1));
  const mergeTrimEndClamped = clampInteger(
    mergeTrimEndFrames,
    0,
    Math.max(0, mergeGeneratedDurationFrames - 1 - mergeTrimStartClamped),
  );
  const mergeEffectiveDurationFrames = Math.max(1, mergeGeneratedDurationFrames - mergeTrimStartClamped - mergeTrimEndClamped);
  const mergeEffectiveEndFrameExclusive = mergeInsertStartFrameClamped + mergeEffectiveDurationFrames;
  const mergeEndOffsetFrames = mergeEffectiveEndFrameExclusive - mergeOriginalEndFrameExclusive;
  const mergeGeneratedStartAnchor = mergeTrimStartClamped;
  const mergeGeneratedEndAnchor = mergeTrimStartClamped + mergeEffectiveDurationFrames - 1;
  const mergeFeatherClamped = clampInteger(temporalFeatherFrames, 0, 30);
  const mergeOriginalVideoForPreview = task?.video?.previewSource?.downloadUrl ?? task?.video?.editSource?.downloadUrl ?? null;
  const mergeGeneratedVideoForPreview = mergeTargetGeneration?.downloadUrl ?? null;
  const startBoundaryOriginalFrames = useMemo(
    () => frameWindow(mergeInsertStartFrameClamped, 3, 3, 0, mergeMaxFrameIndex),
    [mergeInsertStartFrameClamped, mergeMaxFrameIndex],
  );
  const endBoundaryOriginalFrames = useMemo(
    () => frameWindow(mergeEffectiveEndFrameExclusive, 3, 3, 0, mergeMaxFrameIndex),
    [mergeEffectiveEndFrameExclusive, mergeMaxFrameIndex],
  );
  const generatedMaxFrameIndex = Math.max(0, mergeGeneratedDurationFrames - 1);
  const startBoundaryGeneratedFrames = useMemo(
    () => frameWindow(mergeGeneratedStartAnchor, 3, 3, 0, generatedMaxFrameIndex),
    [generatedMaxFrameIndex, mergeGeneratedStartAnchor],
  );
  const endBoundaryGeneratedFrames = useMemo(
    () => frameWindow(mergeGeneratedEndAnchor, 3, 3, 0, generatedMaxFrameIndex),
    [generatedMaxFrameIndex, mergeGeneratedEndAnchor],
  );
  const startBoundaryOriginalThumbs = useVideoFrameStrip({
    videoUrl: mergeOriginalVideoForPreview,
    fps: mergeFps,
    frameIndices: startBoundaryOriginalFrames,
    cachePrefix: "merge:start:original",
  });
  const startBoundaryGeneratedThumbs = useVideoFrameStrip({
    videoUrl: mergeGeneratedVideoForPreview,
    fps: mergeFps,
    frameIndices: startBoundaryGeneratedFrames,
    cachePrefix: "merge:start:generated",
  });
  const endBoundaryGeneratedThumbs = useVideoFrameStrip({
    videoUrl: mergeGeneratedVideoForPreview,
    fps: mergeFps,
    frameIndices: endBoundaryGeneratedFrames,
    cachePrefix: "merge:end:generated",
  });
  const endBoundaryOriginalThumbs = useVideoFrameStrip({
    videoUrl: mergeOriginalVideoForPreview,
    fps: mergeFps,
    frameIndices: endBoundaryOriginalFrames,
    cachePrefix: "merge:end:original",
  });
  const lumaHardLimitSeconds = lumaModelMaxDurationSeconds(lumaModel);
  const hasHardDurationLimit =
    lumaModel === "ray-2" ||
    lumaModel === "ray-flash-2" ||
    lumaModel === "runway-gen4.5" ||
    lumaModel === "kling-2.6" ||
    lumaModel === "veo-3.1" ||
    lumaModel === "veo-3.1-fast" ||
    lumaModel === "wan2.2-a14b" ||
    lumaModel === "wan2.2-animate";
  const lumaHardLimitFrames = Math.round(lumaHardLimitSeconds * fpsValue(task));
  const timelineDelta = useMemo(() => {
    const fps = fpsValue(task);
    const anchorA = firstFrame?.frameIndex ?? lastFrame?.frameIndex ?? null;
    const anchorB = firstFrame?.frameIndex != null && lastFrame?.frameIndex != null ? lastFrame.frameIndex : currentFrameIndex;
    if (anchorA == null) {
      return { frames: 0, seconds: 0, overLimit: false };
    }
    const frames = Math.abs(anchorB - anchorA);
    const seconds = frames / fps;
    return { frames, seconds, overLimit: hasHardDurationLimit && seconds > lumaHardLimitSeconds };
  }, [currentFrameIndex, firstFrame, hasHardDurationLimit, lastFrame, lumaHardLimitSeconds, task]);

  const selectedRange = useMemo(() => {
    if (!firstFrame || !lastFrame) return null;
    const fps = fpsValue(task);
    const start = Math.min(firstFrame.frameIndex, lastFrame.frameIndex);
    const end = Math.max(firstFrame.frameIndex, lastFrame.frameIndex);
    const durationFrames = end - start + 1;
    const durationSec = durationFrames / fps;
    return {
      startFrame: start,
      endFrameInclusive: end,
      endFrameExclusive: end + 1,
      durationFrames,
      durationSec,
      overLimit: hasHardDurationLimit && durationSec > lumaHardLimitSeconds,
    };
  }, [firstFrame, hasHardDurationLimit, lastFrame, lumaHardLimitSeconds, task]);

  const selectedSegmentOverLimit = useMemo(() => {
    if (!selectedSegment || !hasHardDurationLimit) return false;
    return selectedSegment.durationSec > lumaHardLimitSeconds + 1e-6;
  }, [hasHardDurationLimit, lumaHardLimitSeconds, selectedSegment]);
  const generationModelOptions = useMemo(
    () => GENERATION_MODELS_BY_INPUT[generationInputMode],
    [generationInputMode],
  );
  useEffect(() => {
    if (generationModelOptions.some((option) => option.value === lumaModel)) {
      return;
    }
    const fallback = generationModelOptions[0]?.value;
    if (!fallback) return;
    setGenerationModelByInput((previous) => ({ ...previous, [generationInputMode]: fallback }));
    setLumaModel(fallback);
  }, [generationInputMode, generationModelOptions, lumaModel]);
  const generationHelp = useMemo(() => generationModelHelp(lumaModel, advancedMode), [advancedMode, lumaModel]);
  const generationInputNote = useMemo(() => {
    if (lumaModel === "wan2.2-a14b" || lumaModel === "runway-gen4.5") {
      return "Start frame variant is taken automatically from your Edit Frame selection.";
    }
    if (lumaModel === "wan2.2-animate") {
      return "Wan2.2 Animate uses start frame + source segment video. Text prompt is disabled in this flow unless LoRA inputs are used.";
    }
    if (generationInputMode === "start_only" && (lumaModel === "kling-2.6" || lumaModel === "veo-3.1" || lumaModel === "veo-3.1-fast")) {
      return "This model can use start+end frames. In this tab, generation can run from start frame only; if an end frame is selected it will still be used.";
    }
    return "Start and end frame variants are taken automatically from your Edit Frame selections.";
  }, [generationInputMode, lumaModel]);

  const uploadAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      const original = taskItem.video?.original;
      if (!original?.downloadUrl) continue;
      assets.push({
        id: `upload:${taskItem.taskId}`,
        taskId: taskItem.taskId,
        title: humanizeFilename(keyBasenameFromS3Key(original.s3Key || original.filename || "orig.mp4")),
        subtitle: taskItem.name,
        createdAt: taskItem.createdAt,
        previewUrl: original.downloadUrl,
        downloadUrl: original.downloadUrl,
        mediaType: "video",
        deletePayload: { assetType: "upload" },
      });
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks]);

  const frameAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      for (const frame of Object.values(taskItem.frames ?? {})) {
        if (frame.imageUrl) {
          assets.push({
            id: `capture:${taskItem.taskId}:${frame.frameId}`,
            taskId: taskItem.taskId,
            title: humanizeFilename(keyBasenameFromS3Key(frame.captureKey)),
            subtitle: `${taskItem.name} · ${frame.timecode}`,
            createdAt: frame.createdAt ?? taskItem.updatedAt,
            previewUrl: frame.imageUrl,
            downloadUrl: frame.imageUrl,
            mediaType: "image",
            deletePayload: { assetType: "frame_capture", frameId: frame.frameId },
          });
        }
        for (const variant of frame.variants ?? []) {
          if (!variant.imageUrl) continue;
          assets.push({
            id: `variant:${taskItem.taskId}:${frame.frameId}:${variant.variantId}`,
            taskId: taskItem.taskId,
            title: humanizeFilename(keyBasenameFromS3Key(variant.outputKey)),
            subtitle: `${taskItem.name} · frame ${frame.frameIndex} · ${variant.model}/${variant.type}`,
            createdAt: variant.createdAt,
            previewUrl: variant.imageUrl,
            downloadUrl: variant.imageUrl,
            mediaType: "image",
            customReportRef: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
            deletePayload: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
          });
        }
      }
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks]);

  const outputVideoAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      for (const generation of Object.values(taskItem.segmentGenerations ?? {})) {
        if (generation.status === "failed") continue;
        if (!generation.downloadUrl) continue;
          assets.push({
            id: `generation:${taskItem.taskId}:${generation.genId}`,
            taskId: taskItem.taskId,
            title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
          subtitle: `${taskItem.name} · ${generation.luma.model} · ${generation.luma.mode}`,
          createdAt: generation.createdAt,
            previewUrl: generation.downloadUrl,
            downloadUrl: generation.downloadUrl,
            mediaType: "video",
            customReportRef: { assetType: "segment_generation", genId: generation.genId },
            deletePayload: { assetType: "segment_generation", genId: generation.genId },
          });
        }
      for (const exportItem of taskItem.exports ?? []) {
        if (!exportItem.downloadUrl) continue;
        assets.push({
          id: `export:${taskItem.taskId}:${exportItem.exportId}`,
          taskId: taskItem.taskId,
          title: humanizeFilename(keyBasenameFromS3Key(exportItem.outputKey || `${exportItem.exportId}.mp4`)),
          subtitle: taskItem.name,
          createdAt: exportItem.createdAt,
          previewUrl: exportItem.downloadUrl,
          downloadUrl: exportItem.downloadUrl,
          mediaType: "video",
          deletePayload: { assetType: "export", exportId: exportItem.exportId },
        });
      }
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks]);

  const segmentWindow = useMemo(() => {
    if (!selectedSegment || !task) return null;
    const fps = fpsValue(task);
    const startSec = selectedSegment.startFrame / fps;
    const endSec = selectedSegment.endFrameExclusive / fps;
    return {
      startSec,
      endSec,
      startLabel: startSec.toFixed(2),
      endLabel: endSec.toFixed(2),
    };
  }, [selectedSegment, task]);

  const originalSegmentPreviewUrl = useMemo(() => {
    if (!task?.video?.editSource?.downloadUrl || !segmentWindow) return null;
    return `${task.video.editSource.downloadUrl}#t=${segmentWindow.startSec},${segmentWindow.endSec}`;
  }, [segmentWindow, task?.video?.editSource?.downloadUrl]);
  const timelinePlaybackUrl = task?.video?.previewSource?.downloadUrl ?? task?.video?.editSource?.downloadUrl ?? "";

  useEffect(() => {
    setSelectedGenIds((previous) => {
      const filtered = previous.filter((genId) => {
        const generation = task?.segmentGenerations?.[genId];
        return Boolean(generation && generation.status !== "failed");
      });
      return filtered.length === previous.length ? previous : filtered;
    });
  }, [task?.segmentGenerations]);

  useEffect(() => {
    if (!selectedSegmentGenerations.length) {
      setSelectedPreviewGenId("");
      return;
    }
    const stillValid = selectedSegmentGenerations.some((gen) => gen.genId === selectedPreviewGenId);
    if (!stillValid) {
      setSelectedPreviewGenId(selectedSegmentGenerations[0].genId);
    }
  }, [selectedPreviewGenId, selectedSegmentGenerations]);

  useEffect(() => {
    const selectedId = selectedPreviewGeneration?.genId;
    if (!selectedId) {
      setSelectedGenIds([]);
      return;
    }
    setSelectedGenIds([selectedId]);
  }, [selectedPreviewGeneration?.genId, task?.segmentGenerations]);

  useEffect(() => {
    const generationId = mergeTargetGeneration?.genId ?? "";
    if (!generationId) {
      setMergeConfiguredGenId("");
      return;
    }
    if (generationId === mergeConfiguredGenId) return;
    setMergeConfiguredGenId(generationId);
    setMergeInsertStartFrame(mergeTargetSegment?.startFrame ?? 0);
    setMergeTrimStartFrames(0);
    setMergeTrimEndFrames(0);
  }, [mergeConfiguredGenId, mergeTargetGeneration?.genId, mergeTargetSegment?.startFrame]);

  useEffect(() => {
    if (mergeInsertStartFrame !== mergeInsertStartFrameClamped) {
      setMergeInsertStartFrame(mergeInsertStartFrameClamped);
    }
    if (mergeTrimStartFrames !== mergeTrimStartClamped) {
      setMergeTrimStartFrames(mergeTrimStartClamped);
    }
    if (mergeTrimEndFrames !== mergeTrimEndClamped) {
      setMergeTrimEndFrames(mergeTrimEndClamped);
    }
  }, [
    mergeInsertStartFrame,
    mergeInsertStartFrameClamped,
    mergeTrimEndClamped,
    mergeTrimEndFrames,
    mergeTrimStartClamped,
    mergeTrimStartFrames,
  ]);

  function selectSegmentGeneration(genId: string) {
    const selectedGeneration = task?.segmentGenerations?.[genId];
    if (!selectedGeneration || selectedGeneration.status === "failed") return;
    setSelectedPreviewGenId(genId);
    setSelectedGenIds((previous) => {
      const targetSegmentId = selectedGeneration?.segmentId;
      const filtered = previous.filter((existingGenId) => {
        if (existingGenId === genId) return false;
        if (!targetSegmentId) return true;
        const existing = task?.segmentGenerations?.[existingGenId];
        return existing?.segmentId !== targetSegmentId && existing?.status !== "failed";
      });
      return [genId, ...filtered];
    });
  }

  function syncOriginalToGenerated(generatedVideo: HTMLVideoElement) {
    const originalVideo = compareOriginalRef.current;
    if (!originalVideo || !segmentWindow) return;
    const targetTime = segmentWindow.startSec + generatedVideo.currentTime;
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    if (Math.abs(originalVideo.currentTime - targetTime) > 0.05) {
      originalVideo.currentTime = targetTime;
    }
    window.setTimeout(() => {
      syncLockRef.current = false;
    }, 0);
  }

  function keepOriginalWithinSegment(video: HTMLVideoElement) {
    if (!segmentWindow) return;
    if (video.currentTime < segmentWindow.startSec) {
      video.currentTime = segmentWindow.startSec;
    }
    if (video.currentTime >= segmentWindow.endSec) {
      video.currentTime = segmentWindow.startSec;
    }
  }

  function mapPointerToMaskCoordinates(event: PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) {
    const maskCanvas = patchMaskCanvasRef.current;
    if (!maskCanvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((event.clientX - rect.left) / rect.width) * maskCanvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * maskCanvas.height;
    return {
      x: Math.max(0, Math.min(maskCanvas.width - 1, x)),
      y: Math.max(0, Math.min(maskCanvas.height - 1, y)),
    };
  }

  function patchToolUsesLasso(tool: PatchToolMode): boolean {
    return tool === "lasso_add" || tool === "lasso_erase";
  }

  function patchToolModeToMaskMode(tool: PatchToolMode): "add" | "erase" {
    return tool === "brush_erase" || tool === "lasso_erase" ? "erase" : "add";
  }

  function renderPatchOverlay(previewPolygon: MaskPoint[] = []) {
    const maskCanvas = patchMaskCanvasRef.current;
    const overlayCanvas = patchOverlayCanvasRef.current;
    if (!maskCanvas || !overlayCanvas) return;
    const overlayCtx = overlayCanvas.getContext("2d");
    if (!overlayCtx) return;

    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.fillStyle = "rgba(94, 176, 173, 0.72)";
    overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.globalCompositeOperation = "destination-in";
    overlayCtx.drawImage(maskCanvas, 0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.globalCompositeOperation = "source-over";

    if (previewPolygon.length >= 2) {
      overlayCtx.save();
      overlayCtx.strokeStyle = "rgba(20, 96, 94, 0.95)";
      overlayCtx.fillStyle = "rgba(20, 96, 94, 0.18)";
      overlayCtx.lineWidth = 2;
      overlayCtx.setLineDash([8, 6]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(previewPolygon[0].x, previewPolygon[0].y);
      for (const point of previewPolygon.slice(1)) {
        overlayCtx.lineTo(point.x, point.y);
      }
      overlayCtx.closePath();
      overlayCtx.stroke();
      overlayCtx.fill();
      overlayCtx.restore();
    }
  }

  function maskContainsPaint(): boolean {
    const maskCanvas = patchMaskCanvasRef.current;
    if (!maskCanvas) return false;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return false;
    const data = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 5) return true;
    }
    return false;
  }

  function paintMaskStroke(x: number, y: number, prev: MaskPoint | null, mode: "add" | "erase") {
    const maskCanvas = patchMaskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return;

    const isErase = mode === "erase";
    maskCtx.globalCompositeOperation = isErase ? "destination-out" : "source-over";
    maskCtx.strokeStyle = "rgba(255,255,255,1)";
    maskCtx.fillStyle = "rgba(255,255,255,1)";
    maskCtx.lineCap = "round";
    maskCtx.lineJoin = "round";
    maskCtx.lineWidth = patchBrushSize;

    if (!prev) {
      maskCtx.beginPath();
      maskCtx.arc(x, y, patchBrushSize / 2, 0, Math.PI * 2);
      maskCtx.fill();
    } else {
      maskCtx.beginPath();
      maskCtx.moveTo(prev.x, prev.y);
      maskCtx.lineTo(x, y);
      maskCtx.stroke();
    }
    maskCtx.globalCompositeOperation = "source-over";
    renderPatchOverlay();
  }

  function fillMaskPolygon(points: MaskPoint[], mode: "add" | "erase") {
    if (points.length < 3) return;
    const maskCanvas = patchMaskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return;
    maskCtx.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
    maskCtx.fillStyle = "rgba(255,255,255,1)";
    maskCtx.beginPath();
    maskCtx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) {
      maskCtx.lineTo(point.x, point.y);
    }
    maskCtx.closePath();
    maskCtx.fill();
    maskCtx.globalCompositeOperation = "source-over";
    renderPatchOverlay();
  }

  function clearPatchMask() {
    const maskCanvas = patchMaskCanvasRef.current;
    if (maskCanvas) {
      const maskCtx = maskCanvas.getContext("2d");
      if (maskCtx) {
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      }
    }
    renderPatchOverlay();
    patchDrawStateRef.current = null;
    setMaskHasPaint(false);
  }

  function setPatchReferenceForTab(tabKey: "first" | "last", file: File) {
    setPatchReferenceImages((previous) => {
      const existing = previous[tabKey];
      if (existing?.previewUrl) {
        URL.revokeObjectURL(existing.previewUrl);
      }
      return {
        ...previous,
        [tabKey]: {
          file,
          previewUrl: URL.createObjectURL(file),
          uploadedKey: undefined,
          frameId: undefined,
        },
      };
    });
  }

  function clearPatchReferenceForTab(tabKey: "first" | "last") {
    setPatchReferenceImages((previous) => {
      const existing = previous[tabKey];
      if (existing?.previewUrl) {
        URL.revokeObjectURL(existing.previewUrl);
      }
      return { ...previous, [tabKey]: null };
    });
  }

  function onPatchMaskPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = patchOverlayCanvasRef.current;
    if (!canvas) return;
    const coords = mapPointerToMaskCoordinates(event, canvas);
    if (!coords) return;
    patchDrawStateRef.current = { tool: patchToolMode, points: [coords], last: coords };
    canvas.setPointerCapture(event.pointerId);
    if (!patchToolUsesLasso(patchToolMode)) {
      paintMaskStroke(coords.x, coords.y, null, patchToolModeToMaskMode(patchToolMode));
      setMaskHasPaint(maskContainsPaint());
    } else {
      renderPatchOverlay([coords]);
    }
  }

  function onPatchMaskPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = patchOverlayCanvasRef.current;
    const state = patchDrawStateRef.current;
    if (!canvas || !state) return;
    const coords = mapPointerToMaskCoordinates(event, canvas);
    if (!coords) return;
    if (patchToolUsesLasso(state.tool)) {
      const previousPoint = state.points[state.points.length - 1];
      if (!previousPoint || Math.hypot(previousPoint.x - coords.x, previousPoint.y - coords.y) >= 2) {
        const updatedPoints = [...state.points, coords];
        patchDrawStateRef.current = { ...state, points: updatedPoints, last: coords };
        renderPatchOverlay(updatedPoints);
      }
      return;
    }
    paintMaskStroke(coords.x, coords.y, state.last, patchToolModeToMaskMode(state.tool));
    patchDrawStateRef.current = { ...state, points: [...state.points, coords], last: coords };
    setMaskHasPaint(maskContainsPaint());
  }

  function onPatchMaskPointerUp(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = patchOverlayCanvasRef.current;
    if (!canvas) return;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    const state = patchDrawStateRef.current;
    if (state && patchToolUsesLasso(state.tool)) {
      fillMaskPolygon(state.points, patchToolModeToMaskMode(state.tool));
      setMaskHasPaint(maskContainsPaint());
    }
    patchDrawStateRef.current = null;
    renderPatchOverlay();
  }

  function formatAssetDate(iso: string) {
    const asDate = new Date(iso);
    if (Number.isNaN(asDate.getTime())) return iso;
    return asDate.toLocaleString();
  }

  function describeSegment(segment: SegmentRecord): string {
    const endFrameInclusive = Math.max(segment.endFrameExclusive - 1, segment.startFrame);
    return `f${segment.startFrame}-f${endFrameInclusive} · ${segment.durationSec.toFixed(2)}s · ${segment.startTimecode}→${segment.endTimecode}`;
  }

  function describeGeneration(generation: SegmentGeneration): string {
    const segment = segmentsById.get(generation.segmentId);
    const segmentText = segment ? describeSegment(segment) : generation.segmentId;
    const outputLabel = generation.outputKey
      ? humanizeFilename(keyBasenameFromS3Key(generation.outputKey))
      : truncateIdentifier(generation.genId, 12);
    return `${outputLabel} · ${generation.luma.model}/${generation.luma.mode} · ${segmentText} · ${formatCompactTimestamp(generation.createdAt)}`;
  }

  function formatResolution(resolution: { width: number; height: number } | null | undefined): string {
    if (!resolution) return "unknown";
    return `${resolution.width}x${resolution.height}`;
  }

  function asNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function describeFrame(frame: FrameRecord | null): string {
    if (!frame) return "Not available";
    return `frame ${frame.frameIndex} · ${frame.timecode}`;
  }

  function describeImageEditSettings(variant: FrameVariant | null): string {
    if (!variant) return "No edited frame selected";
    const settings = variant.generationSettings;
    const details = [
      `${variant.model}/${variant.type}`,
      settings?.provider ? `provider ${settings.provider}` : null,
      settings?.inputResolution ? `input ${formatResolution(settings.inputResolution)}` : null,
      settings?.outputResolution ? `output ${formatResolution(settings.outputResolution)}` : null,
      typeof settings?.runwareRepaintingScale === "number" ? `inpainting scale ${settings.runwareRepaintingScale.toFixed(2)}` : null,
      typeof settings?.featherPx === "number" ? `feather ${settings.featherPx}px` : null,
    ].filter(Boolean);
    return details.join(" · ");
  }

  function describeVideoGenerationSettings(generation: SegmentGeneration): string {
    const settings = generation.generationSettings;
    const details = [
      `${generation.luma.model}/${generation.luma.mode}`,
      settings?.mediaResolution ? `video ${formatResolution(settings.mediaResolution)}` : null,
      settings?.firstFrameResolution ? `frame ${formatResolution(settings.firstFrameResolution)}` : null,
      typeof settings?.requestedDurationSec === "number" ? `requested ${settings.requestedDurationSec.toFixed(2)}s` : null,
      typeof settings?.providerDurationSec === "number" ? `provider ${settings.providerDurationSec.toFixed(2)}s` : null,
    ].filter(Boolean);
    return details.join(" · ");
  }

  function generationModelHelp(modelName: VideoModel, modeValue: string) {
    if (modelName === "kling-2.6") {
      return {
        title: "Kling 2.6 Start/End",
        lines: [
          "Uses start frame + end frame + segment duration. It does not use the source segment video for motion.",
          "Best prompt style: describe camera motion and action between start and end frames.",
          "Keep prompts temporal and concrete, for example 'slow push in, subtle cloth movement, keep background stable'.",
        ],
      };
    }
    if (modelName === "runway-gen4.5") {
      return {
        title: "Runway Gen-4.5",
        lines: [
          "Uses only the selected start frame as the initial frame. It does not use source segment motion.",
          "Best prompt style: describe the motion and evolution from frame one while preserving composition.",
          "Avoid conflicting scene changes in one prompt; short and specific prompts usually hold frame identity better.",
        ],
      };
    }
    if (modelName === "veo-3.1" || modelName === "veo-3.1-fast") {
      return {
        title: modelName === "veo-3.1-fast" ? "Runware Veo 3.1 Fast (No Audio)" : "Runware Veo 3.1 (No Audio)",
        lines: [
          "Uses selected start and end frames as keyframes. No source segment video is sent.",
          "Duration is fixed at 8 seconds for Veo 3.1 API runs; merged output may be time-adjusted at insert.",
          "Prompting works best with clear motion direction and continuity constraints between start and end frames.",
        ],
      };
    }
    if (modelName === "wan2.2-a14b") {
      return {
        title: "Runware Wan2.2 A14B",
        lines: [
          "Best for high-quality image-to-video from the selected start frame.",
          "Uses the start frame as the anchor image; this flow does not consume the source segment video.",
          "Prompt tips: describe camera motion and subject movement clearly, keep style constraints concise and specific.",
        ],
      };
    }
    if (modelName === "wan2.2-animate") {
      return {
        title: "Runware Wan2.2 Animate",
        lines: [
          "Best for realistic character replacement/animation using reference image + reference video motion.",
          "This flow uses selected start frame plus the source segment video as motion reference.",
          "Runware currently rejects positivePrompt for this model unless LoRA inputs are supplied, so this app uses reference-driven generation only.",
        ],
      };
    }
    return {
      title: modelName === "ray-flash-2" ? "Luma Ray Flash 2" : "Luma Ray 2",
      lines: [
        "Uses source segment video + selected start frame. The start frame anchors look/style while segment drives motion.",
        "Mode dropdown (Luma only): adhere = closest to source, flex = moderate change, reimagine = strongest change.",
        `Current mode: ${modeValue}. For stronger style shifts raise mode; for shot continuity lower mode and keep prompts concise.`,
      ],
    };
  }

  function toggleCustomReportOutput(taskId: string, ref: CustomReportOutputRef) {
    const key = `${taskId}:${reportOutputRefKey(ref)}`;
    setSelectedReportOutputs((previous) => {
      if (previous[key]) {
        const next = { ...previous };
        delete next[key];
        return next;
      }
      return { ...previous, [key]: { taskId, ref } };
    });
  }

  async function createCustomReportFromSelection(taskId: string, reportType: "qc_frame" | "qc_video") {
    const refsForTask = selectedOutputRefsByTask[taskId] ?? [];
    if (!refsForTask.length) {
      setCustomReportNotice("Select one or more outputs using the QC checkboxes first.");
      return;
    }
    const scopedRefs =
      reportType === "qc_video"
        ? refsForTask.filter((ref) => ref.assetType === "segment_generation")
        : refsForTask;
    if (!scopedRefs.length) {
      setCustomReportNotice(
        reportType === "qc_video"
          ? "QC Video reports require at least one selected video generation."
          : "No valid outputs selected for this report type.",
      );
      return;
    }
    try {
      const result = await createCustomReportMutation.mutateAsync({ taskId, reportType, outputRefs: scopedRefs });
      setCustomReportNotice("Custom report created.");
      setReportTaskId(taskId);
      setReportView(reportType);
      setActiveCustomReportId(result.reportId);
      setTab("report");
    } catch (error) {
      setCustomReportNotice(error instanceof Error ? error.message : "Failed to create custom report.");
    }
  }

  async function deleteCustomReport(taskId: string, report: CustomReportRecord) {
    const ok = window.confirm(`Delete custom report "${report.name}"?`);
    if (!ok) return;
    try {
      await deleteCustomReportMutation.mutateAsync({ taskId, reportId: report.reportId });
      if (activeCustomReportId === report.reportId) {
        setActiveCustomReportId(null);
        setReportView("outputs");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to delete report.");
    }
  }

  function openCustomReport(taskId: string, report: CustomReportRecord) {
    setReportTaskId(taskId);
    setActiveCustomReportId(report.reportId);
    setReportView(report.reportType);
    setTab("report");
  }

  function openTaskReport(taskId: string) {
    setReportTaskId(taskId);
    setReportView("outputs");
    setActiveCustomReportId(null);
    setSelectedTaskId(taskId);
    setTab("report");
  }

  async function ensureSegmentForSelectedFrames(): Promise<string | null> {
    if (!task || !selectedRange) return null;
    const existing = task.segments.find(
      (segment) =>
        segment.startFrame === selectedRange.startFrame &&
        segment.endFrameExclusive === selectedRange.endFrameExclusive,
    );
    if (existing) {
      setSelectedSegmentId(existing.segmentId);
      return existing.segmentId;
    }
    const created = await createSegmentMutation.mutateAsync({
      startFrameIndex: selectedRange.startFrame,
      endFrameExclusive: selectedRange.endFrameExclusive,
    });
    setSelectedSegmentId(created.segmentId);
    return created.segmentId;
  }

  async function handleTabChange(nextTab: TabId) {
    if (nextTab === tab) return;
    if (tab === "timeline" && nextTab !== "timeline" && nextTab !== "report") {
      if (!selectedRange) {
        window.alert("You need to pick a start and end frame before moving on.");
        return;
      }
      try {
        await ensureSegmentForSelectedFrames();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create segment from selected frames.";
        window.alert(message);
        return;
      }
    }
    setTab(nextTab);
  }

  function selectCompareCandidate(frameId: string, tabKey: "first" | "last", candidate: EditFrameCandidate) {
    const sourceVariantId = candidate.kind === "variant" ? candidate.variantId ?? null : null;
    setCompareVariantIds((previous) => ({ ...previous, [tabKey]: sourceVariantId }));
    const targetVariantId = candidate.kind === "original" ? "original" : candidate.variantId;
    if (!targetVariantId) return;
    selectVariantMutation.mutate({ frameId, variantId: targetVariantId });
  }

  function setEditSourceCandidate(tabKey: "first" | "last", candidate: EditFrameCandidate) {
    const sourceVariantId = candidate.kind === "variant" ? candidate.variantId ?? null : null;
    setEditSourceVariantIds((previous) => ({ ...previous, [tabKey]: sourceVariantId }));
  }

  async function handleDeleteAsset(item: LibraryAsset) {
    const ok = window.confirm(`Delete this asset?\n\n${item.title}`);
    if (!ok) return;
    try {
      await deleteAssetMutation.mutateAsync({ taskId: item.taskId, payload: item.deletePayload });
      if (item.customReportRef) {
        const key = `${item.taskId}:${reportOutputRefKey(item.customReportRef)}`;
        setSelectedReportOutputs((previous) => {
          if (!previous[key]) return previous;
          const next = { ...previous };
          delete next[key];
          return next;
        });
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to delete asset");
    }
  }

  async function captureCurrentFrameFor(boundary: "first" | "last") {
    const result = await captureMutation.mutateAsync({ frameIndex: currentFrameIndex });
    setSelectedFrameId(result.frameId);
    setEditSourceVariantIds((previous) => ({ ...previous, [boundary]: null }));
    setCompareVariantIds((previous) => ({ ...previous, [boundary]: null }));
    if (boundary === "first") {
      setFirstFrameId(result.frameId);
    } else {
      setLastFrameId(result.frameId);
    }
  }
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "timeline", label: "Pick Frame" },
    { id: "frames", label: "Edit Frame" },
    { id: "generate", label: "Generate Video" },
    { id: "merge", label: "Merge Video" },
    { id: "assets", label: "Download Assets" },
  ];

  function openNewTaskModal() {
    setNewTaskName("New VFX Task");
    setNewTaskFile(null);
    setNewTaskStage("idle");
    setNewTaskError(null);
    setNewTaskUploadPercent(0);
    setPendingCreateJobId(null);
    setIsNewTaskModalOpen(true);
  }

  function renderCustomReportBox(taskId: string | null, reports: CustomReportRecord[] | undefined) {
    const selectedCount = taskId ? (selectedOutputRefsByTask[taskId]?.length ?? 0) : 0;
    return (
      <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold">Create Custom Report</h3>
            <p className="text-xs text-ink/60">Selected outputs: {selectedCount}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!taskId || createCustomReportMutation.isPending}
              onClick={() => taskId && createCustomReportFromSelection(taskId, "qc_frame")}
            >
              Create QC Frame report
            </button>
            <button
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!taskId || createCustomReportMutation.isPending}
              onClick={() => taskId && createCustomReportFromSelection(taskId, "qc_video")}
            >
              Create QC Video report
            </button>
          </div>
        </div>
        {customReportNotice ? <p className="text-xs text-ink/70">{customReportNotice}</p> : null}
        {!reports?.length ? (
          <p className="text-sm text-ink/60">No custom reports yet.</p>
        ) : (
          <div className="space-y-2">
            {reports.map((report) => (
              <div key={report.reportId} className="flex items-center justify-between rounded border border-ink/10 bg-white p-2 text-sm">
                <button
                  type="button"
                  className="text-left text-ink underline"
                  onClick={() => taskId && openCustomReport(taskId, report)}
                >
                  {report.name} ({report.reportType === "qc_frame" ? "QC Frame" : "QC Video"})
                </button>
                <button
                  type="button"
                  className="text-xs text-red-600 underline"
                  disabled={!taskId || deleteCustomReportMutation.isPending}
                  onClick={() => taskId && deleteCustomReport(taskId, report)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  async function handleCreateTaskWithUpload() {
    if (!newTaskName.trim() || !newTaskFile) return;
    try {
      setNewTaskError(null);
      setNewTaskUploadPercent(0);
      const normalizedTaskName = normalizeTaskNameInput(newTaskName);
      if (!normalizedTaskName) {
        setNewTaskStage("error");
        setNewTaskError("Task name must include letters or numbers");
        return;
      }
      if (taskNameAlreadyExists) {
        setNewTaskStage("error");
        setNewTaskError("Task name already exists. Choose a unique name.");
        return;
      }
      setNewTaskStage("creating");
      setNewTaskName(normalizedTaskName);
      const created = await apiClient.createTask(normalizedTaskName);
      setSelectedTaskId(created.taskId);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });

      setNewTaskStage("uploading");
      const contentType = newTaskFile.type || "video/mp4";
      const upload = await apiClient.createVideoUpload(created.taskId, {
        filename: newTaskFile.name,
        contentType,
        sizeBytes: newTaskFile.size,
      });
      await uploadFileWithProgress(upload.uploadUrl, newTaskFile, contentType, setNewTaskUploadPercent);

      setNewTaskStage("ingesting");
      const ingest = await apiClient.ingestTask(created.taskId);
      setPendingCreateJobId(ingest.jobId);
      setJobIds((prev) => Array.from(new Set([...prev, ingest.jobId])));
    } catch (error) {
      setNewTaskStage("error");
      setNewTaskError(error instanceof Error ? error.message : "Task setup failed");
    }
  }

  if (!isAuthed) {
    return (
      <main className="min-h-screen bg-bg p-8 text-ink">
        <div className="mx-auto max-w-3xl rounded-2xl border border-ink/10 bg-card p-8 shadow-sm">
          <h1 className="text-3xl font-semibold">AI-assisted VFX Micro Pipeline</h1>
          <p className="mt-3 text-ink/70">Authenticate with Cognito to start creating tasks and processing video segments.</p>
          <button className="mt-6 rounded-lg bg-accent px-5 py-3 text-white" onClick={() => login()}>
            Sign In
          </button>
        </div>
      </main>
    );
  }

  if (tab === "report") {
    const reportPlaybackUrl = reportTask?.video?.editSource?.downloadUrl ?? reportTask?.video?.original?.downloadUrl ?? null;
    const segmentRows = [...(reportTask?.segments ?? [])].sort((a, b) => a.startFrame - b.startFrame);
    const latestQcJob =
      sortedJobs.find((job) => job.type === "qc_analysis" && (!reportTaskId || job.taskId === reportTaskId)) ?? null;
    return (
      <main className="min-h-screen bg-bg text-ink">
        <div className="mx-auto w-full max-w-[1700px] space-y-4 p-4 md:p-6">
          <div className="flex items-center justify-between rounded-2xl border border-ink/10 bg-card p-4">
            <div>
              <h2 className="text-xl font-semibold">
                Task Report: {reportTask?.name ?? reportTaskId ?? "Task"}
              </h2>
              {reportTask ? <p className="text-sm text-ink/60">Updated {formatAssetDate(reportTask.updatedAt)}</p> : null}
            </div>
            <div className="flex items-center gap-3">
              <button
                className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!reportTaskId || runQcMutation.isPending}
                onClick={() => {
                  if (!reportTaskId) return;
                  runQcMutation.mutate({ taskId: reportTaskId });
                }}
              >
                {runQcMutation.isPending ? "Starting QC..." : "Run QC Analysis"}
              </button>
              <button
                className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
                onClick={() => {
                  if (reportTaskId) setSelectedTaskId(reportTaskId);
                  setTab("timeline");
                }}
              >
                Back to Task
              </button>
              <button onClick={() => logout()} className="text-sm text-ink/60 underline">
                Sign out
              </button>
            </div>
          </div>
          {latestQcJob ? (
            <p className="text-xs text-ink/70">
              Latest QC job {truncateIdentifier(latestQcJob.jobId, 12)}: {latestQcJob.status} ({latestQcJob.progress}%)
            </p>
          ) : null}

          {reportTaskQuery.isPending ? <p className="text-sm text-ink/60">Loading report...</p> : null}
          {reportTaskQuery.error ? <p className="text-sm text-red-600">{(reportTaskQuery.error as Error).message}</p> : null}
          {runQcMutation.error ? <p className="text-sm text-red-600">{runQcMutation.error.message}</p> : null}

          {reportTask ? (
            <>
              <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">Original Video</h3>
                {reportPlaybackUrl ? (
                  <video src={reportPlaybackUrl} controls className="w-full rounded border border-ink/10 bg-bg object-contain" />
                ) : (
                  <p className="text-sm text-ink/60">Original video not available.</p>
                )}
              </section>

              <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">Segment Frame Timecode Summary</h3>
                {segmentRows.length === 0 ? (
                  <p className="text-sm text-ink/60">No segments yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full table-auto text-sm">
                      <thead>
                        <tr className="border-b border-ink/10 text-left">
                          <th className="px-2 py-2">Segment</th>
                          <th className="px-2 py-2">Start</th>
                          <th className="px-2 py-2">End</th>
                          <th className="px-2 py-2">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {segmentRows.map((segment) => (
                          <tr key={segment.segmentId} className="border-b border-ink/10 align-top">
                            <td className="px-2 py-2 font-medium">{segment.segmentId}</td>
                            <td className="px-2 py-2">
                              frame {segment.startFrame} · {segment.startTimecode}
                            </td>
                            <td className="px-2 py-2">
                              frame {Math.max(segment.endFrameExclusive - 1, segment.startFrame)} · {segment.endTimecode}
                            </td>
                            <td className="px-2 py-2">
                              {segment.durationFrames}f / {segment.durationSec.toFixed(2)}s
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">Generation Report</h3>
                {reportRows.rows.length === 0 ? (
                  <p className="text-sm text-ink/60">No video generations yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="table-fixed text-sm" style={{ minWidth: "120%" }}>
                      <thead>
                        <tr className="border-b border-ink/10 text-left text-sm">
                          <th className="w-1/5 px-2 py-2">Original Start Frame</th>
                          <th className="w-1/5 px-2 py-2">Mask + Prompt</th>
                          <th className="w-1/5 px-2 py-2">Edited Start Frame</th>
                          <th className="w-1/5 px-2 py-2">End Frame</th>
                          <th className="w-1/5 px-2 py-2">Generated Video</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportRows.rows.flatMap((row) => {
                          const frameMetrics = row.generation.qc?.frame?.metrics as Record<string, unknown> | undefined;
                          const frameArtifacts = row.generation.qc?.frame?.artifacts;
                          const videoAggregates = row.generation.qc?.video?.aggregates as Record<string, unknown> | undefined;
                          const videoArtifacts = row.generation.qc?.video?.artifacts;
                          const timelineGraphUrl = videoArtifacts?.timelineGraphUrl as string | undefined;
                          const timelineCsvUrl = videoArtifacts?.timelineCsvUrl as string | undefined;
                          const diffVideoUrl = videoArtifacts?.diffVideoUrl as string | undefined;
                          const boundaryOverlayUrl =
                            (frameArtifacts?.boundaryOverlayUrl as string | undefined) ??
                            (frameArtifacts?.binaryChangeUrl as string | undefined);
                          const heatmapUrl = frameArtifacts?.heatmapUrl as string | undefined;
                          const promptText = row.generation.luma.prompt?.trim() || "No prompt supplied";
                          const hasMask = Boolean(row.maskUrl);
                          const frameChangePct = asNumber(frameMetrics?.changedPctTotal);
                          const frameOutsidePct = asNumber(frameMetrics?.outsideLeakagePct);
                          const frameBoundaryPct = asNumber(frameMetrics?.boundarySpillPct);
                          const videoChangeMean = asNumber(videoAggregates?.changedPctTotalMean);
                          const videoOutsideMean = asNumber(videoAggregates?.outsideLeakagePctMean);
                          const ssimMean = asNumber(videoAggregates?.ssimMean);
                          const psnrMean = asNumber(videoAggregates?.psnrMean);
                          const vmafMean = asNumber((videoAggregates?.vmaf as Record<string, unknown> | undefined)?.mean);
                          const qcStatus = row.generation.qc?.status ?? "not_run";
                          const durationText = row.segment ? `${row.segment.durationFrames}f / ${row.segment.durationSec.toFixed(2)}s` : "n/a";

                          const baseRow = (
                            <tr key={`${row.generation.genId}-base`} className="border-b border-ink/10 align-top">
                              <td className="px-2 py-3">
                                {row.originalUrl ? (
                                  <img src={row.originalUrl} alt="Original frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No frame</div>
                                )}
                                <p className="mt-2 text-xs text-ink/70">{describeFrame(row.startFrame)}</p>
                                <p className="text-[11px] text-ink/50">{row.segment ? `${row.segment.segmentId} · ${describeSegment(row.segment)}` : row.generation.segmentId}</p>
                              </td>
                              <td className="px-2 py-3">
                                {hasMask ? (
                                  <img src={row.maskUrl as string} alt="Patch mask" className="mx-auto w-3/4 rounded border border-ink/10 bg-bg object-contain" />
                                ) : (
                                  <div className="mx-auto w-3/4 rounded border border-dashed border-ink/20 p-3 text-center text-xs text-ink/50">No mask used</div>
                                )}
                                <p className={`mt-2 text-sm font-medium ${hasMask ? "text-ink/90" : "text-ink"}`}>{promptText}</p>
                                <p className="mt-1 text-[11px] text-ink/60">
                                  {row.startVariant?.patchMeta ? `patch feather ${(row.startVariant.patchMeta.featherPx as number | undefined) ?? 0}px` : "No patch metadata"}
                                </p>
                              </td>
                              <td className="px-2 py-3">
                                {row.editedUrl ? (
                                  <img src={row.editedUrl} alt="Edited start frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No edited frame</div>
                                )}
                                <p className="mt-2 text-xs text-ink/70">{describeImageEditSettings(row.startVariant)}</p>
                                <p className="text-[11px] text-ink/50">{row.startVariant ? formatCompactTimestamp(row.startVariant.createdAt) : "n/a"}</p>
                              </td>
                              <td className="px-2 py-3">
                                {row.endFrameUrl ? (
                                  <img src={row.endFrameUrl} alt="End frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No end frame</div>
                                )}
                                <p className="mt-2 text-xs text-ink/70">{describeFrame(row.endFrame)}</p>
                                <p className="text-[11px] text-ink/50">{durationText}</p>
                              </td>
                              <td className="px-2 py-3">
                                {row.generatedVideoUrl ? (
                                  <div className="space-y-2">
                                    <VideoThumbnail
                                      videoUrl={row.generatedVideoUrl}
                                      cacheKey={row.generation.outputKey ?? row.generation.genId}
                                      label={`Generated video ${row.generation.genId}`}
                                      onClick={() =>
                                        setVideoPreviewModal({
                                          url: row.generatedVideoUrl as string,
                                          label: `Generated video ${row.generation.genId}`,
                                        })
                                      }
                                    />
                                    <p className="text-[11px] text-ink/50">Click thumbnail to preview video.</p>
                                  </div>
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No generated video</div>
                                )}
                                <p className="mt-2 text-xs text-ink/70">{describeVideoGenerationSettings(row.generation)}</p>
                                <p className="text-[11px] text-ink/50">{truncateIdentifier(row.generation.genId, 16)} · {formatCompactTimestamp(row.generation.createdAt)}</p>
                              </td>
                            </tr>
                          );

                          if (!row.generatedVideoUrl) {
                            return [baseRow];
                          }

                          const qcRow = (
                            <tr key={`${row.generation.genId}-qc`} className="border-b border-ink/10 bg-bg/40 align-top">
                              <td className="px-2 py-3">
                                {qcStatus === "complete" ? (
                                  <div className="space-y-1 rounded border border-ink/10 bg-white p-2 text-[11px] text-ink/70">
                                    <p className="font-semibold text-ink/90">Frame Analysis (Original vs Edited)</p>
                                    <p>Changed: {frameChangePct !== null ? `${frameChangePct.toFixed(2)}%` : "n/a"}</p>
                                    <p>Outside mask leak: {frameOutsidePct !== null ? `${frameOutsidePct.toFixed(2)}%` : "n/a"}</p>
                                    <p>Boundary spill: {frameBoundaryPct !== null ? `${frameBoundaryPct.toFixed(2)}%` : "n/a"}</p>
                                    <p className="pt-1 font-semibold text-ink/90">Video Analysis (Original vs Generated)</p>
                                    <p>Changed mean: {videoChangeMean !== null ? `${videoChangeMean.toFixed(2)}%` : "n/a"}</p>
                                    <p>Outside mean: {videoOutsideMean !== null ? `${videoOutsideMean.toFixed(2)}%` : "n/a"}</p>
                                    <p>SSIM: {ssimMean !== null ? ssimMean.toFixed(4) : "n/a"} · PSNR: {psnrMean !== null ? `${psnrMean.toFixed(2)} dB` : "n/a"}</p>
                                    <p>VMAF mean: {vmafMean !== null ? vmafMean.toFixed(2) : "n/a"}</p>
                                  </div>
                                ) : (
                                  <p className={`text-xs ${qcStatus === "failed" ? "text-red-600" : "text-ink/60"}`}>
                                    {qcStatus === "failed"
                                      ? `QC failed: ${row.generation.qc?.error ?? "unknown error"}`
                                      : qcStatus === "running"
                                        ? "QC analysis running..."
                                        : "QC analysis not run yet."}
                                  </p>
                                )}
                              </td>
                              <td className="px-2 py-3">
                                {heatmapUrl ? (
                                  <img
                                    src={heatmapUrl}
                                    alt="Frame diff heatmap"
                                    className="w-full rounded border border-ink/10 bg-bg object-contain"
                                  />
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No heatmap</div>
                                )}
                              </td>
                              <td className="px-2 py-3">
                                {boundaryOverlayUrl ? (
                                  <img
                                    src={boundaryOverlayUrl}
                                    alt="Mask boundary and binary change overlay"
                                    className="w-full rounded border border-ink/10 bg-bg object-contain"
                                  />
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No boundary overlay</div>
                                )}
                              </td>
                              <td className="px-2 py-3">
                                {timelineGraphUrl ? (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    onClick={() => setReportGraphModal({ url: timelineGraphUrl, label: `QC timeline: ${row.generation.genId}` })}
                                  >
                                    <img src={timelineGraphUrl} alt="QC timeline graph" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                                  </button>
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No timeline graph</div>
                                )}
                                {timelineCsvUrl ? (
                                  <a href={timelineCsvUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-ink/70 underline">
                                    Download timeline CSV
                                  </a>
                                ) : null}
                              </td>
                              <td className="px-2 py-3">
                                {diffVideoUrl ? (
                                  <div className="space-y-2">
                                    <VideoThumbnail
                                      videoUrl={diffVideoUrl}
                                      cacheKey={`${row.generation.genId}-diff-video`}
                                      label={`Diff video ${row.generation.genId}`}
                                      onClick={() =>
                                        setVideoPreviewModal({
                                          url: diffVideoUrl,
                                          label: `Diff video ${row.generation.genId}`,
                                        })
                                      }
                                    />
                                    <p className="text-[11px] text-ink/50">Click thumbnail to preview diff video.</p>
                                  </div>
                                ) : (
                                  <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No diff video map</div>
                                )}
                              </td>
                            </tr>
                          );

                          return [baseRow, qcRow];
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
        {reportGraphModal ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setReportGraphModal(null)}>
            <div className="relative w-[92vw] max-w-6xl rounded-lg border border-ink/20 bg-white p-3" onClick={(event) => event.stopPropagation()}>
              <button className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={() => setReportGraphModal(null)}>
                x
              </button>
              <img src={reportGraphModal.url} alt={reportGraphModal.label} className="w-full rounded object-contain" />
            </div>
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto grid max-w-[1500px] grid-cols-12 gap-4 p-4 md:p-6">
        <aside className="col-span-12 rounded-2xl border border-ink/10 bg-card p-4 md:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Tasks</h2>
            <button onClick={() => logout()} className="text-sm text-ink/60 underline">
              Sign out
            </button>
          </div>

          <button className="mb-4 w-full rounded-md bg-accent px-3 py-2 text-sm text-white" onClick={openNewTaskModal}>
            Add New Task
          </button>

          <div className="space-y-2">
            {(tasksQuery.data ?? []).map((taskItem) => (
              <div
                key={taskItem.taskId}
                className={`relative w-full rounded-lg border px-3 py-2 text-left ${
                  selectedTaskId === taskItem.taskId ? "border-accent bg-accent/10" : "border-ink/10 bg-white"
                }`}
              >
                <button
                  className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-ink/20 bg-white text-xs font-semibold text-ink/70"
                  title="Open task report"
                  aria-label={`Open report for ${taskItem.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openTaskReport(taskItem.taskId);
                  }}
                >
                  i
                </button>
                <button className="w-full pr-8 text-left" onClick={() => setSelectedTaskId(taskItem.taskId)}>
                  <p className="font-medium">{taskItem.name}</p>
                  <p
                    className={`text-xs uppercase tracking-wide ${
                      taskItem.status === "error"
                        ? "text-red-600"
                        : taskItem.status === "ingesting"
                          ? "text-amber-600"
                          : "text-ink/60"
                    }`}
                  >
                    {taskItem.status}
                  </p>
                </button>
                <button className="mt-1 text-xs text-red-600 underline" onClick={() => deleteTaskMutation.mutate(taskItem.taskId)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
          <button className="mt-4 text-sm text-accent underline" onClick={() => void handleTabChange("assets")}>
            Open Asset Library
          </button>
        </aside>

        <section className="col-span-12 space-y-4 md:col-span-9">
          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {tabs.map(({ id, label }, index) => (
                <div key={id} className="flex items-center gap-2">
                  <button
                    onClick={() => void handleTabChange(id)}
                    className={`rounded-md px-3 py-2 text-sm ${tab === id ? "bg-ink text-white" : "bg-ink/10"}`}
                  >
                    {label}
                  </button>
                  {index < tabs.length - 1 ? <span className="text-ink/50">→</span> : null}
                </div>
              ))}
            </div>

            {tab === "timeline" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Pick Frame & Segment Selection</h3>
                <div className="grid gap-3 lg:grid-cols-[1fr_180px]">
                  {timelinePlaybackUrl ? (
                    <div className="w-fit max-w-full">
                      <video
                        ref={timelineVideoRef}
                        className="max-h-[360px] max-w-full rounded-lg border border-ink/10"
                        src={timelinePlaybackUrl}
                        controls
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
                    </div>
                  ) : (
                    <p className="text-sm text-ink/70">Ingest must complete before timeline is available.</p>
                  )}
                  <div className="rounded-lg border border-ink/15 bg-bg p-3 text-xs text-ink/70 whitespace-pre-line">
                    {"To select the segment of video that you want AI to edit or add effects to:\n\nPlay and pause the video or use the slider to pick the start frame, then click the Select Start Frame button\n\nDo the same but for the End Frame\n\nMoving to the next step saves the segment."}
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
                    <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>
                      {timelineDelta.frames} frames
                    </p>
                    <p className="my-1 text-xl text-ink/70">→</p>
                    <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>
                      {timelineDelta.seconds.toFixed(2)}s
                    </p>
                    <p className="mt-1 text-[10px] text-ink/50">
                      {hasHardDurationLimit
                        ? `limit ${lumaHardLimitFrames}f / ${lumaHardLimitSeconds}s`
                        : "Runway input constrained by 64MB"}
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
                      Selected range: {selectedRange.startFrame} {"->"} {selectedRange.endFrameInclusive} (
                      {selectedRange.durationFrames} frames / {selectedRange.durationSec.toFixed(2)}s)
                    </p>
                    {selectedRange.overLimit ? (
                      <p className="text-xs text-red-600">
                        This exceeds the current model limit ({lumaHardLimitSeconds}s for {lumaModel}). You can still save the segment, but generation will be blocked until under the hard limit.
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
                      className={`rounded-lg border p-3 text-left ${
                        seg.segmentId === selectedSegmentId ? "border-accent bg-accent/10" : "border-ink/10"
                      }`}
                    >
                      <p className="font-medium">{seg.segmentId}</p>
                      <p className="text-sm text-ink/70">
                        {seg.startFrame} {"->"} {seg.endFrameExclusive} ({seg.durationSec}s)
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tab === "frames" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Edit Frame</h3>

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
                      Select frames in the Timeline tab first, then return here to edit.
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
                        onChange={(e) => setModel(e.target.value as "nano_banana" | "nano_banana_pro" | "chatgpt")}
                        className="rounded-md border border-ink/20 px-2 py-2"
                      >
                        <option value="nano_banana_pro">Nano Banana Pro</option>
                        <option value="nano_banana">Nano Banana Std</option>
                        <option value="chatgpt">ChatGPT-image</option>
                      </select>
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
                      Select a frame in the Timeline tab to start comparing edits.
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

                <details className="rounded-lg border border-ink/10 p-3">
                  <summary className="cursor-pointer text-sm font-medium">Advanced (Patch Tools)</summary>
                  <div className="mt-3 space-y-3">
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
                              onChange={(e) => setPatchEngine(e.target.value as PatchEngine)}
                              className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                            >
                              <option value="nano_banana_pro">Google Nano Banana Pro</option>
                              <option value="chatgpt">OpenAI ChatGPT (gpt-image-1)</option>
                              <option value="runware_flux_fill">Runware FLUX Fill</option>
                              <option value="runware_ace_pp">Runware ACE++ + FLUX Fill</option>
                            </select>
                          </label>
                          <label className="text-xs text-ink/70">
                            Tool
                            <select
                              value={patchToolMode}
                              onChange={(e) => setPatchToolMode(e.target.value as PatchToolMode)}
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
                    <button
                      className="rounded-md bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        !activeEditFrame ||
                        patchEditMutation.isPending ||
                        !patchPrompt.trim() ||
                        !maskHasPaint ||
                        (patchEngine === "runware_ace_pp" && !activePatchReference?.file)
                      }
                      onClick={() => activeEditFrame && patchEditMutation.mutate(activeEditFrame.frameId)}
                    >
                      Generate Patch Variant
                    </button>
                    {!maskHasPaint ? <p className="text-xs text-ink/60">Draw a mask before generating a patch variant.</p> : null}
                    {patchEngine === "runware_ace_pp" && !activePatchReference?.file ? (
                      <p className="text-xs text-ink/60">Select one reference image to use ACE++ local editing.</p>
                    ) : null}
                    {patchEditMutation.error ? <p className="text-xs text-red-600">{patchEditMutation.error.message}</p> : null}
                  </div>
                </details>
              </div>
            )}

            {tab === "generate" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Generate Video</h3>
                <div className="rounded-xl border border-ink/15 bg-white">
                  <div className="flex items-end gap-1 border-b border-ink/15 px-2 pt-2">
                    {[
                      { id: "start_video" as const, label: "start frame + video" },
                      { id: "start_end" as const, label: "start frame + end frame" },
                      { id: "start_only" as const, label: "start frame only" },
                    ].map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => {
                          setGenerationInputMode(entry.id);
                          setLumaModel(generationModelByInput[entry.id]);
                        }}
                        className={`rounded-t-md border px-3 py-2 text-xs ${
                          generationInputMode === entry.id
                            ? "-mb-px border-ink/25 border-b-white bg-white font-semibold text-ink"
                            : "border-ink/10 bg-bg text-ink/65"
                        }`}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-3 p-3 lg:grid-cols-[1.65fr_1fr]">
                    <div className="space-y-3">
                      <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/70">
                        Segment in use: {selectedSegment ? describeSegment(selectedSegment) : "No segment selected. Go to Pick Frame first."}
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <select
                          value={lumaModel}
                          onChange={(e) => {
                            const nextModel = e.target.value as VideoModel;
                            setGenerationModelByInput((previous) => ({ ...previous, [generationInputMode]: nextModel }));
                            setLumaModel(nextModel);
                          }}
                          className="rounded-md border border-ink/20 px-3 py-2"
                        >
                          {generationModelOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        {lumaModel === "ray-2" || lumaModel === "ray-flash-2" ? (
                          <select value={advancedMode} onChange={(e) => setAdvancedMode(e.target.value)} className="rounded-md border border-ink/20 px-3 py-2">
                            {[
                              "adhere_1",
                              "adhere_2",
                              "adhere_3",
                              "flex_1",
                              "flex_2",
                              "flex_3",
                              "reimagine_1",
                              "reimagine_2",
                              "reimagine_3",
                            ].map((mode) => (
                              <option key={mode} value={mode}>
                                mode: {mode}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                            Mode dropdown is only used by Luma models.
                          </div>
                        )}
                      </div>
                      {lumaModel === "wan2.2-animate" ? (
                        <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                          Text prompt is unavailable for Wan2.2 Animate in this flow. Generation uses the selected start frame plus source segment motion.
                        </div>
                      ) : (
                        <textarea
                          value={lumaPrompt}
                          onChange={(e) => setLumaPrompt(e.target.value)}
                          placeholder="Optional generation prompt"
                          className="h-20 w-full rounded-md border border-ink/20 p-2"
                        />
                      )}
                      <p className="text-xs text-ink/60">{generationInputNote}</p>
                    </div>
                    <div className="rounded-lg border border-ink/15 bg-bg p-3">
                      <p className="text-sm font-semibold">{generationHelp.title}</p>
                      <div className="mt-2 space-y-2 text-xs text-ink/70">
                        {generationHelp.lines.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {selectedSegmentOverLimit ? (
                  <p className="text-xs text-red-600">
                    Selected segment is {selectedSegment?.durationSec.toFixed(2)}s, exceeding the {lumaModel} limit of {lumaHardLimitSeconds}s.
                  </p>
                ) : null}

                <button
                  className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!selectedSegmentId || selectedSegmentOverLimit}
                  onClick={() => generateSegmentMutation.mutate()}
                >
                  Generate Segment Variant
                </button>

                <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Video Comparison</p>
                  {segmentWindow ? (
                    <p className="text-xs text-ink/70">
                      Showing selected segment only: {segmentWindow.startLabel}s to {segmentWindow.endLabel}s.
                    </p>
                  ) : null}
                  {originalSegmentPreviewUrl && selectedPreviewGeneration?.downloadUrl ? (
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
                          <video
                            ref={compareOriginalRef}
                            src={originalSegmentPreviewUrl}
                            muted
                            playsInline
                            className="h-full w-full object-contain"
                            onLoadedMetadata={(e) => {
                              if (segmentWindow) {
                                e.currentTarget.currentTime = segmentWindow.startSec;
                              }
                            }}
                            onTimeUpdate={(e) => keepOriginalWithinSegment(e.currentTarget)}
                          />
                        }
                        itemTwo={
                          <video
                            ref={compareVariantRef}
                            src={selectedPreviewGeneration.downloadUrl}
                            controls
                            playsInline
                            className="h-full w-full object-contain"
                            onLoadedMetadata={(e) => {
                              e.currentTarget.currentTime = 0;
                              syncOriginalToGenerated(e.currentTarget);
                            }}
                            onTimeUpdate={(e) => syncOriginalToGenerated(e.currentTarget)}
                            onSeeking={(e) => syncOriginalToGenerated(e.currentTarget)}
                            onPlay={(e) => {
                              syncOriginalToGenerated(e.currentTarget);
                              compareOriginalRef.current?.play().catch(() => undefined);
                            }}
                            onPause={() => {
                              compareOriginalRef.current?.pause();
                            }}
                          />
                        }
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-ink/60">Select a segment and generated variant to compare.</p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {selectedSegmentGenerations.map((gen, index) => (
                      <div
                        key={gen.genId}
                        className={`rounded border p-2 ${
                          gen.status === "failed"
                            ? "border-orange-400 bg-orange-50"
                            : selectedPreviewGeneration?.genId === gen.genId
                              ? "border-teal-500 bg-teal-50"
                              : "border-ink/10"
                        }`}
                      >
                        <div className="mb-2 flex items-center justify-between text-xs">
                          <span className={`uppercase text-ink/60 ${index === 0 ? "font-semibold" : ""}`}>{gen.status}</span>
                          <span className="text-[11px] text-ink/50">{truncateIdentifier(gen.genId, 14)}</span>
                        </div>
                        <VideoThumbnail
                          videoUrl={gen.downloadUrl ?? undefined}
                          cacheKey={gen.outputKey ?? gen.genId}
                          label={describeGeneration(gen)}
                          disabled={!gen.downloadUrl}
                          onClick={() => selectSegmentGeneration(gen.genId)}
                        />
                        <p className="mt-2 text-xs font-medium text-ink/80">
                          {gen.luma.model} / {gen.luma.mode}
                        </p>
                        <p className="text-[11px] text-ink/60">{formatCompactTimestamp(gen.createdAt)}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded border border-ink/20 bg-white p-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={!gen.downloadUrl}
                            title="Preview"
                            onClick={() => {
                              if (!gen.downloadUrl) return;
                              setVideoPreviewModal({ url: gen.downloadUrl, label: describeGeneration(gen) });
                            }}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                          {gen.downloadUrl ? (
                            <a
                              href={gen.downloadUrl}
                              target="_blank"
                              rel="noreferrer"
                              download
                              className="rounded border border-ink/20 bg-white p-2 text-xs"
                              title="Download full quality video"
                            >
                              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 3v12" />
                                <path d="m7 10 5 5 5-5" />
                                <path d="M4 21h16" />
                              </svg>
                            </a>
                          ) : null}
                          <button
                            type="button"
                            className="rounded border border-red-200 bg-white p-2 text-xs text-red-700"
                            title="Delete generated video"
                            disabled={!task?.taskId}
                            onClick={() =>
                              handleDeleteAsset({
                                id: `generation:${task?.taskId ?? ""}:${gen.genId}`,
                                taskId: task?.taskId ?? "",
                                title: describeGeneration(gen),
                                subtitle: `${gen.luma.model}/${gen.luma.mode}`,
                                createdAt: gen.createdAt,
                                previewUrl: gen.downloadUrl ?? "",
                                downloadUrl: gen.downloadUrl ?? "",
                                mediaType: "video",
                                deletePayload: { assetType: "segment_generation", genId: gen.genId },
                              })
                            }
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
                  {selectedSegmentGenerations.length === 0 ? (
                    <p className="text-sm text-ink/60">No generated variants for this segment yet.</p>
                  ) : null}
                </div>
              </div>
            )}

            {tab === "merge" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Merge Video</h3>
                <div className="rounded-lg border border-ink/15 bg-bg p-3">
                  <p className="text-sm font-semibold">Merge step guide</p>
                  <div className="mt-2 space-y-2 text-xs text-ink/70">
                    <p>
                      The step takes the generated video (segment) selected in Generate Video, and re-inserts it into the original timeline.
                    </p>
                    <p>
                      By default the generated clip starts at the original cut start. If it is longer, the end lands later in the timeline.
                    </p>
                    <p>
                      Use trim start/end and insert start controls, then review the stacked track previews before merging.
                    </p>
                    <p>
                      Solid teal lines show the cut points. Dashed amber lines show blend boundaries from temporal feathering.
                    </p>
                    <p className="font-semibold uppercase tracking-wide text-orange-700">
                      This is an experiment to highlight the challenges merging AI and real content!
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                    <p className="text-sm font-medium">Generation in use</p>
                    {!mergeTargetGeneration ? (
                      <p className="text-sm text-ink/60">No generation selected in Generate Video yet.</p>
                    ) : (
                      <div className="rounded border border-teal-500 bg-teal-50 p-2">
                        <p className="text-sm font-semibold">{describeGeneration(mergeTargetGeneration)}</p>
                        <p className="text-xs text-ink/50">{mergeTargetGeneration.genId}</p>
                      </div>
                    )}
                    {mergeTargetSegment ? (
                      <p className="text-xs text-ink/60">Current segment reference: {describeSegment(mergeTargetSegment)}</p>
                    ) : null}
                  </div>

                  {mergeTargetGeneration && mergeTargetSegment ? (
                    <>
                      <div className="space-y-3 rounded-lg border border-ink/10 p-3">
                        <p className="text-sm font-medium">Advanced merge alignment</p>
                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                          <label className="space-y-1 text-xs text-ink/70">
                            <span className="block font-medium text-ink/80">Insert start frame</span>
                            <input
                              type="number"
                              min={0}
                              max={mergeMaxFrameIndex}
                              value={mergeInsertStartFrame}
                              onChange={(e) => setMergeInsertStartFrame(Number(e.target.value))}
                              className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                            />
                          </label>
                          <label className="space-y-1 text-xs text-ink/70">
                            <span className="block font-medium text-ink/80">Trim generated start (frames)</span>
                            <input
                              type="number"
                              min={0}
                              max={Math.max(0, mergeGeneratedDurationFrames - 1)}
                              value={mergeTrimStartFrames}
                              onChange={(e) => setMergeTrimStartFrames(Number(e.target.value))}
                              className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                            />
                          </label>
                          <label className="space-y-1 text-xs text-ink/70">
                            <span className="block font-medium text-ink/80">Trim generated end (frames)</span>
                            <input
                              type="number"
                              min={0}
                              max={Math.max(0, mergeGeneratedDurationFrames - 1)}
                              value={mergeTrimEndFrames}
                              onChange={(e) => setMergeTrimEndFrames(Number(e.target.value))}
                              className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                            />
                          </label>
                          <label className="space-y-1 text-xs text-ink/70">
                            <span className="block font-medium text-ink/80">Temporal feather (frames)</span>
                            <input
                              type="number"
                              min={0}
                              max={30}
                              value={temporalFeatherFrames}
                              onChange={(e) => setTemporalFeatherFrames(Number(e.target.value))}
                              className="w-full rounded-md border border-ink/20 px-2 py-2 text-sm"
                            />
                          </label>
                        </div>
                        <div className="grid gap-2 rounded-md bg-bg p-2 text-xs text-ink/70 md:grid-cols-2">
                          <p>
                            Original cut: <span className="font-medium text-ink">f{mergeOriginalStartFrame}</span> to{" "}
                            <span className="font-medium text-ink">f{Math.max(mergeOriginalStartFrame, mergeOriginalEndFrameExclusive - 1)}</span> (
                            {formatFramesAndSeconds(mergeOriginalDurationFrames, mergeFps)})
                          </p>
                          <p>
                            Generated in merge: <span className="font-medium text-ink">{formatFramesAndSeconds(mergeEffectiveDurationFrames, mergeFps)}</span>{" "}
                            (from source {formatFramesAndSeconds(mergeGeneratedDurationFrames, mergeFps)})
                          </p>
                          <p>
                            Insert window now: <span className="font-medium text-ink">f{mergeInsertStartFrameClamped}</span> to{" "}
                            <span className="font-medium text-ink">f{Math.max(mergeInsertStartFrameClamped, mergeEffectiveEndFrameExclusive - 1)}</span>
                          </p>
                          <p className={mergeEndOffsetFrames !== 0 ? "font-semibold text-orange-700" : ""}>
                            End shift from original cut: {mergeEndOffsetFrames >= 0 ? "+" : ""}
                            {mergeEndOffsetFrames} frames ({(mergeEndOffsetFrames / Math.max(1, mergeFps)).toFixed(2)}s)
                          </p>
                        </div>
                      </div>

                      <MergeBoundaryPreview
                        title="Start merge point preview"
                        subtitle={`original f${mergeInsertStartFrameClamped} -> generated g${mergeGeneratedStartAnchor}`}
                        firstTrack={{
                          title: "Original track around start cut",
                          items: startBoundaryOriginalThumbs,
                          anchorFrame: mergeInsertStartFrameClamped,
                          overlapStart: mergeFeatherClamped > 0 ? mergeInsertStartFrameClamped : undefined,
                          overlapEnd: mergeFeatherClamped > 0 ? mergeInsertStartFrameClamped + mergeFeatherClamped - 1 : undefined,
                          prefix: "f",
                        }}
                        secondTrack={{
                          title: "Generated track around start cut",
                          items: startBoundaryGeneratedThumbs,
                          anchorFrame: mergeGeneratedStartAnchor,
                          overlapStart: mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor : undefined,
                          overlapEnd: mergeFeatherClamped > 0 ? mergeGeneratedStartAnchor + mergeFeatherClamped - 1 : undefined,
                          prefix: "g",
                        }}
                      />

                      <MergeBoundaryPreview
                        title="End merge point preview"
                        subtitle={`generated g${mergeGeneratedEndAnchor} -> original f${mergeEffectiveEndFrameExclusive}`}
                        firstTrack={{
                          title: "Generated track around end cut",
                          items: endBoundaryGeneratedThumbs,
                          anchorFrame: mergeGeneratedEndAnchor,
                          overlapStart: mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor - mergeFeatherClamped + 1 : undefined,
                          overlapEnd: mergeFeatherClamped > 0 ? mergeGeneratedEndAnchor : undefined,
                          prefix: "g",
                        }}
                        secondTrack={{
                          title: "Original track after generated segment",
                          items: endBoundaryOriginalThumbs,
                          anchorFrame: mergeEffectiveEndFrameExclusive,
                          overlapStart: mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive : undefined,
                          overlapEnd: mergeFeatherClamped > 0 ? mergeEffectiveEndFrameExclusive + mergeFeatherClamped - 1 : undefined,
                          prefix: "f",
                        }}
                      />
                    </>
                  ) : null}

                  <button
                    className="rounded-md bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!mergeTargetGeneration || mergeMutation.isPending}
                    onClick={() => mergeMutation.mutate()}
                  >
                    {mergeMutation.isPending ? "Merging..." : "Merge generation"}
                  </button>
                </div>
                <div className="space-y-2">
                  {sortedExports.map((exp) => (
                    <div key={exp.exportId} className="rounded border border-ink/10 p-3">
                      <p className="font-medium">{humanizeFilename(keyBasenameFromS3Key(exp.outputKey || `${exp.exportId}.mp4`))}</p>
                      <p className="text-xs text-ink/60">
                        {exp.exportId} · {formatCompactTimestamp(exp.createdAt)}
                      </p>
                      {exp.downloadUrl ? (
                        <a className="text-sm text-accent underline" href={exp.downloadUrl}>
                          Download merged video
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === "assets" && (
              <div className="space-y-6">
                <h3 className="text-lg font-semibold">Download Assets</h3>
                {assetsLoading ? <p className="text-sm text-ink/60">Loading assets...</p> : null}
                <div className="space-y-3 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Uploads</p>
                  {uploadAssets.length === 0 ? (
                    <p className="text-sm text-ink/60">No uploads found.</p>
                  ) : (
                    <div className="space-y-2">
                      {uploadAssets.slice(0, uploadAssetsVisible).map((item, index) => (
                        <div
                          key={item.id}
                          className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                            index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                          }`}
                        >
                          <VideoThumbnail
                            videoUrl={item.previewUrl}
                            cacheKey={item.id}
                            label={item.title}
                            onClick={() => undefined}
                            interactive={false}
                            thumbClassName="max-h-20"
                          />
                          <div>
                            <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                            <p className="text-xs text-ink/60">{item.subtitle}</p>
                            <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                              👁
                            </a>
                            <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                              ⬇
                            </a>
                            <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                              🗑
                            </button>
                          </div>
                        </div>
                      ))}
                      {uploadAssetsVisible < uploadAssets.length ? (
                        <button className="text-sm text-accent underline" onClick={() => setUploadAssetsVisible((count) => count + 6)}>
                          More...
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Output Frames & Edits</p>
                  {frameAssets.length === 0 ? (
                    <p className="text-sm text-ink/60">No frame assets found.</p>
                  ) : (
                    <div className="space-y-2">
                      {frameAssets.slice(0, frameAssetsVisible).map((item, index) => (
                        <div
                          key={item.id}
                          className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                            index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                          }`}
                        >
                          <img src={item.previewUrl} className="max-h-20 w-full rounded bg-bg object-contain" />
                          <div>
                            <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                            <p className="text-xs text-ink/60">{item.subtitle}</p>
                            <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                              👁
                            </a>
                            <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                              ⬇
                            </a>
                            <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                              🗑
                            </button>
                          </div>
                        </div>
                      ))}
                      {frameAssetsVisible < frameAssets.length ? (
                        <button className="text-sm text-accent underline" onClick={() => setFrameAssetsVisible((count) => count + 6)}>
                          More...
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Output Videos</p>
                  {outputVideoAssets.length === 0 ? (
                    <p className="text-sm text-ink/60">No output videos found.</p>
                  ) : (
                    <div className="space-y-2">
                      {outputVideoAssets.slice(0, videoAssetsVisible).map((item, index) => (
                        <div
                          key={item.id}
                          className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                            index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                          }`}
                        >
                          <VideoThumbnail
                            videoUrl={item.previewUrl}
                            cacheKey={item.id}
                            label={item.title}
                            onClick={() => undefined}
                            interactive={false}
                            thumbClassName="max-h-20"
                          />
                          <div>
                            <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                            <p className="text-xs text-ink/60">{item.subtitle}</p>
                            <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                              👁
                            </a>
                            <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                              ⬇
                            </a>
                            <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                              🗑
                            </button>
                          </div>
                        </div>
                      ))}
                      {videoAssetsVisible < outputVideoAssets.length ? (
                        <button className="text-sm text-accent underline" onClick={() => setVideoAssetsVisible((count) => count + 6)}>
                          More...
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Jobs</h3>
            <div className="space-y-2 text-sm">
              {sortedJobs.length === 0 && <p className="text-ink/60">No jobs yet.</p>}
              {sortedJobs.slice(0, jobsVisible).map((job) => {
                return (
                  <div
                    key={job.jobId}
                    className={`rounded border p-2 ${job.status === "failed" ? "border-orange-400 bg-orange-50" : "border-ink/10"}`}
                  >
                    <p className="font-medium">
                      {job.jobId} <span className="text-ink/60">({job.type})</span>
                    </p>
                    <p className="text-xs uppercase">{job.status} - {job.progress}%</p>
                    {job.error ? <p className="text-xs text-red-600">{job.error}</p> : null}
                  </div>
                );
              })}
              {jobsVisible < sortedJobs.length ? (
                <button className="text-sm text-accent underline" onClick={() => setJobsVisible((count) => count + 6)}>
                  More...
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
      {imagePreviewModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setImagePreviewModal(null)}
        >
          <div className="relative flex h-[90vh] w-[90vw] items-center justify-center">
            <button
              className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white"
              onClick={() => setImagePreviewModal(null)}
            >
              x
            </button>
            <img
              src={imagePreviewModal.url}
              alt={imagePreviewModal.label}
              className="h-full w-full object-contain"
              onClick={() => setImagePreviewModal(null)}
            />
          </div>
        </div>
      ) : null}
      {videoPreviewModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setVideoPreviewModal(null)}
        >
          <div
            className="relative w-[90vw] max-w-6xl rounded-lg border border-ink/20 bg-black p-3"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white"
              onClick={() => setVideoPreviewModal(null)}
            >
              x
            </button>
            <video
              src={videoPreviewModal.url}
              controls
              autoPlay
              className="h-[80vh] w-full rounded object-contain"
            />
          </div>
        </div>
      ) : null}
      {isNewTaskModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-ink/10 bg-card p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Create Task & Upload Video</h3>
              <button
                className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => setIsNewTaskModalOpen(false)}
                disabled={newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
              >
                Close
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Task name</label>
                <input
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  maxLength={15}
                  className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
                  disabled={newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
                />
                <p className="mt-1 text-xs text-ink/60">
                  Final name: <span className="font-medium">{normalizedNewTaskName || "(invalid)"}</span> (max 15 chars)
                </p>
                {showTaskNameExistsWarning ? <p className="text-xs text-red-600">Name already used by another task.</p> : null}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Video file</label>
                <input
                  type="file"
                  accept="video/*"
                  onChange={(e) => setNewTaskFile(e.target.files?.[0] ?? null)}
                  disabled={newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
                />
              </div>
              {newTaskStage === "uploading" ? (
                <div>
                  <p className="mb-1 text-sm text-ink/70">Uploading: {newTaskUploadPercent}%</p>
                  <div className="h-2 w-full overflow-hidden rounded bg-ink/10">
                    <div className="h-full bg-accent" style={{ width: `${newTaskUploadPercent}%` }} />
                  </div>
                </div>
              ) : null}
              {newTaskStage === "ingesting" ? (
                <div>
                  <p className="mb-1 text-sm text-ink/70">
                    Ingesting: {pendingCreateJobQuery.data?.progress ?? 0}% ({pendingCreateJobQuery.data?.status ?? "queued"})
                  </p>
                  <div className="h-2 w-full overflow-hidden rounded bg-ink/10">
                    <div className="h-full bg-accent2" style={{ width: `${pendingCreateJobQuery.data?.progress ?? 0}%` }} />
                  </div>
                </div>
              ) : null}
              {newTaskError ? <p className="text-sm text-red-600">{newTaskError}</p> : null}
              <button
                className="w-full rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !newTaskName.trim() ||
                  !normalizedNewTaskName ||
                  taskNameAlreadyExists ||
                  !newTaskFile ||
                  newTaskStage === "creating" ||
                  newTaskStage === "uploading" ||
                  newTaskStage === "ingesting"
                }
                onClick={handleCreateTaskWithUpload}
              >
                {newTaskStage === "creating"
                  ? "Creating task..."
                  : newTaskStage === "uploading"
                    ? "Uploading..."
                    : newTaskStage === "ingesting"
                      ? "Ingesting..."
                      : "Create Task and Ingest"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

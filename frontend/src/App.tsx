import { Suspense, lazy, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import { apiClient } from "./api/client";
import PreviewModals from "./components/layout/PreviewModals";
import TaskSidebar from "./components/layout/TaskSidebar";
import WorkflowTabs from "./components/layout/WorkflowTabs";
import QualityMatchModal from "./components/quality/QualityMatchModal";
import NewTaskModal from "./components/tasks/NewTaskModal";
import {
  taskRoute,
  type ReportView,
  type TabId,
  useCanonicalTaskRoute,
  useReportRouteState,
  useWorkflowRouteState,
} from "./hooks/useWorkflowRouting";
import { useTaskLifecycle } from "./hooks/useTaskLifecycle";
import { useGenerationMergeState } from "./hooks/useGenerationMergeState";
import { currentUser, login, logout } from "./lib/auth";
import type { AssetsTabCtx } from "./pages/workflow/AssetsTab";
import type { EditFrameTabCtx } from "./pages/workflow/EditFrameTab";
import type { GenerateTabCtx } from "./pages/workflow/GenerateTab";
import type { JobsPanelCtx } from "./pages/workflow/JobsPanel";
import type { MergeTabCtx } from "./pages/workflow/MergeTab";
import type { PickFrameTabCtx } from "./pages/workflow/PickFrameTab";
import { useUiStore } from "./store/uiStore";
import type {
  CustomReportOutputRef,
  CustomReportRecord,
  FrameVariant,
  SegmentGeneration,
  SegmentRecord,
  TaskDetail,
} from "./types/api";

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

type AutomationVideoOption = {
  id: string;
  label: string;
  inputMode: GenerateInputMode;
  lumaModel: VideoModel;
  mode: string;
};

type AutomationVariantChoice = {
  frameId: string;
  variantId: string;
  imageUrl: string;
  model: string;
  createdAt: string;
};

type AutomationSelectionState = {
  taskId: string;
  segmentId: string;
  startFrameId: string;
  endFrameId: string;
  startChoices: AutomationVariantChoice[];
  endChoices: AutomationVariantChoice[];
  startSelectedVariantId: string | null;
  endSelectedVariantId: string | null;
};

type AutomationVideoRunOption = AutomationVideoOption & { enabled: boolean };

type AutomationRunState = {
  isOpen: boolean;
  taskId: string | null;
  phase: string;
  detail: string;
  cancelRequested: boolean;
  terminal: boolean;
};

type LibraryAsset = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
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

type QualityMatchModalState = {
  isOpen: boolean;
  frameId: string | null;
  variantId: string | null;
  variantLabel: string;
  originalFrameUrl: string | null;
  generatedFrameUrl: string | null;
  alreadyReviewed: boolean;
};

const ReportsPage = lazy(() => import("./pages/ReportsPage"));
const PickFrameTab = lazy(() => import("./pages/workflow/PickFrameTab"));
const EditFrameTab = lazy(() => import("./pages/workflow/EditFrameTab"));
const GenerateTab = lazy(() => import("./pages/workflow/GenerateTab"));
const MergeTab = lazy(() => import("./pages/workflow/MergeTab"));
const AssetsTab = lazy(() => import("./pages/workflow/AssetsTab"));
const JobsPanel = lazy(() => import("./pages/workflow/JobsPanel"));

const VIDEO_FRAME_THUMBNAIL_CACHE = new Map<string, string | null>();
const MAX_TRACKED_JOB_IDS = 40;
const TASK_URL_REFRESH_MS = 15 * 60 * 1000;
const AUTOMATION_CANCELLED = "__automation_cancelled__";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatFramesAndSeconds(frames: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  return `${frames}f / ${(frames / safeFps).toFixed(2)}s`;
}

function isValidHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function generationThumbnailUrl(generation: SegmentGeneration): string | null {
  return (
    generation.inputFirstFrameUrl ??
    generation.sourceFirstFrameCaptureUrl ??
    generation.inputLastFrameUrl ??
    generation.sourceLastFrameCaptureUrl ??
    null
  );
}

function appendTrackedJobId(previous: string[], jobId: string): string[] {
  if (!jobId) return previous;
  const deduped = [...previous.filter((item) => item !== jobId), jobId];
  return deduped.slice(-MAX_TRACKED_JOB_IDS);
}

function humanizeFilename(value: string): string {
  const withoutExt = value.replace(/\.[^/.]+$/, "");
  return withoutExt.replace(/[_-]+/g, " ").trim();
}

function keyBasenameFromS3Key(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function reportOutputRefKey(ref: CustomReportOutputRef): string {
  if (ref.assetType === "segment_generation") {
    return `segment_generation:${ref.genId}`;
  }
  return `frame_variant:${ref.frameId}:${ref.variantId}`;
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
    { value: "ray-flash-2", label: "Luma Ray Flash 2" },
    { value: "ray-2", label: "Luma Ray 2" },
  ],
  start_end: [
    { value: "kling-2.6", label: "Kling 2.6" },
    { value: "veo-3.1", label: "Veo 3.1" },
    { value: "veo-3.1-fast", label: "Veo 3.1 Fast" },
  ],
  start_only: [
    { value: "wan2.2-a14b", label: "Wan 2.2 A14B" },
    { value: "runway-gen4.5", label: "Runway Gen-4.5" },
    { value: "veo-3.1", label: "Veo 3.1" },
    { value: "veo-3.1-fast", label: "Veo 3.1 Fast" },
    { value: "kling-2.6", label: "Kling 2.6" },
  ],
};

const AUTOMATION_VIDEO_OPTIONS: AutomationVideoOption[] = [
  { id: "ray-flash-2:start_video:flex_1", label: "Luma Ray Flash 2 (Start frame + video)", inputMode: "start_video", lumaModel: "ray-flash-2", mode: "flex_1" },
  { id: "ray-2:start_video:flex_1", label: "Luma Ray 2 (Start frame + video)", inputMode: "start_video", lumaModel: "ray-2", mode: "flex_1" },
  { id: "wan2.2-animate:start_video:wan_animate_replace", label: "Wan 2.2 Animate (Start frame + video)", inputMode: "start_video", lumaModel: "wan2.2-animate", mode: "wan_animate_replace" },
  { id: "kling-2.6:start_end:kling_start_end", label: "Kling 2.6 (Start/End frame)", inputMode: "start_end", lumaModel: "kling-2.6", mode: "kling_start_end" },
  { id: "kling-2.6:start_only:kling_start_only", label: "Kling 2.6 (Start frame only)", inputMode: "start_only", lumaModel: "kling-2.6", mode: "kling_start_only" },
  { id: "veo-3.1:start_end:veo_start_end", label: "Veo 3.1 (Start/End frame)", inputMode: "start_end", lumaModel: "veo-3.1", mode: "veo_start_end" },
  { id: "veo-3.1:start_only:veo_start_only", label: "Veo 3.1 (Start frame only)", inputMode: "start_only", lumaModel: "veo-3.1", mode: "veo_start_only" },
  { id: "veo-3.1-fast:start_end:veo_start_end", label: "Veo 3.1 Fast (Start/End frame)", inputMode: "start_end", lumaModel: "veo-3.1-fast", mode: "veo_start_end" },
  { id: "veo-3.1-fast:start_only:veo_start_only", label: "Veo 3.1 Fast (Start frame only)", inputMode: "start_only", lumaModel: "veo-3.1-fast", mode: "veo_start_only" },
  { id: "runway-gen4.5:start_only:runway_i2v", label: "Runway Gen-4.5 (Start frame only)", inputMode: "start_only", lumaModel: "runway-gen4.5", mode: "runway_i2v" },
  { id: "wan2.2-a14b:start_only:wan_a14b_i2v", label: "Wan 2.2 A14B (Start frame only)", inputMode: "start_only", lumaModel: "wan2.2-a14b", mode: "wan_a14b_i2v" },
];

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

function useVideoFrameStrip({
  videoUrl,
  fps,
  frameIndices,
  cachePrefix,
  sourceCacheKey,
}: {
  videoUrl?: string | null;
  fps: number;
  frameIndices: number[];
  cachePrefix: string;
  sourceCacheKey?: string | null;
}): VideoFrameStripItem[] {
  const [items, setItems] = useState<VideoFrameStripItem[]>([]);
  const signature = useMemo(() => frameIndices.join(","), [frameIndices]);

  useEffect(() => {
    let cancelled = false;
    if (!isValidHttpUrl(videoUrl) || !Number.isFinite(fps) || fps <= 0 || frameIndices.length === 0) {
      setItems([]);
      return;
    }

    const safeFps = fps;
    const uniqueFrames = Array.from(new Set(frameIndices)).sort((a, b) => a - b);
    const sourceKey = sourceCacheKey || videoUrl;
    const frameCacheKey = (frameIndex: number) => `${cachePrefix}:${sourceKey}:${frameIndex}`;
    const initial = uniqueFrames.map((frameIndex) => {
      const key = frameCacheKey(frameIndex);
      return { frameIndex, imageUrl: VIDEO_FRAME_THUMBNAIL_CACHE.get(key) ?? null };
    });
    setItems(initial);
    const allCached = uniqueFrames.every((frameIndex) => VIDEO_FRAME_THUMBNAIL_CACHE.has(frameCacheKey(frameIndex)));
    if (allCached) {
      return;
    }

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
        const cacheKey = frameCacheKey(frameIndex);
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
  }, [cachePrefix, fps, frameIndices, signature, sourceCacheKey, videoUrl]);

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

export default function App() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    selectedTaskId: storeSelectedTaskId,
    currentFrameIndex,
    selectedFrameId,
    selectedSegmentId,
    setSelectedTaskId,
    setCurrentFrameIndex,
    setSelectedFrameId,
    setSelectedSegmentId,
  } = useUiStore();

  const [isAuthed, setIsAuthed] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );
  const routeState = useWorkflowRouteState(location.pathname);
  const { reportView, activeCustomReportId } = useReportRouteState(location.search);
  const [selectedReportOutputs, setSelectedReportOutputs] = useState<Record<string, { taskId: string; ref: CustomReportOutputRef }>>({});
  const [customReportNotice, setCustomReportNotice] = useState<string | null>(null);
  const [uploadAssetsVisible, setUploadAssetsVisible] = useState(6);
  const [frameAssetsVisible, setFrameAssetsVisible] = useState(6);
  const [videoAssetsVisible, setVideoAssetsVisible] = useState(6);
  const [generationCardsVisible, setGenerationCardsVisible] = useState(6);
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
  const [imagePreviewModal, setImagePreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [videoPreviewModal, setVideoPreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [reportGraphModal, setReportGraphModal] = useState<{ url: string; label: string } | null>(null);
  const [qualityMatchModal, setQualityMatchModal] = useState<QualityMatchModalState>({
    isOpen: false,
    frameId: null,
    variantId: null,
    variantLabel: "",
    originalFrameUrl: null,
    generatedFrameUrl: null,
    alreadyReviewed: false,
  });
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [automationStartPrompt, setAutomationStartPrompt] = useState("");
  const [automationEndPrompt, setAutomationEndPrompt] = useState("");
  const [automationSelectedVideoOptionIds, setAutomationSelectedVideoOptionIds] = useState<string[]>(
    AUTOMATION_VIDEO_OPTIONS.map((option) => option.id),
  );
  const [automationUiError, setAutomationUiError] = useState<string | null>(null);
  const [automationRunState, setAutomationRunState] = useState<AutomationRunState>({
    isOpen: false,
    taskId: null,
    phase: "",
    detail: "",
    cancelRequested: false,
    terminal: false,
  });
  const [automationSelectionState, setAutomationSelectionState] = useState<AutomationSelectionState | null>(null);
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
  const signedUrlRefreshRef = useRef<Map<string, number>>(new Map());
  const automationCancelRef = useRef(false);
  const automationSelectionResolverRef = useRef<
    ((choice: { startVariantId: string; endVariantId: string | null; cancelled: boolean }) => void) | null
  >(null);

  useEffect(() => {
    currentUser().then((user) => setIsAuthed(!!user));
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibilityChange = () => {
      setIsPageVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: async () => (await apiClient.listTasks()).tasks,
    enabled: isAuthed,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    const modelForInput = generationModelByInput[generationInputMode];
    if (modelForInput !== lumaModel) {
      setLumaModel(modelForInput);
    }
  }, [generationInputMode, generationModelByInput, lumaModel]);

  const tab: TabId = routeState.tab ?? "timeline";
  const isReportTab = tab === "report";
  const selectedTaskId = routeState.taskId ?? storeSelectedTaskId;
  const reportTaskId = selectedTaskId;

  const setTab = useCallback(
    (nextTab: TabId, taskIdOverride?: string | null, replace = false) => {
      const targetTaskId = taskIdOverride ?? selectedTaskId ?? tasksQuery.data?.[0]?.taskId ?? null;
      if (!targetTaskId) return;
      navigate(taskRoute(targetTaskId, nextTab), { replace });
    },
    [navigate, selectedTaskId, tasksQuery.data],
  );

  const goToReport = useCallback(
    (taskId: string, view: ReportView, reportId: string | null = null, replace = false) => {
      const params = new URLSearchParams();
      params.set("view", view);
      if (reportId) {
        params.set("reportId", reportId);
      }
      const nextPath = taskRoute(taskId, "report");
      const nextSearch = `?${params.toString()}`;
      if (location.pathname === nextPath && location.search === nextSearch) return;
      navigate({ pathname: nextPath, search: nextSearch }, { replace });
    },
    [location.pathname, location.search, navigate],
  );

  const setReportView = useCallback(
    (nextView: ReportView) => {
      if (!selectedTaskId) return;
      goToReport(selectedTaskId, nextView, nextView === "outputs" ? null : activeCustomReportId);
    },
    [activeCustomReportId, goToReport, selectedTaskId],
  );

  const setActiveCustomReportId = useCallback(
    (reportId: string | null) => {
      if (!selectedTaskId) return;
      goToReport(selectedTaskId, reportView, reportId);
    },
    [goToReport, reportView, selectedTaskId],
  );

  useCanonicalTaskRoute({
    isAuthed,
    routeState,
    storeSelectedTaskId,
    taskIds: (tasksQuery.data ?? []).map((taskItem) => taskItem.taskId),
    locationPathname: location.pathname,
    locationSearch: location.search,
    navigate,
    setSelectedTaskId,
  });

  const {
    isNewTaskModalOpen,
    setIsNewTaskModalOpen,
    newTaskName,
    setNewTaskName,
    newTaskFile,
    setNewTaskFile,
    newTaskStage,
    newTaskError,
    newTaskUploadPercent,
    pendingCreateJobQuery,
    normalizedNewTaskName,
    taskNameAlreadyExists,
    showTaskNameExistsWarning,
    openNewTaskModal,
    handleCreateTaskWithUpload,
  } = useTaskLifecycle({
    isAuthed,
    isPageVisible,
    selectedTaskId,
    existingTaskNames: (tasksQuery.data ?? []).map((taskItem) => taskItem.name),
    queryClient,
    setSelectedTaskId,
    setTab,
    onTrackJobId: (jobId) => setJobIds((previous) => appendTrackedJobId(previous, jobId)),
  });

  const automationVideoOptions = useMemo(
    () => AUTOMATION_VIDEO_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
    [],
  );
  const selectedAutomationVideoOptions = useMemo<AutomationVideoRunOption[]>(
    () =>
      AUTOMATION_VIDEO_OPTIONS.map((option) => ({
        ...option,
        enabled: automationSelectedVideoOptionIds.includes(option.id),
      })).filter((option) => option.enabled),
    [automationSelectedVideoOptionIds],
  );

  const taskQuery = useQuery({
    queryKey: ["task", selectedTaskId],
    queryFn: async () => apiClient.getTask(selectedTaskId as string),
    enabled: isAuthed && !!selectedTaskId && !isReportTab,
    staleTime: 15_000,
    refetchInterval: isAuthed && !!selectedTaskId && isPageVisible ? TASK_URL_REFRESH_MS : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const reportTaskQuery = useQuery({
    queryKey: ["task", "report", reportTaskId],
    queryFn: async () => apiClient.getTask(reportTaskId as string),
    enabled: isAuthed && !!reportTaskId && isReportTab,
    staleTime: 15_000,
    refetchInterval: isAuthed && !!reportTaskId && isPageVisible ? TASK_URL_REFRESH_MS : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const assetTaskQueries = useQueries({
    queries: (tasksQuery.data ?? []).map((taskItem) => ({
      queryKey: ["task", "assets", taskItem.taskId],
      queryFn: () => apiClient.getTask(taskItem.taskId),
      enabled: isAuthed && tab === "assets" && isPageVisible,
      refetchOnWindowFocus: false as const,
    })),
  });

  const task = taskQuery.data;
  const reportTask = reportTaskQuery.data;
  const assetTasks = useMemo(
    () => assetTaskQueries.map((query) => query.data).filter((item): item is TaskDetail => Boolean(item)),
    [assetTaskQueries],
  );
  const segmentsById = useMemo(
    () => new Map((task?.segments ?? []).map((segment) => [segment.segmentId, segment])),
    [task?.segments],
  );
  const {
    selectedGenIds,
    setSelectedGenIds,
    temporalFeatherFrames,
    setTemporalFeatherFrames,
    mergeInsertStartFrame,
    setMergeInsertStartFrame,
    mergeTrimStartFrames,
    setMergeTrimStartFrames,
    mergeTrimEndFrames,
    setMergeTrimEndFrames,
    segmentGenerations,
    selectedSegmentGenerations,
    selectedMergeGenerations,
    selectedPreviewGeneration,
    sortedExports,
    mergeTargetGeneration,
    mergeTargetSegment,
    selectSegmentGeneration,
  } = useGenerationMergeState({
    task,
    selectedSegmentId,
    segmentsById,
  });

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
        qualityMatched: Boolean(activeEditFrame.qualityMatched || activeEditFrame.qualityMatchStatus?.qualityMatched),
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
        qualityMatched: Boolean(variant.qualityMatch?.analysisId),
        isSelected: activeCompareVariantId === variant.variantId,
      });
    }
    return candidates;
  }, [activeCompareVariantId, activeEditFrame, activeEditVariants]);
  const activeFrameDimensions = useMemo(() => {
    const width = activeEditFrame?.width ?? task?.video?.editSource?.width;
    const height = activeEditFrame?.height ?? task?.video?.editSource?.height;
    if (!activeEditFrame || !width || !height) return null;
    return { width, height };
  }, [activeEditFrame, task?.video?.editSource?.height, task?.video?.editSource?.width]);
  const activeFrameWidth = activeFrameDimensions?.width ?? null;
  const activeFrameHeight = activeFrameDimensions?.height ?? null;
  const activePatchReference = patchReferenceImages[editFrameTab];
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
  useEffect(() => {
    setFirstFrameId(null);
    setLastFrameId(null);
    setQualityMatchModal({
      isOpen: false,
      frameId: null,
      variantId: null,
      variantLabel: "",
      originalFrameUrl: null,
      generatedFrameUrl: null,
      alreadyReviewed: false,
    });
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
    if (tab === "assets") {
      setUploadAssetsVisible(6);
      setFrameAssetsVisible(6);
      setVideoAssetsVisible(6);
    }
  }, [tab]);

  useEffect(() => {
    setGenerationCardsVisible(6);
  }, [selectedSegmentId]);

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
      navigate("/", { replace: true });
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

  const saveSegmentCropMutation = useMutation({
    mutationFn: async ({
      segmentId,
      crop,
    }: {
      segmentId: string;
      crop: { aspect: "16:9" | "9:16"; x: number; y: number; width: number; height: number; featherPx?: number } | null;
    }) => {
      if (!selectedTaskId) throw new Error("Select task");
      return apiClient.patchSegment(selectedTaskId, segmentId, { crop });
    },
    onSuccess: async (result, variables) => {
      setSelectedSegmentId(variables.segmentId);
      if (result.segment?.startFrameId) {
        setFirstFrameId(result.segment.startFrameId);
      }
      if (result.segment?.endFrameId) {
        setLastFrameId(result.segment.endFrameId);
      }
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
    onSuccess: (result) => setJobIds((prev) => appendTrackedJobId(prev, result.jobId)),
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
    onSuccess: (result) => setJobIds((prev) => appendTrackedJobId(prev, result.jobId)),
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
      const selectedMode =
        lumaModel === "runway-gen4.5"
          ? "runway_i2v"
          : lumaModel === "kling-2.6"
            ? generationInputMode === "start_only"
              ? "kling_start_only"
              : "kling_start_end"
            : lumaModel === "veo-3.1" || lumaModel === "veo-3.1-fast"
              ? generationInputMode === "start_only"
                ? "veo_start_only"
                : "veo_start_end"
              : lumaModel === "wan2.2-a14b"
                ? "wan_a14b_i2v"
                : lumaModel === "wan2.2-animate"
                  ? "wan_animate_replace"
                  : advancedMode;
      return apiClient.generateSegment(selectedTaskId, selectedSegmentId, {
        lumaModel,
        mode: selectedMode,
        prompt: lumaModel === "wan2.2-animate" ? undefined : lumaPrompt.trim() || undefined,
        firstFrameVariantId: compareVariantIds.first || undefined,
        lastFrameVariantId: generationInputMode === "start_end" ? compareVariantIds.last || undefined : undefined,
      });
    },
    onSuccess: (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
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
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      setTab("merge");
    },
  });

  const runQcMutation = useMutation({
    mutationFn: async ({ taskId, generationIds }: { taskId: string; generationIds?: string[] }) =>
      apiClient.runQc(taskId, generationIds?.length ? { generationIds } : undefined),
    onSuccess: async (result, variables) => {
      setJobIds((previous) => appendTrackedJobId(previous, result.jobId));
      await queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", variables.taskId] });
    },
  });

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
        if (!isPageVisible) return false;
        const status = q?.state?.data?.status;
        return status === "queued" || status === "running" ? 3000 : false;
      },
      staleTime: 10_000,
      refetchOnWindowFocus: false as const,
      refetchOnReconnect: false as const,
    })),
  });

  const seenDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let foundFreshTerminal = false;
    for (const jq of jobQueries) {
      const data = jq.data;
      if (!data) continue;
      if ((data.status === "complete" || data.status === "failed") && !seenDoneRef.current.has(data.jobId)) {
        seenDoneRef.current.add(data.jobId);
        foundFreshTerminal = true;
      }
    }
    if (!foundFreshTerminal) return;
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    if (selectedTaskId) {
      void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    }
    while (seenDoneRef.current.size > MAX_TRACKED_JOB_IDS * 5) {
      const oldest = seenDoneRef.current.values().next().value as string | undefined;
      if (!oldest) break;
      seenDoneRef.current.delete(oldest);
    }
  }, [jobQueries, queryClient, selectedTaskId]);

  useEffect(() => {
    if (jobIds.length <= MAX_TRACKED_JOB_IDS) return;
    setJobIds((previous) => previous.slice(-MAX_TRACKED_JOB_IDS));
  }, [jobIds]);
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
  const mergeOriginalSourceCacheKey = task?.video?.previewSource?.s3Key ?? task?.video?.editSource?.s3Key ?? "merge:original";
  const mergeGeneratedSourceCacheKey = mergeTargetGeneration?.outputKey ?? mergeTargetGeneration?.genId ?? "merge:generated";
  const mergeFrameStripEnabled = tab === "merge" && Boolean(mergeTargetGeneration && mergeTargetSegment);
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
    videoUrl: mergeFrameStripEnabled ? mergeOriginalVideoForPreview : null,
    fps: mergeFps,
    frameIndices: startBoundaryOriginalFrames,
    cachePrefix: "merge:start:original",
    sourceCacheKey: mergeOriginalSourceCacheKey,
  });
  const startBoundaryGeneratedThumbs = useVideoFrameStrip({
    videoUrl: mergeFrameStripEnabled ? mergeGeneratedVideoForPreview : null,
    fps: mergeFps,
    frameIndices: startBoundaryGeneratedFrames,
    cachePrefix: "merge:start:generated",
    sourceCacheKey: mergeGeneratedSourceCacheKey,
  });
  const endBoundaryGeneratedThumbs = useVideoFrameStrip({
    videoUrl: mergeFrameStripEnabled ? mergeGeneratedVideoForPreview : null,
    fps: mergeFps,
    frameIndices: endBoundaryGeneratedFrames,
    cachePrefix: "merge:end:generated",
    sourceCacheKey: mergeGeneratedSourceCacheKey,
  });
  const endBoundaryOriginalThumbs = useVideoFrameStrip({
    videoUrl: mergeFrameStripEnabled ? mergeOriginalVideoForPreview : null,
    fps: mergeFps,
    frameIndices: endBoundaryOriginalFrames,
    cachePrefix: "merge:end:original",
    sourceCacheKey: mergeOriginalSourceCacheKey,
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
  const generationHelp = useMemo(
    () => generationModelHelp(lumaModel, advancedMode, generationInputMode),
    [advancedMode, generationInputMode, lumaModel],
  );
  const generationInputNote = useMemo(() => {
    if (lumaModel === "wan2.2-a14b" || lumaModel === "runway-gen4.5") {
      return "Start frame variant is taken automatically from your Edit Frame selection.";
    }
    if (lumaModel === "wan2.2-animate") {
      return "Wan2.2 Animate uses start frame + source segment video. Text prompt is disabled in this flow unless LoRA inputs are used.";
    }
    if (generationInputMode === "start_only" && (lumaModel === "kling-2.6" || lumaModel === "veo-3.1" || lumaModel === "veo-3.1-fast")) {
      return "Start frame only is enforced in this tab; the end frame is not sent.";
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
            thumbnailUrl: generationThumbnailUrl(generation) ?? undefined,
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
    if (selectedSegment?.segmentClipUrl) return selectedSegment.segmentClipUrl;
    if (!task?.video?.editSource?.downloadUrl || !segmentWindow) return null;
    return `${task.video.editSource.downloadUrl}#t=${segmentWindow.startSec},${segmentWindow.endSec}`;
  }, [selectedSegment?.segmentClipUrl, segmentWindow, task?.video?.editSource?.downloadUrl]);
  const timelinePlaybackUrl = task?.video?.previewSource?.downloadUrl ?? task?.video?.editSource?.downloadUrl ?? "";

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

  function asNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function generationModelHelp(modelName: VideoModel, modeValue: string, inputMode: GenerateInputMode) {
    if (modelName === "kling-2.6") {
      return {
        title: inputMode === "start_only" ? "Kling 2.6 (Start Frame)" : "Kling 2.6 Start/End",
        lines: [
          inputMode === "start_only"
            ? "Uses only the selected start frame in this tab. It does not use source segment video."
            : "Uses start frame + end frame + segment duration. It does not use the source segment video for motion.",
          inputMode === "start_only"
            ? "Best prompt style: describe motion evolution from the start frame while preserving identity."
            : "Best prompt style: describe camera motion and action between start and end frames.",
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
        title:
          modelName === "veo-3.1-fast"
            ? inputMode === "start_only"
              ? "Runware Veo 3.1 Fast (Start Frame, No Audio)"
              : "Runware Veo 3.1 Fast (No Audio)"
            : inputMode === "start_only"
              ? "Runware Veo 3.1 (Start Frame, No Audio)"
              : "Runware Veo 3.1 (No Audio)",
        lines: [
          inputMode === "start_only"
            ? "Uses only the selected start frame in this tab. No source segment video is sent."
            : "Uses selected start and end frames as keyframes. No source segment video is sent.",
          "Duration is fixed at 8 seconds for Veo 3.1 API runs; merged output may be time-adjusted at insert.",
          inputMode === "start_only"
            ? "Prompting works best with clear motion direction and continuity constraints from the start frame."
            : "Prompting works best with clear motion direction and continuity constraints between start and end frames.",
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
      goToReport(taskId, reportType, result.reportId);
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
        goToReport(taskId, "outputs", null, true);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to delete report.");
    }
  }

  function openCustomReport(taskId: string, report: CustomReportRecord) {
    goToReport(taskId, report.reportType, report.reportId);
  }

  function openTaskReport(taskId: string) {
    goToReport(taskId, "outputs", null);
  }

  const refreshSignedUrlsForTask = useCallback(
    (taskId: string | null | undefined) => {
      if (!taskId) return;
      const now = Date.now();
      const previous = signedUrlRefreshRef.current.get(taskId) ?? 0;
      if (now - previous < 15_000) return;
      signedUrlRefreshRef.current.set(taskId, now);
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", "report", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", "assets", taskId] });
    },
    [queryClient],
  );

  const openNewTaskWithAutomationDefaults = useCallback(() => {
    setAutomationEnabled(false);
    setAutomationStartPrompt("");
    setAutomationEndPrompt("");
    setAutomationSelectedVideoOptionIds(AUTOMATION_VIDEO_OPTIONS.map((option) => option.id));
    setAutomationUiError(null);
    openNewTaskModal();
  }, [openNewTaskModal]);

  const cancelAutomationRun = useCallback(() => {
    automationCancelRef.current = true;
    setAutomationRunState((previous) => ({
      ...previous,
      cancelRequested: true,
      detail: "Cancel requested. Started generations continue in the background.",
    }));
  }, []);

  const waitForAutomationJob = useCallback(
    async (jobId: string, label: string, timeoutMs = 25 * 60 * 1000) => {
      const startedAt = Date.now();
      while (true) {
        if (automationCancelRef.current) {
          throw new Error(AUTOMATION_CANCELLED);
        }
        const job = await apiClient.getJob(jobId);
        setAutomationRunState((previous) =>
          previous.isOpen
            ? { ...previous, phase: label, detail: `${job.status.toUpperCase()} (${job.progress ?? 0}%)` }
            : previous,
        );
        if (job.status === "complete") {
          return job;
        }
        if (job.status === "failed") {
          throw new Error(job.error || `${label} failed`);
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`${label} timed out`);
        }
        await sleep(2000);
      }
    },
    [],
  );

  const requestAutomationSelection = useCallback(
    (selection: AutomationSelectionState) =>
      new Promise<{ startVariantId: string; endVariantId: string | null; cancelled: boolean }>((resolve) => {
        automationSelectionResolverRef.current = resolve;
        setAutomationSelectionState(selection);
      }),
    [],
  );

  const resolveAutomationSelection = useCallback((choice: { startVariantId: string; endVariantId: string | null; cancelled: boolean }) => {
    const resolver = automationSelectionResolverRef.current;
    automationSelectionResolverRef.current = null;
    setAutomationSelectionState(null);
    if (resolver) {
      resolver(choice);
    }
  }, []);

  useEffect(() => {
    return () => {
      const resolver = automationSelectionResolverRef.current;
      if (resolver) {
        resolver({ startVariantId: "", endVariantId: null, cancelled: true });
        automationSelectionResolverRef.current = null;
      }
    };
  }, []);

  const runAutomatedPipeline = useCallback(
    async ({
      taskId,
      startPrompt,
      endPrompt,
      selectedVideoOptions,
    }: {
      taskId: string;
      startPrompt: string;
      endPrompt: string;
      selectedVideoOptions: AutomationVideoRunOption[];
    }) => {
      automationCancelRef.current = false;
      setAutomationUiError(null);
      setAutomationRunState({
        isOpen: true,
        taskId,
        phase: "Preparing automation",
        detail: "Loading ingested task metadata...",
        cancelRequested: false,
        terminal: false,
      });

      const imageModels: Array<{ model: "nano_banana_pro" | "nano_banana" | "chatgpt"; label: string }> = [
        { model: "nano_banana_pro", label: "Nano Banana Pro" },
        { model: "nano_banana", label: "Nano Banana Std" },
        { model: "chatgpt", label: "ChatGPT-image" },
      ];

      const throwIfCancelled = () => {
        if (automationCancelRef.current) {
          throw new Error(AUTOMATION_CANCELLED);
        }
      };

      try {
        setSelectedTaskId(taskId);
        setTab("frames", taskId, true);

        const loadReadyTask = async () => {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            throwIfCancelled();
            const current = await apiClient.getTask(taskId);
            const hasVideo = Boolean(current.video?.editSource?.downloadUrl && current.video?.editSource?.frameCount);
            if (hasVideo) return current;
            await sleep(1500);
          }
          throw new Error("Task ingest did not become ready in time.");
        };

        let currentTask = await loadReadyTask();
        const totalFrames = Math.max(1, currentTask.video?.editSource?.frameCount ?? 0);

        setAutomationRunState((previous) => ({
          ...previous,
          phase: "Segment setup",
          detail: "Creating or reusing full-clip segment...",
        }));

        let segment = currentTask.segments.find((item) => item.startFrame === 0 && item.endFrameExclusive === totalFrames) ?? null;
        if (!segment) {
          const created = await apiClient.createSegment(taskId, { startFrameIndex: 0, durationSeconds: 1 });
          await apiClient.patchSegment(taskId, created.segmentId, { startFrameIndex: 0, endFrameExclusive: totalFrames });
          setSelectedSegmentId(created.segmentId);
        } else {
          setSelectedSegmentId(segment.segmentId);
        }

        await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        currentTask = await apiClient.getTask(taskId);
        segment = currentTask.segments.find((item) => item.startFrame === 0 && item.endFrameExclusive === totalFrames) ?? null;
        if (!segment) {
          throw new Error("Automation could not prepare the full-clip segment.");
        }

        setAutomationRunState((previous) => ({
          ...previous,
          phase: "Frame capture",
          detail: "Capturing start and end frames...",
        }));
        const startCapture = await apiClient.captureFrame(taskId, segment.startFrame);
        const endCapture = await apiClient.captureFrame(taskId, Math.max(segment.startFrame, segment.endFrameExclusive - 1));
        setFirstFrameId(startCapture.frameId);
        setLastFrameId(endCapture.frameId);
        setSelectedFrameId(startCapture.frameId);

        const runFullEditsForFrame = async (frameId: string, promptValue: string, frameLabel: string) => {
          if (!promptValue.trim()) return [] as Array<{ variantId: string; model: string }>;
          const editJobs: Array<{ model: "nano_banana_pro" | "nano_banana" | "chatgpt"; jobId: string }> = [];
          for (let index = 0; index < imageModels.length; index += 1) {
            throwIfCancelled();
            const modelEntry = imageModels[index];
            setAutomationRunState((previous) => ({
              ...previous,
              phase: `Editing ${frameLabel} frame`,
              detail: `Queueing ${modelEntry.label} (${index + 1}/${imageModels.length})...`,
            }));
            const created = await apiClient.fullEdit(taskId, frameId, {
              model: modelEntry.model,
              prompt: promptValue,
              sourceVariantId: "original",
            });
            editJobs.push({ model: modelEntry.model, jobId: created.jobId });
            setJobIds((previous) => appendTrackedJobId(previous, created.jobId));
          }
          const settled = await Promise.allSettled(
            editJobs.map((job) => waitForAutomationJob(job.jobId, `Editing ${frameLabel} frame (${job.model})`)),
          );
          throwIfCancelled();
          const variants: Array<{ variantId: string; model: string }> = [];
          for (let index = 0; index < settled.length; index += 1) {
            const result = settled[index];
            if (result.status !== "fulfilled") continue;
            const variantId = result.value.resultRefs?.variantId;
            if (typeof variantId === "string") {
              variants.push({ variantId, model: editJobs[index].model });
            }
          }
          return variants;
        };

        const trimmedEndPrompt = endPrompt.trim();
        const startEdits = await runFullEditsForFrame(startCapture.frameId, startPrompt, "start");
        const endEdits = trimmedEndPrompt ? await runFullEditsForFrame(endCapture.frameId, trimmedEndPrompt, "end") : [];
        if (!startEdits.length) {
          throw new Error("Automation did not produce any edited start-frame variants.");
        }

        await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        currentTask = await apiClient.getTask(taskId);

        const buildChoices = (frameId: string, variants: Array<{ variantId: string; model: string }>): AutomationVariantChoice[] => {
          const frame = currentTask.frames[frameId];
          if (!frame) return [];
          const choices: AutomationVariantChoice[] = [];
          for (const variantRef of variants) {
            const variant = frame.variants.find((item) => item.variantId === variantRef.variantId);
            if (!variant?.imageUrl) continue;
            choices.push({
              frameId,
              variantId: variant.variantId,
              imageUrl: variant.imageUrl,
              model: String(variant.model),
              createdAt: variant.createdAt,
            });
          }
          return choices.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        };

        const startChoices = buildChoices(startCapture.frameId, startEdits);
        const endChoices = buildChoices(endCapture.frameId, endEdits);
        if (!startChoices.length) {
          throw new Error("Automation could not load edited start-frame previews.");
        }

        setAutomationRunState((previous) => ({ ...previous, isOpen: false }));
        const choice = await requestAutomationSelection({
          taskId,
          segmentId: segment.segmentId,
          startFrameId: startCapture.frameId,
          endFrameId: endCapture.frameId,
          startChoices,
          endChoices,
          startSelectedVariantId: startChoices[0]?.variantId ?? null,
          endSelectedVariantId: endChoices[0]?.variantId ?? null,
        });
        if (choice.cancelled) {
          throw new Error(AUTOMATION_CANCELLED);
        }
        if (!choice.startVariantId) {
          throw new Error("Select a start-frame variant to continue automation.");
        }

        setAutomationRunState({
          isOpen: true,
          taskId,
          phase: "Video generation",
          detail: "Queueing model runs...",
          cancelRequested: false,
          terminal: false,
        });

        try {
          await apiClient.selectVariant(taskId, startCapture.frameId, choice.startVariantId);
          if (choice.endVariantId) {
            await apiClient.selectVariant(taskId, endCapture.frameId, choice.endVariantId);
          }
        } catch {
          // Non-fatal: these are convenience selections only.
        }
        setCompareVariantIds({
          first: choice.startVariantId,
          last: choice.endVariantId,
        });
        setEditSourceVariantIds({
          first: choice.startVariantId,
          last: choice.endVariantId,
        });

        const generationJobs: Array<{ option: AutomationVideoRunOption; jobId: string }> = [];
        for (let index = 0; index < selectedVideoOptions.length; index += 1) {
          throwIfCancelled();
          const option = selectedVideoOptions[index];
          setAutomationRunState((previous) => ({
            ...previous,
            phase: "Video generation",
            detail: `Queueing ${option.label} (${index + 1}/${selectedVideoOptions.length})...`,
          }));
          try {
            const created = await apiClient.generateSegment(taskId, segment.segmentId, {
              lumaModel: option.lumaModel,
              mode: option.mode,
              firstFrameVariantId: choice.startVariantId,
              lastFrameVariantId: option.inputMode === "start_end" ? choice.endVariantId ?? undefined : undefined,
            });
            generationJobs.push({ option, jobId: created.jobId });
            setJobIds((previous) => appendTrackedJobId(previous, created.jobId));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown generation queue error";
            setAutomationRunState((previous) => ({
              ...previous,
              detail: `Failed to queue ${option.label}: ${message}`,
            }));
          }
        }

        if (!generationJobs.length) {
          throw new Error("No automated video generations were queued.");
        }

        const generationResults = await Promise.allSettled(
          generationJobs.map((entry) => waitForAutomationJob(entry.jobId, `Generating ${entry.option.label}`, 35 * 60 * 1000)),
        );
        throwIfCancelled();
        const succeededCount = generationResults.filter((result) => result.status === "fulfilled").length;
        if (!succeededCount) {
          throw new Error("All automated video generations failed.");
        }

        await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "report", taskId] });
        setSelectedTaskId(taskId);
        setSelectedSegmentId(segment.segmentId);
        goToReport(taskId, "outputs", null, true);
        setAutomationRunState({
          isOpen: true,
          taskId,
          phase: "Completed",
          detail: `Automation complete. ${succeededCount} of ${generationJobs.length} video generations succeeded.`,
          cancelRequested: false,
          terminal: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Automation failed";
        const cancelled = message === AUTOMATION_CANCELLED;
        setAutomationRunState((previous) => ({
          ...previous,
          isOpen: true,
          phase: cancelled ? "Cancelled" : "Failed",
          detail: cancelled
            ? "Automation stopped. Already-started jobs continue in the background."
            : message,
          terminal: true,
        }));
      }
    },
    [fpsValue, goToReport, queryClient, requestAutomationSelection, setSelectedFrameId, setSelectedSegmentId, setSelectedTaskId, setTab, waitForAutomationJob],
  );

  const handleNewTaskSubmit = useCallback(() => {
    setAutomationUiError(null);
    if (automationEnabled) {
      if (!automationStartPrompt.trim()) {
        setAutomationUiError("Automation requires a start-frame edit prompt.");
        return;
      }
      if (!selectedAutomationVideoOptions.length) {
        setAutomationUiError("Select at least one video model variant for automation.");
        return;
      }
    }
    const startPrompt = automationStartPrompt.trim();
    const endPrompt = automationEndPrompt.trim();
    const selectedVideoOptions = [...selectedAutomationVideoOptions];
    void handleCreateTaskWithUpload(
      automationEnabled
        ? {
            onIngestComplete: async (taskId) => {
              await runAutomatedPipeline({ taskId, startPrompt, endPrompt, selectedVideoOptions });
            },
          }
        : undefined,
    );
  }, [
    automationEnabled,
    automationEndPrompt,
    automationStartPrompt,
    handleCreateTaskWithUpload,
    runAutomatedPipeline,
    selectedAutomationVideoOptions,
  ]);

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

  const saveSegmentCrop = useCallback(
    async (crop: { aspect: "16:9" | "9:16"; x: number; y: number; width: number; height: number; featherPx?: number } | null) => {
      if (!selectedTaskId) throw new Error("Select a task first.");
      let segmentId = selectedSegmentId;
      if (!segmentId) {
        segmentId = await ensureSegmentForSelectedFrames();
      }
      if (!segmentId) {
        throw new Error("You need to pick start and end frames before cropping.");
      }
      await saveSegmentCropMutation.mutateAsync({ segmentId, crop });
    },
    [ensureSegmentForSelectedFrames, saveSegmentCropMutation, selectedSegmentId, selectedTaskId],
  );

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

  function openQualityMatchModal(candidate: EditFrameCandidate) {
    if (!activeEditFrame || candidate.kind !== "variant" || !candidate.variantId) return;
    const frameRecord = task?.frames?.[activeEditFrame.frameId];
    if (!frameRecord) return;
    setQualityMatchModal({
      isOpen: true,
      frameId: frameRecord.frameId,
      variantId: candidate.variantId,
      variantLabel: `${candidate.label} · frame ${frameRecord.frameIndex} (${frameRecord.timecode})`,
      originalFrameUrl: frameRecord.imageUrl ?? null,
      generatedFrameUrl: candidate.imageUrl,
      alreadyReviewed: Boolean(frameRecord.qualityMatched || frameRecord.qualityMatchStatus?.qualityMatched),
    });
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
              type="button"
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!taskId || createCustomReportMutation.isPending}
              onClick={() => taskId && createCustomReportFromSelection(taskId, "qc_frame")}
            >
              Create QC Frame report
            </button>
            <button
              type="button"
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

  const pickFrameTabCtx = useMemo<PickFrameTabCtx>(
    () => ({
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
      isSavingSegmentCrop: saveSegmentCropMutation.isPending,
    }),
    [
      timelinePlaybackUrl,
      task,
      currentFrameIndex,
      firstFrame,
      timelineDelta,
      hasHardDurationLimit,
      lumaHardLimitFrames,
      lumaHardLimitSeconds,
      lastFrame,
      selectedRange,
      lumaModel,
      selectedSegmentId,
      selectedSegment,
      captureCurrentFrameFor,
      ensureSegmentForSelectedFrames,
      saveSegmentCrop,
      saveSegmentCropMutation.isPending,
      setCurrentFrameIndex,
      setSelectedSegmentId,
    ],
  );

  const editFrameTabCtx = useMemo<EditFrameTabCtx>(
    () => ({
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
      formatCompactTimestamp,
      openQualityMatchModal,
    }),
    [
      editFrameTab,
      activeEditFrame,
      prompt,
      model,
      fullEditMutation,
      task,
      activeEditSourceImageUrl,
      activeCompareImageUrl,
      activeEditCandidates,
      selectCompareCandidate,
      selectedTaskId,
      handleDeleteAsset,
      activeFrameDimensions,
      patchEngine,
      patchToolMode,
      patchBrushSize,
      featherPx,
      edgeAwareRefine,
      edgeAwareStrength,
      edgeAwareRadiusPx,
      maskGrowPx,
      activePatchReference,
      runwareRepaintingScale,
      patchPrompt,
      patchEditMutation,
      maskHasPaint,
      openQualityMatchModal,
    ],
  );

  const generateTabCtx = useMemo<GenerateTabCtx>(
    () => ({
      setGenerationInputMode,
      setLumaModel,
      generationModelByInput,
      generationInputMode,
      selectedSegment,
      describeSegment,
      lumaModel,
      setGenerationModelByInput,
      generationModelOptions,
      advancedMode,
      setAdvancedMode,
      lumaPrompt,
      setLumaPrompt,
      generationInputNote,
      generationHelp,
      selectedSegmentOverLimit,
      lumaHardLimitSeconds,
      selectedSegmentId,
      generateSegmentMutation,
      segmentWindow,
      originalSegmentPreviewUrl,
      selectedPreviewGeneration,
      task,
      compareOriginalRef,
      keepOriginalWithinSegment,
      compareVariantRef,
      syncOriginalToGenerated,
      selectedSegmentGenerations,
      generationCardsVisible,
      truncateIdentifier,
      selectSegmentGeneration,
      describeGeneration,
      generationThumbnailUrl,
      formatCompactTimestamp,
      setVideoPreviewModal,
      onAssetError: () => refreshSignedUrlsForTask(selectedTaskId),
      handleDeleteAsset,
      setGenerationCardsVisible,
    }),
    [
      generationModelByInput,
      generationInputMode,
      selectedSegment,
      lumaModel,
      generationModelOptions,
      advancedMode,
      lumaPrompt,
      generationInputNote,
      generationHelp,
      selectedSegmentOverLimit,
      lumaHardLimitSeconds,
      selectedSegmentId,
      generateSegmentMutation,
      segmentWindow,
      originalSegmentPreviewUrl,
      selectedPreviewGeneration,
      task,
      selectedSegmentGenerations,
      generationCardsVisible,
      selectSegmentGeneration,
      selectedTaskId,
      refreshSignedUrlsForTask,
      handleDeleteAsset,
    ],
  );

  const mergeTabCtx = useMemo<MergeTabCtx>(
    () => ({
      mergeTargetGeneration,
      mergeTargetSegment,
      describeGeneration,
      describeSegment,
      mergeMaxFrameIndex,
      mergeInsertStartFrame,
      setMergeInsertStartFrame,
      mergeGeneratedDurationFrames,
      mergeTrimStartFrames,
      setMergeTrimStartFrames,
      mergeTrimEndFrames,
      setMergeTrimEndFrames,
      temporalFeatherFrames,
      setTemporalFeatherFrames,
      mergeOriginalStartFrame,
      mergeOriginalEndFrameExclusive,
      mergeOriginalDurationFrames,
      formatFramesAndSeconds,
      mergeFps,
      mergeEffectiveDurationFrames,
      mergeInsertStartFrameClamped,
      mergeEffectiveEndFrameExclusive,
      mergeEndOffsetFrames,
      mergeGeneratedStartAnchor,
      mergeFeatherClamped,
      startBoundaryOriginalThumbs,
      startBoundaryGeneratedThumbs,
      MergeBoundaryPreview,
      mergeGeneratedEndAnchor,
      endBoundaryGeneratedThumbs,
      endBoundaryOriginalThumbs,
      mergeMutation,
      sortedExports,
      humanizeFilename,
      keyBasenameFromS3Key,
      formatCompactTimestamp,
    }),
    [
      mergeTargetGeneration,
      mergeTargetSegment,
      mergeMaxFrameIndex,
      mergeInsertStartFrame,
      mergeGeneratedDurationFrames,
      mergeTrimStartFrames,
      mergeTrimEndFrames,
      temporalFeatherFrames,
      mergeOriginalStartFrame,
      mergeOriginalEndFrameExclusive,
      mergeOriginalDurationFrames,
      mergeFps,
      mergeEffectiveDurationFrames,
      mergeInsertStartFrameClamped,
      mergeEffectiveEndFrameExclusive,
      mergeEndOffsetFrames,
      mergeGeneratedStartAnchor,
      mergeFeatherClamped,
      startBoundaryOriginalThumbs,
      startBoundaryGeneratedThumbs,
      mergeGeneratedEndAnchor,
      endBoundaryGeneratedThumbs,
      endBoundaryOriginalThumbs,
      mergeMutation,
      sortedExports,
    ],
  );

  const assetsTabCtx = useMemo<AssetsTabCtx>(
    () => ({
      selectedTaskId,
      task,
      renderCustomReportBox,
      assetsLoading,
      uploadAssets,
      uploadAssetsVisible,
      formatAssetDate,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      handleDeleteAsset,
      setUploadAssetsVisible,
      frameAssets,
      frameAssetsVisible,
      setFrameAssetsVisible,
      outputVideoAssets,
      videoAssetsVisible,
      setVideoAssetsVisible,
    }),
    [
      selectedTaskId,
      task,
      assetsLoading,
      uploadAssets,
      uploadAssetsVisible,
      selectedReportOutputs,
      handleDeleteAsset,
      frameAssets,
      frameAssetsVisible,
      outputVideoAssets,
      videoAssetsVisible,
    ],
  );

  const jobsPanelCtx = useMemo<JobsPanelCtx>(
    () => ({
      sortedJobs,
      jobsVisible,
      setJobsVisible,
    }),
    [sortedJobs, jobsVisible],
  );

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
    return (
      <Suspense fallback={<main className="min-h-screen bg-bg p-8 text-ink">Loading report...</main>}>
        <ReportsPage
          ctx={{
            reportTask,
            reportTaskId,
            sortedJobs,
            selectedOutputRefsByTask,
            reportOutputRefKey,
            reportView,
            setReportView,
            setActiveCustomReportId,
            activeCustomReportId,
            goToTaskTimeline: (taskId: string) => setTab("timeline", taskId),
            logout,
            formatAssetDate,
            truncateIdentifier,
            reportTaskQuery,
            runQcMutation,
            renderCustomReportBox,
            toggleCustomReportOutput,
            setVideoPreviewModal,
            setImagePreviewModal,
            formatCompactTimestamp,
            asNumber,
            describeSegment,
            fpsValue,
            reportGraphModal,
            setReportGraphModal,
          }}
        />
      </Suspense>
    );
  }

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto grid max-w-[1500px] grid-cols-12 gap-4 p-4 md:p-6">
        <TaskSidebar
          tasks={tasksQuery.data ?? []}
          selectedTaskId={selectedTaskId}
          onSignOut={() => {
            void logout();
          }}
          onOpenNewTask={openNewTaskWithAutomationDefaults}
          onOpenTaskReport={openTaskReport}
          onSelectTask={(taskId) => setTab(tab, taskId)}
          onDeleteTask={(taskId) => deleteTaskMutation.mutate(taskId)}
          onOpenAssetLibrary={() => {
            void handleTabChange("assets");
          }}
        />

        <section className="col-span-12 space-y-4 md:col-span-9">
          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            <WorkflowTabs
              tabs={tabs}
              activeTab={tab}
              onSelect={(tabId) => {
                void handleTabChange(tabId);
              }}
            />

            {tab === "timeline" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Pick Frame...</p>}>
                <PickFrameTab ctx={pickFrameTabCtx} />
              </Suspense>
            )}

            {tab === "frames" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Edit Frame...</p>}>
                <EditFrameTab ctx={editFrameTabCtx} />
              </Suspense>
            )}

            {tab === "generate" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Generate Video...</p>}>
                <GenerateTab ctx={generateTabCtx} />
              </Suspense>
            )}

            {tab === "merge" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Merge Video...</p>}>
                <MergeTab ctx={mergeTabCtx} />
              </Suspense>
            )}

            {tab === "assets" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Download Assets...</p>}>
                <AssetsTab ctx={assetsTabCtx} />
              </Suspense>
            )}
          </div>

          <Suspense fallback={<div className="rounded-2xl border border-ink/10 bg-card p-4 text-sm text-ink/60">Loading jobs...</div>}>
            <JobsPanel ctx={jobsPanelCtx} />
          </Suspense>
        </section>
      </div>
      <PreviewModals
        imagePreview={imagePreviewModal}
        videoPreview={videoPreviewModal}
        onCloseImage={() => setImagePreviewModal(null)}
        onCloseVideo={() => setVideoPreviewModal(null)}
        onMediaError={() => refreshSignedUrlsForTask(selectedTaskId)}
      />
      {automationRunState.isOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-ink/15 bg-card p-5 shadow-xl">
            <h3 className="text-lg font-semibold">{automationRunState.phase || "Running automation"}</h3>
            <p className="mt-2 text-sm text-ink/75">{automationRunState.detail || "Working..."}</p>
            <div className="mt-4 flex items-center justify-end gap-2">
              {automationRunState.terminal ? (
                <button
                  type="button"
                  className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
                  onClick={() =>
                    setAutomationRunState((previous) => ({
                      ...previous,
                      isOpen: false,
                    }))
                  }
                >
                  Close
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded border border-red-400 px-3 py-2 text-sm text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={automationRunState.cancelRequested}
                  onClick={cancelAutomationRun}
                >
                  {automationRunState.cancelRequested ? "Cancelling..." : "Cancel automation"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {automationSelectionState ? (
        <div className="fixed inset-0 z-[61] flex items-center justify-center bg-black/55 p-4">
          <div className="max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-2xl border border-ink/15 bg-card p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-lg font-semibold">Automation: Choose edited frames</h3>
                <p className="text-sm text-ink/70">
                  Select one edited start frame and an optional edited end frame before batch video generation.
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-ink/20 bg-white px-2 py-1 text-sm"
                onClick={() => resolveAutomationSelection({ startVariantId: "", endVariantId: null, cancelled: true })}
              >
                Cancel
              </button>
            </div>

            <section className="space-y-2">
              <h4 className="text-sm font-semibold">Start frame variants</h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {automationSelectionState.startChoices.map((choice) => {
                  const isSelected = automationSelectionState.startSelectedVariantId === choice.variantId;
                  return (
                    <button
                      key={`automation-start-${choice.variantId}`}
                      type="button"
                      onClick={() =>
                        setAutomationSelectionState((previous) =>
                          previous
                            ? {
                                ...previous,
                                startSelectedVariantId: choice.variantId,
                              }
                            : previous,
                        )
                      }
                      className={`overflow-hidden rounded-lg border text-left ${
                        isSelected ? "border-accent bg-accent/10" : "border-ink/15 bg-white"
                      }`}
                    >
                      <img src={choice.imageUrl} alt={`Start ${choice.model}`} className="aspect-video w-full bg-bg object-contain" />
                      <div className="space-y-1 p-2">
                        <p className="text-sm font-medium">{choice.model}</p>
                        <p className="text-xs text-ink/60">{formatCompactTimestamp(choice.createdAt)}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="mt-4 space-y-2">
              <h4 className="text-sm font-semibold">End frame variants (optional)</h4>
              {automationSelectionState.endChoices.length ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <button
                    type="button"
                    onClick={() =>
                      setAutomationSelectionState((previous) =>
                        previous
                          ? {
                              ...previous,
                              endSelectedVariantId: null,
                            }
                          : previous,
                      )
                    }
                    className={`rounded-lg border p-3 text-left ${
                      automationSelectionState.endSelectedVariantId == null ? "border-accent bg-accent/10" : "border-ink/15 bg-white"
                    }`}
                  >
                    <p className="text-sm font-medium">Use original end frame</p>
                    <p className="text-xs text-ink/60">No edited end frame will be sent.</p>
                  </button>
                  {automationSelectionState.endChoices.map((choice) => {
                    const isSelected = automationSelectionState.endSelectedVariantId === choice.variantId;
                    return (
                      <button
                        key={`automation-end-${choice.variantId}`}
                        type="button"
                        onClick={() =>
                          setAutomationSelectionState((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  endSelectedVariantId: choice.variantId,
                                }
                              : previous,
                          )
                        }
                        className={`overflow-hidden rounded-lg border text-left ${
                          isSelected ? "border-accent bg-accent/10" : "border-ink/15 bg-white"
                        }`}
                      >
                        <img src={choice.imageUrl} alt={`End ${choice.model}`} className="aspect-video w-full bg-bg object-contain" />
                        <div className="space-y-1 p-2">
                          <p className="text-sm font-medium">{choice.model}</p>
                          <p className="text-xs text-ink/60">{formatCompactTimestamp(choice.createdAt)}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-ink/60">No edited end-frame variants were generated. Original end frame will be used.</p>
              )}
            </section>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
                onClick={() => resolveAutomationSelection({ startVariantId: "", endVariantId: null, cancelled: true })}
              >
                Cancel automation
              </button>
              <button
                type="button"
                className="rounded bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!automationSelectionState.startSelectedVariantId}
                onClick={() =>
                  resolveAutomationSelection({
                    startVariantId: automationSelectionState.startSelectedVariantId ?? "",
                    endVariantId: automationSelectionState.endSelectedVariantId ?? null,
                    cancelled: false,
                  })
                }
              >
                Continue to video generation
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <QualityMatchModal
        isOpen={qualityMatchModal.isOpen}
        taskId={selectedTaskId}
        frameId={qualityMatchModal.frameId}
        variantId={qualityMatchModal.variantId}
        variantLabel={qualityMatchModal.variantLabel}
        originalFrameUrl={qualityMatchModal.originalFrameUrl}
        generatedFrameUrl={qualityMatchModal.generatedFrameUrl}
        alreadyReviewed={qualityMatchModal.alreadyReviewed}
        onClose={() =>
          setQualityMatchModal((previous) => ({
            ...previous,
            isOpen: false,
          }))
        }
        onApplied={() => {
          setQualityMatchModal((previous) => ({
            ...previous,
            isOpen: false,
          }));
          if (selectedTaskId) {
            void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
            void queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
            void queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
          }
        }}
      />
      <NewTaskModal
        isOpen={isNewTaskModalOpen}
        stage={newTaskStage}
        taskName={newTaskName}
        normalizedTaskName={normalizedNewTaskName}
        showTaskNameExistsWarning={showTaskNameExistsWarning}
        taskNameAlreadyExists={taskNameAlreadyExists}
        uploadPercent={newTaskUploadPercent}
        ingestProgress={pendingCreateJobQuery.data?.progress ?? 0}
        ingestStatus={pendingCreateJobQuery.data?.status ?? "queued"}
        error={automationUiError ?? newTaskError}
        canSubmit={!newTaskName.trim() ? false : Boolean(normalizedNewTaskName && newTaskFile)}
        automationEnabled={automationEnabled}
        automationStartPrompt={automationStartPrompt}
        automationEndPrompt={automationEndPrompt}
        automationVideoOptions={automationVideoOptions}
        automationSelectedVideoOptionIds={automationSelectedVideoOptionIds}
        onClose={() => {
          setAutomationUiError(null);
          setIsNewTaskModalOpen(false);
        }}
        onTaskNameChange={setNewTaskName}
        onFileSelect={setNewTaskFile}
        onAutomationEnabledChange={(value) => {
          setAutomationEnabled(value);
          if (!value) {
            setAutomationUiError(null);
          }
        }}
        onAutomationStartPromptChange={(value) => {
          setAutomationStartPrompt(value);
          if (automationUiError) setAutomationUiError(null);
        }}
        onAutomationEndPromptChange={setAutomationEndPrompt}
        onAutomationVideoSelectionChange={(selectedIds) => {
          setAutomationSelectedVideoOptionIds(selectedIds);
          if (automationUiError) setAutomationUiError(null);
        }}
        onSubmit={handleNewTaskSubmit}
      />
    </main>
  );
}

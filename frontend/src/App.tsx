import { Suspense, lazy, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import { apiClient } from "./api/client";
import VideoCleanupModal from "./components/cleanup/VideoCleanupModal";
import PreviewModals from "./components/layout/PreviewModals";
import TaskSidebar from "./components/layout/TaskSidebar";
import WorkflowTabs from "./components/layout/WorkflowTabs";
import MotionSyncModal from "./components/quality/MotionSyncModal";
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
import type { RefineFramesTabCtx } from "./pages/workflow/RefineFramesTab";
import { useUiStore } from "./store/uiStore";
import type {
  CustomReportOutputRef,
  CustomReportRecord,
  ExportRecord,
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
  | "kling-o1"
  | "kling-v3-omni-video"
  | "seedance-2.0-reference-to-video"
  | "veo-3.1"
  | "veo-3.1-fast"
  | "wan2.2-a14b"
  | "wan2.2-animate"
  | "wan2.7-videoedit";

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

type VideoCleanupModalState = {
  isOpen: boolean;
  generationId: string | null;
};

type AutomationRunState = {
  isOpen: boolean;
  taskId: string | null;
  phase: string;
  detail: string;
  cancelRequested: boolean;
  terminal: boolean;
  logs: string[];
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

type RefineVariantGroup = {
  editedVariant: FrameVariant;
  refinedVariants: FrameVariant[];
  isSelectedEdited: boolean;
  selectedRefinedVariantId: string | null;
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
const CustomQcPage = lazy(() => import("./pages/CustomQcPage"));
const ApiLogsPage = lazy(() => import("./pages/ApiLogsPage"));
const PickFrameTab = lazy(() => import("./pages/workflow/PickFrameTab"));
const EditFrameTab = lazy(() => import("./pages/workflow/EditFrameTab"));
const RefineFramesTab = lazy(() => import("./pages/workflow/RefineFramesTab"));
const GenerateTab = lazy(() => import("./pages/workflow/GenerateTab"));
const MergeTab = lazy(() => import("./pages/workflow/MergeTab"));
const AssetsTab = lazy(() => import("./pages/workflow/AssetsTab"));
const JobsPanel = lazy(() => import("./pages/workflow/JobsPanel"));

const VIDEO_FRAME_THUMBNAIL_CACHE = new Map<string, string | null>();
const MAX_TRACKED_JOB_IDS = 40;
const TASK_URL_REFRESH_MS = 15 * 60 * 1000;
const ACTIVE_TASK_POLL_MS = 3000;
const URL_REFRESH_IDLE_MS = 2 * 60 * 1000;
const AUTOMATION_CANCELLED = "__automation_cancelled__";
const SEGMENT_SELECTION_STORAGE_KEY = "aivfx:lastSegmentByTask:v1";

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

function hasActiveTaskWork(task: TaskDetail | undefined): boolean {
  if (!task) return false;
  for (const generation of Object.values(task.segmentGenerations ?? {})) {
    if (generation.status === "queued" || generation.status === "running") return true;
  }
  for (const track of task.videoCleanupTracks ?? []) {
    if (["created", "preparing", "tracking", "applying"].includes(track.status)) return true;
  }
  for (const report of task.customReports ?? []) {
    if (report.status === "queued" || report.status === "running") return true;
  }
  for (const exportItem of task.exports ?? []) {
    const motionSyncStatus = exportItem.motionSyncQc?.status;
    if (motionSyncStatus === "queued" || motionSyncStatus === "running") return true;
  }
  return false;
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

function readSegmentSelectionMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SEGMENT_SELECTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const output: Record<string, string> = {};
    for (const [taskId, segmentId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof taskId === "string" && typeof segmentId === "string" && taskId && segmentId) {
        output[taskId] = segmentId;
      }
    }
    return output;
  } catch {
    return {};
  }
}

function writeSegmentSelectionMap(value: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEGMENT_SELECTION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage errors (private mode/quota) without breaking app flow.
  }
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
  if (ref.assetType === "external_frame_pair") {
    return `external_frame_pair:${ref.pairId}`;
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

function formatAutomationLogEntry(message: string): string {
  const stamp = new Date().toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `[${stamp}] ${message}`;
}

function frameCount(task: TaskDetail | undefined): number {
  return task?.video?.editSource?.frameCount ?? 0;
}

function fpsValue(task: TaskDetail | undefined): number {
  const fps = task?.video?.editSource?.fps;
  if (!fps || !fps.den) return 30;
  return fps.num / fps.den;
}

const MODEL_FRAME_BUDGET_FPS = 24;

function videoModelLabel(model: VideoModel): string {
  if (model === "ray-2") return "Luma Ray 2";
  if (model === "ray-flash-2") return "Luma Ray Flash 2";
  if (model === "runway-gen4.5") return "Runway Gen-4.5";
  if (model === "kling-2.6") return "Kling 2.6";
  if (model === "kling-o1") return "Kling O1 Edit";
  if (model === "kling-v3-omni-video") return "Kling v3 Omni Video";
  if (model === "seedance-2.0-reference-to-video") return "Seedance 2.0 Reference to Video";
  if (model === "veo-3.1") return "Veo 3.1";
  if (model === "veo-3.1-fast") return "Veo 3.1 Fast";
  if (model === "wan2.2-a14b") return "Wan 2.2 A14B";
  if (model === "wan2.2-animate") return "Wan 2.2 Animate";
  if (model === "wan2.7-videoedit") return "Wan 2.7 VideoEdit";
  return model;
}

function formatFps(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function videoModelDurationConstraints(model: VideoModel): {
  minSeconds?: number;
  maxSeconds: number;
  frameBudgetFps?: number | null;
} {
  if (model === "ray-2") return { maxSeconds: 10 };
  if (model === "ray-flash-2") return { maxSeconds: 15 };
  if (model === "runway-gen4.5") return { maxSeconds: 10 };
  if (model === "kling-2.6") return { maxSeconds: 10 };
  if (model === "kling-o1") return { minSeconds: 3, maxSeconds: 10 };
  if (model === "kling-v3-omni-video") return { minSeconds: 3, maxSeconds: 10 };
  if (model === "seedance-2.0-reference-to-video") return { minSeconds: 4, maxSeconds: 15 };
  if (model === "veo-3.1" || model === "veo-3.1-fast") return { maxSeconds: 8, frameBudgetFps: MODEL_FRAME_BUDGET_FPS };
  if (model === "wan2.2-a14b") return { maxSeconds: 5 };
  if (model === "wan2.2-animate") return { maxSeconds: 10 };
  if (model === "wan2.7-videoedit") return { minSeconds: 2, maxSeconds: 10 };
  return { maxSeconds: 60 };
}

function assessVideoModelDurationLimit(
  model: VideoModel,
  durationFrames: number,
  durationSec: number,
  sourceFps: number,
): {
  minSeconds?: number;
  maxSeconds: number;
  maxFrames: number;
  overLimit: boolean;
  message: string | null;
} | null {
  const constraints = videoModelDurationConstraints(model);
  const minSeconds = constraints.minSeconds;
  const maxSeconds = constraints.maxSeconds;
  const frameBudgetFps = constraints.frameBudgetFps ?? null;
  const maxFrames = Math.round(maxSeconds * (frameBudgetFps ?? sourceFps));
  const overFrames = durationFrames > maxFrames;
  const overSeconds = durationSec > maxSeconds + 1e-6;
  const underSeconds = minSeconds != null && durationSec + 1e-6 < minSeconds;
  const label = videoModelLabel(model);
  if (underSeconds) {
    return {
      minSeconds,
      maxSeconds,
      maxFrames,
      overLimit: true,
      message: `${label} requires a source segment between ${minSeconds}s and ${maxSeconds}s. Your selection is ${durationSec.toFixed(2)}s.`,
    };
  }
  if (!overFrames && !overSeconds) {
    return { minSeconds, maxSeconds, maxFrames, overLimit: false, message: null };
  }
  if (frameBudgetFps != null && overFrames && Math.abs(sourceFps - frameBudgetFps) > 1e-3) {
    return {
      minSeconds,
      maxSeconds,
      maxFrames,
      overLimit: true,
      message: `${label} allows up to ${maxSeconds}s at ${frameBudgetFps}fps (${maxFrames} frames). Your selection is ${durationFrames} frames / ${durationSec.toFixed(2)}s at ${formatFps(sourceFps)}fps, so it exceeds that frame budget.`,
    };
  }
  return {
    minSeconds,
    maxSeconds,
    maxFrames,
    overLimit: true,
    message: `${label} allows up to ${maxSeconds}s. Your selection is ${durationFrames} frames / ${durationSec.toFixed(2)}s, which is over the limit.`,
  };
}

const GENERATION_MODELS_BY_INPUT: Record<GenerateInputMode, Array<{ value: VideoModel; label: string }>> = {
  start_video: [
    { value: "ray-flash-2", label: "Luma Ray Flash 2" },
    { value: "ray-2", label: "Luma Ray 2" },
    { value: "kling-o1", label: "Kling O1 Edit" },
    { value: "kling-v3-omni-video", label: "Kling v3 Omni Video" },
    { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video" },
    { value: "wan2.2-animate", label: "Wan 2.2 Animate" },
    { value: "wan2.7-videoedit", label: "Wan 2.7 VideoEdit" },
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
  { id: "kling-v3-omni-video:start_video:kling_v3_omni_video_edit", label: "Kling v3 Omni Video (Start frame + video)", inputMode: "start_video", lumaModel: "kling-v3-omni-video", mode: "kling_v3_omni_video_edit" },
  { id: "seedance-2.0-reference-to-video:start_video:seedance_reference_to_video", label: "Seedance 2.0 Reference to Video (Start frame + video)", inputMode: "start_video", lumaModel: "seedance-2.0-reference-to-video", mode: "seedance_reference_to_video" },
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
  const [edgeAwareRefine, setEdgeAwareRefine] = useState(false);
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
  const [replicateKlingMode, setReplicateKlingMode] = useState<"std" | "pro">("pro");
  const [replicateKlingV3Mode, setReplicateKlingV3Mode] = useState<"standard" | "pro">("pro");
  const [wan27Resolution, setWan27Resolution] = useState<"720p" | "1080p">("720p");
  const [editSourceVariantIds, setEditSourceVariantIds] = useState<{ first: string | null; last: string | null }>({
    first: null,
    last: null,
  });
  const [compareVariantIds, setCompareVariantIds] = useState<{ first: string | null; last: string | null }>({
    first: null,
    last: null,
  });
  const [refineSourceVariantIds, setRefineSourceVariantIds] = useState<{ first: string | null; last: string | null }>({
    first: null,
    last: null,
  });
  const [imagePreviewModal, setImagePreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [videoPreviewModal, setVideoPreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [reportGraphModal, setReportGraphModal] = useState<{ url: string; label: string } | null>(null);
  const [motionSyncModalExportId, setMotionSyncModalExportId] = useState<string | null>(null);
  const [qualityMatchModal, setQualityMatchModal] = useState<QualityMatchModalState>({
    isOpen: false,
    frameId: null,
    variantId: null,
    variantLabel: "",
    originalFrameUrl: null,
    generatedFrameUrl: null,
    alreadyReviewed: false,
  });
  const [videoCleanupModal, setVideoCleanupModal] = useState<VideoCleanupModalState>({
    isOpen: false,
    generationId: null,
  });
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [automationStartPrompt, setAutomationStartPrompt] = useState("");
  const [automationEndPrompt, setAutomationEndPrompt] = useState("");
  const [automationVideoPrompt, setAutomationVideoPrompt] = useState("");
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
    logs: [],
  });
  const [automationSelectionState, setAutomationSelectionState] = useState<AutomationSelectionState | null>(null);
  const [firstFrameId, setFirstFrameId] = useState<string | null>(null);
  const [lastFrameId, setLastFrameId] = useState<string | null>(null);
  const [editFrameTab, setEditFrameTab] = useState<"first" | "last">("first");
  const [refineFrameTab, setRefineFrameTab] = useState<"first" | "last">("first");
  const timelineVideoRef = useRef<HTMLVideoElement | null>(null);
  const compareOriginalRef = useRef<HTMLVideoElement | null>(null);
  const compareVariantRef = useRef<HTMLVideoElement | null>(null);
  const syncLockRef = useRef(false);
  const patchOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchDrawStateRef = useRef<{ tool: PatchToolMode; points: MaskPoint[]; last: MaskPoint | null } | null>(null);
  const signedUrlRefreshRef = useRef<Map<string, number>>(new Map());
  const pageHiddenAtRef = useRef<number | null>(null);
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
      goToReport(selectedTaskId, nextView, nextView === "reports" ? activeCustomReportId : null);
    },
    [activeCustomReportId, goToReport, selectedTaskId],
  );

  const setActiveCustomReportId = useCallback(
    (reportId: string | null) => {
      if (!selectedTaskId) return;
      goToReport(selectedTaskId, "reports", reportId);
    },
    [goToReport, selectedTaskId],
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
    newTaskStage,
    newTaskError,
    newTaskUploadPercent,
    pendingCreateJobQuery,
    normalizedNewTaskName,
    taskNameAlreadyExists,
    showTaskNameExistsWarning,
    openNewTaskModal,
    handleCreateTaskWithUpload,
    handleNewTaskFileSelect,
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
    refetchInterval: (query) => {
      if (!(isAuthed && !!selectedTaskId && isPageVisible)) return false;
      const currentTask = query.state.data as TaskDetail | undefined;
      return hasActiveTaskWork(currentTask) ? ACTIVE_TASK_POLL_MS : TASK_URL_REFRESH_MS;
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const reportTaskQuery = useQuery({
    queryKey: ["task", "report", reportTaskId],
    queryFn: async () => apiClient.getTask(reportTaskId as string),
    enabled: isAuthed && !!reportTaskId && isReportTab,
    staleTime: 15_000,
    refetchInterval: (query) => {
      if (!(isAuthed && !!reportTaskId && isPageVisible)) return false;
      const currentTask = query.state.data as TaskDetail | undefined;
      return hasActiveTaskWork(currentTask) ? ACTIVE_TASK_POLL_MS : TASK_URL_REFRESH_MS;
    },
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
  const selectedMotionSyncExport = useMemo<ExportRecord | null>(() => {
    if (!motionSyncModalExportId) return null;
    return (task?.exports ?? []).find((item) => item.exportId === motionSyncModalExportId) ?? null;
  }, [motionSyncModalExportId, task?.exports]);
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
  const completeGenerations = useMemo(
    () => segmentGenerations.filter((generation) => generation.status === "complete" && Boolean(generation.outputKey)),
    [segmentGenerations],
  );
  const getSegmentForGeneration = useCallback(
    (generation: SegmentGeneration) => segmentsById.get(generation.segmentId) ?? null,
    [segmentsById],
  );
  const activeVideoCleanupGeneration = useMemo<SegmentGeneration | null>(() => {
    if (!videoCleanupModal.generationId) return null;
    return task?.segmentGenerations?.[videoCleanupModal.generationId] ?? null;
  }, [task?.segmentGenerations, videoCleanupModal.generationId]);
  const firstFrame = task && firstFrameId ? task.frames[firstFrameId] ?? null : null;
  const lastFrame = task && lastFrameId ? task.frames[lastFrameId] ?? null : null;
  const editFirstFrame = (firstFrameId ? task?.frames[firstFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.startFrameId] : null) ?? null;
  const editLastFrame = (lastFrameId ? task?.frames[lastFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.endFrameId] : null) ?? null;
  const activeEditFrame = editFrameTab === "first" ? editFirstFrame : editLastFrame;
  const activeRefineFrame = refineFrameTab === "first" ? editFirstFrame : editLastFrame;
  const activeEditVariants = useMemo(
    () =>
      [...(activeEditFrame?.variants ?? [])]
        .filter((variant) => variant.variantKind !== "refined")
        .sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
    [activeEditFrame?.variants],
  );
  const activeRefineVariants = useMemo(
    () =>
      [...(activeRefineFrame?.variants ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [activeRefineFrame?.variants],
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
  const activeRefineGroups = useMemo<RefineVariantGroup[]>(() => {
    const selectedSourceVariantId = refineSourceVariantIds[refineFrameTab];
    const editedVariants = activeRefineVariants.filter((variant) => variant.variantKind !== "refined");
    const refinedVariants = activeRefineVariants.filter((variant) => variant.variantKind === "refined" && variant.sourceVariantId);
    const refinedBySource = new Map<string, FrameVariant[]>();
    for (const variant of refinedVariants) {
      const sourceVariantId = variant.sourceVariantId;
      if (!sourceVariantId) continue;
      const bucket = refinedBySource.get(sourceVariantId) ?? [];
      bucket.push(variant);
      refinedBySource.set(sourceVariantId, bucket);
    }
    return editedVariants.map((editedVariant) => {
      const refinedChildren = [...(refinedBySource.get(editedVariant.variantId) ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      return {
        editedVariant,
        refinedVariants: refinedChildren,
        isSelectedEdited: selectedSourceVariantId === editedVariant.variantId,
        selectedRefinedVariantId:
          refinedChildren.find((variant) => variant.variantId === selectedSourceVariantId)?.variantId ?? null,
      };
    });
  }, [activeRefineVariants, refineFrameTab, refineSourceVariantIds]);
  const activeRefineFocusedEditedVariantId = useMemo(() => {
    const selectedCompareVariantId = compareVariantIds[refineFrameTab];
    if (selectedCompareVariantId && activeRefineGroups.some((group) => group.editedVariant.variantId === selectedCompareVariantId)) {
      return selectedCompareVariantId;
    }
    const selectedEditSourceVariantId = editSourceVariantIds[refineFrameTab];
    if (
      selectedEditSourceVariantId &&
      activeRefineGroups.some((group) => group.editedVariant.variantId === selectedEditSourceVariantId)
    ) {
      return selectedEditSourceVariantId;
    }
    const selectedSourceVariantId = refineSourceVariantIds[refineFrameTab];
    if (selectedSourceVariantId) {
      const group = activeRefineGroups.find(
        (item) =>
          item.editedVariant.variantId === selectedSourceVariantId ||
          item.refinedVariants.some((variant) => variant.variantId === selectedSourceVariantId),
      );
      if (group) return group.editedVariant.variantId;
    }
    return null;
  }, [activeRefineGroups, compareVariantIds, editSourceVariantIds, refineFrameTab, refineSourceVariantIds]);
  const activeFrameDimensions = useMemo(() => {
    const width = activeEditFrame?.width ?? task?.video?.editSource?.width;
    const height = activeEditFrame?.height ?? task?.video?.editSource?.height;
    if (!activeEditFrame || !width || !height) return null;
    return { width, height };
  }, [activeEditFrame, task?.video?.editSource?.height, task?.video?.editSource?.width]);
  const describeSelectedFrameSource = useCallback(
    (frameRecord: typeof editFirstFrame | typeof editLastFrame, variantId: string | null): string => {
      if (!frameRecord || !variantId) return "original frame";
      const variant = frameRecord.variants.find((item) => item.variantId === variantId);
      if (!variant) return "original frame";
      return variant.variantKind === "refined" ? "refined frame" : "edited frame";
    },
    [],
  );
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
    setSelectedSegmentId(null);
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
  }, [selectedTaskId, setSelectedSegmentId]);

  useEffect(() => {
    if (tab !== "refine") return;
    setRefineFrameTab(editFrameTab);
  }, [editFrameTab, tab]);

  useEffect(() => {
    if (!selectedTaskId || selectedSegmentId || !task?.segments?.length) return;
    const rememberedByTask = readSegmentSelectionMap();
    const rememberedSegmentId = rememberedByTask[selectedTaskId];
    if (!rememberedSegmentId) return;
    const exists = task.segments.some((segment) => segment.segmentId === rememberedSegmentId);
    if (!exists) {
      delete rememberedByTask[selectedTaskId];
      writeSegmentSelectionMap(rememberedByTask);
      return;
    }
    setSelectedSegmentId(rememberedSegmentId);
  }, [selectedSegmentId, selectedTaskId, setSelectedSegmentId, task?.segments]);

  useEffect(() => {
    if (!selectedTaskId || !selectedSegmentId) return;
    const rememberedByTask = readSegmentSelectionMap();
    if (rememberedByTask[selectedTaskId] === selectedSegmentId) return;
    rememberedByTask[selectedTaskId] = selectedSegmentId;
    writeSegmentSelectionMap(rememberedByTask);
  }, [selectedSegmentId, selectedTaskId]);

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
    setRefineSourceVariantIds((previous) => {
      const next = { ...previous };
      let changed = false;
      const resolveFrameSelection = (
        frame: typeof editFirstFrame | typeof editLastFrame,
        previousVariantId: string | null,
      ): string | null => {
        const variants = frame?.variants ?? [];
        if (previousVariantId && variants.some((variant) => variant.variantId === previousVariantId)) {
          return previousVariantId;
        }
        if (frame?.selectedVariantId && variants.some((variant) => variant.variantId === frame.selectedVariantId)) {
          return frame.selectedVariantId;
        }
        const latestRefined = variants
          .filter((variant) => variant.variantKind === "refined")
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (latestRefined?.variantId) return latestRefined.variantId;
        const latestEdited = variants
          .filter((variant) => variant.variantKind !== "refined")
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        return latestEdited?.variantId ?? null;
      };

      const firstSelection = resolveFrameSelection(editFirstFrame, previous.first);
      if (firstSelection !== previous.first) {
        next.first = firstSelection;
        changed = true;
      }
      const lastSelection = resolveFrameSelection(editLastFrame, previous.last);
      if (lastSelection !== previous.last) {
        next.last = lastSelection;
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [editFirstFrame, editLastFrame]);

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
      const created = await apiClient.createSegment(selectedTaskId, {
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
      const trimmedPrompt = lumaPrompt.trim();
      const selectedMode =
        lumaModel === "runway-gen4.5"
          ? "runway_i2v"
          : lumaModel === "kling-2.6"
            ? generationInputMode === "start_only"
              ? "kling_start_only"
              : "kling_start_end"
            : lumaModel === "kling-o1"
              ? "kling_o1_video_edit"
            : lumaModel === "kling-v3-omni-video"
              ? "kling_v3_omni_video_edit"
            : lumaModel === "seedance-2.0-reference-to-video"
              ? "seedance_reference_to_video"
            : lumaModel === "veo-3.1" || lumaModel === "veo-3.1-fast"
              ? generationInputMode === "start_only"
                ? "veo_start_only"
                : "veo_start_end"
              : lumaModel === "wan2.2-a14b"
                ? "wan_a14b_i2v"
                : lumaModel === "wan2.2-animate"
                  ? "wan_animate_replace"
                  : lumaModel === "wan2.7-videoedit"
                    ? "wan27_video_edit"
                  : advancedMode;
      return apiClient.generateSegment(selectedTaskId, selectedSegmentId, {
        lumaModel,
        mode: selectedMode,
        prompt: lumaModel === "wan2.2-animate" ? undefined : trimmedPrompt || undefined,
        firstFrameVariantId: refineSourceVariantIds.first || compareVariantIds.first || undefined,
        lastFrameVariantId: generationInputMode === "start_end" ? refineSourceVariantIds.last || compareVariantIds.last || undefined : undefined,
        replicateKlingMode: lumaModel === "kling-o1" ? replicateKlingMode : undefined,
        replicateKlingV3Mode: lumaModel === "kling-v3-omni-video" ? replicateKlingV3Mode : undefined,
        wan27Resolution: lumaModel === "wan2.7-videoedit" ? wan27Resolution : undefined,
      });
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      setTab("generate");
    },
  });

  const extendSegmentGenerationMutation = useMutation({
    mutationFn: async ({
      generationId,
      alignmentFrameIndex,
      anchorFramesFromEnd,
      durationSeconds,
      prompt,
    }: {
      generationId: string;
      alignmentFrameIndex: number;
      anchorFramesFromEnd: number;
      durationSeconds?: number;
      prompt?: string;
    }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.extendSegmentGeneration(selectedTaskId, generationId, {
        alignmentFrameIndex,
        anchorFramesFromEnd,
        durationSeconds,
        prompt,
      });
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      setSelectedSegmentId(result.segmentId);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
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

  const runMotionSyncMutation = useMutation({
    mutationFn: async ({ exportId, force }: { exportId: string; force?: boolean }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.runMotionSyncQc(selectedTaskId, exportId, { force });
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      if (selectedTaskId) {
        await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      }
    },
  });

  const runQcMutation = useMutation({
    mutationFn: async ({
      taskId,
      generationIds,
      mode,
    }: {
      taskId: string;
      generationIds?: string[];
      mode?: "standard" | "advanced_frame";
    }) =>
      apiClient.runQc(taskId, generationIds?.length || mode ? { generationIds, mode } : undefined),
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
      tests,
      outputRefs,
      name,
    }: {
      taskId: string;
      reportType: "qc_frame" | "qc_video" | "video_compare";
      tests: string[];
      outputRefs: CustomReportOutputRef[];
      name?: string;
    }) => apiClient.createCustomReport(taskId, { reportType, tests, outputRefs, name }),
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

  const taskTrackedJobIds = useMemo(() => {
    const ids: string[] = [];
    for (const generation of Object.values(task?.segmentGenerations ?? {})) {
      if (generation.jobId) ids.push(generation.jobId);
    }
    for (const report of task?.customReports ?? []) {
      if (report.jobId) ids.push(report.jobId);
    }
    for (const exportItem of task?.exports ?? []) {
      const motionJobId = exportItem.motionSyncQc?.jobId;
      if (motionJobId) ids.push(motionJobId);
    }
    return ids;
  }, [task?.customReports, task?.exports, task?.segmentGenerations]);

  const trackedJobIds = useMemo(
    () => [...new Set([...jobIds, ...taskTrackedJobIds])],
    [jobIds, taskTrackedJobIds],
  );

  const jobQueries = useQueries({
    queries: trackedJobIds.map((jobId) => ({
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
      void queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    }
    if (reportTaskId && reportTaskId !== selectedTaskId) {
      void queryClient.invalidateQueries({ queryKey: ["task", reportTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", "report", reportTaskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", "assets", reportTaskId] });
    }
    while (seenDoneRef.current.size > MAX_TRACKED_JOB_IDS * 5) {
      const oldest = seenDoneRef.current.values().next().value as string | undefined;
      if (!oldest) break;
      seenDoneRef.current.delete(oldest);
    }
  }, [jobQueries, queryClient, reportTaskId, selectedTaskId]);

  useEffect(() => {
    if (jobIds.length <= MAX_TRACKED_JOB_IDS) return;
    setJobIds((previous) => previous.slice(-MAX_TRACKED_JOB_IDS));
  }, [jobIds]);

  useEffect(() => {
    setJobIds([]);
  }, [selectedTaskId]);

  const sortedJobs = useMemo(
    () =>
      jobQueries
        .map((query) => query.data)
        .filter((job): job is NonNullable<typeof job> => Boolean(job))
        .filter((job) => !selectedTaskId || job.taskId === selectedTaskId)
        .sort(
          (a, b) =>
            new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
            new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
        ),
    [jobQueries, selectedTaskId],
  );

  const mergeFps = fpsValue(task);
  const mergeOriginalStartFrame = mergeTargetSegment?.startFrame ?? 0;
  const mergeOriginalEndFrameExclusive = mergeTargetSegment?.endFrameExclusive ?? mergeOriginalStartFrame + 1;
  const mergeOriginalDurationFrames = Math.max(1, mergeOriginalEndFrameExclusive - mergeOriginalStartFrame);
  const mergeProviderDurationSec =
    asNumber(mergeTargetGeneration?.generationSettings?.storedOutput?.durationSec) ??
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
  const lumaHardLimit = useMemo(() => {
    const constraints = videoModelDurationConstraints(lumaModel);
    return {
      maxSeconds: constraints.maxSeconds,
      maxFrames: Math.round(constraints.maxSeconds * (constraints.frameBudgetFps ?? fpsValue(task))),
    };
  }, [lumaModel, task]);
  const hasHardDurationLimit = Boolean(lumaHardLimit);
  const lumaHardLimitSeconds = lumaHardLimit?.maxSeconds ?? 0;
  const lumaHardLimitFrames = lumaHardLimit?.maxFrames ?? 0;
  const timelineDelta = useMemo(() => {
    const fps = fpsValue(task);
    const anchorA = firstFrame?.frameIndex ?? lastFrame?.frameIndex ?? null;
    const anchorB = firstFrame?.frameIndex != null && lastFrame?.frameIndex != null ? lastFrame.frameIndex : currentFrameIndex;
    if (anchorA == null) {
      return { frames: 0, seconds: 0, overLimit: false };
    }
    const frames = Math.abs(anchorB - anchorA);
    const seconds = frames / fps;
    return { frames, seconds, overLimit: false };
  }, [currentFrameIndex, firstFrame, lastFrame, task]);

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
      overLimit: false,
      limitMessage: null,
    };
  }, [firstFrame, lastFrame, task]);

  const selectedSegmentLimit = useMemo(() => {
    if (!selectedSegment) return null;
    return assessVideoModelDurationLimit(lumaModel, selectedSegment.durationFrames, selectedSegment.durationSec, fpsValue(task));
  }, [lumaModel, selectedSegment, task]);
  const selectedSegmentOverLimit = Boolean(selectedSegmentLimit?.overLimit);
  const selectedSegmentLimitMessage = selectedSegmentLimit?.message ?? null;
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
    if (lumaModel === "kling-o1") {
      return "Uses the selected segment video as <<<video_1>>> and the selected edited start frame as <<<image_1>>>. Prompt must reference both.";
    }
    if (lumaModel === "kling-v3-omni-video") {
      return "Uses the selected segment video as <<<video_1>>> and the selected edited start frame as <<<image_1>>> for base video editing. Prompt must reference both.";
    }
    if (lumaModel === "seedance-2.0-reference-to-video") {
      return "Uses the selected segment video as @Video1 and the selected edited start frame as @Image1. Prompt must reference both. The segment is conformed to Seedance's smaller reference-video bounds, then the result is upscaled back to the segment size.";
    }
    if (lumaModel === "wan2.7-videoedit") {
      return "Uses the selected segment video plus the selected edited start frame as reference_image. Prompt should describe only the intended edit.";
    }
    if (lumaModel === "wan2.2-a14b" || lumaModel === "runway-gen4.5") {
      return "Start frame variant is taken automatically from your Edit frames selection.";
    }
    if (lumaModel === "wan2.2-animate") {
      return "Wan2.2 Animate uses start frame + source segment video. Text prompt is disabled in this flow unless LoRA inputs are used.";
    }
    if (generationInputMode === "start_only" && (lumaModel === "kling-2.6" || lumaModel === "veo-3.1" || lumaModel === "veo-3.1-fast")) {
      return "Start frame only is enforced in this tab; the end frame is not sent.";
    }
    return "Start and end frame variants are taken automatically from your Edit frames selections.";
  }, [generationInputMode, lumaModel]);
  const generationPromptPlaceholder = useMemo(() => {
    if (lumaModel === "kling-o1" || lumaModel === "kling-v3-omni-video") {
      return "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. Keep motion, camera movement and background the same.";
    }
    if (lumaModel === "seedance-2.0-reference-to-video") {
      return "Transform the horse in @Video1 into the unicorn in @Image1. Keep the motion, camera movement and background the same.";
    }
    if (lumaModel === "wan2.7-videoedit") {
      return "Change the horse into the white unicorn, keep the background and motion the same.";
    }
    return "Optional generation prompt";
  }, [lumaModel]);
  const generationPromptError = useMemo(() => {
    const promptValue = lumaPrompt.trim();
    if (lumaModel === "wan2.2-animate") return null;
    if (lumaModel === "kling-o1" || lumaModel === "kling-v3-omni-video") {
      if (!promptValue) return `${videoModelLabel(lumaModel)} requires a prompt that references both <<<video_1>>> and <<<image_1>>>.`;
      const missing: string[] = [];
      if (!promptValue.includes("<<<video_1>>>")) missing.push("<<<video_1>>>");
      if (!promptValue.includes("<<<image_1>>>")) missing.push("<<<image_1>>>");
      if (missing.length) return `${videoModelLabel(lumaModel)} prompt must include ${missing.join(" and ")}.`;
      return null;
    }
    if (lumaModel === "seedance-2.0-reference-to-video") {
      if (!promptValue) return "Seedance 2.0 Reference to Video requires a prompt that references both @Video1 and @Image1.";
      const missing: string[] = [];
      if (!promptValue.includes("@Video1")) missing.push("@Video1");
      if (!promptValue.includes("@Image1")) missing.push("@Image1");
      if (missing.length) return `Seedance 2.0 Reference to Video prompt must include ${missing.join(" and ")}.`;
      return null;
    }
    if (lumaModel === "wan2.7-videoedit" && !promptValue) {
      return "Wan 2.7 VideoEdit requires a prompt describing the change you want to make.";
    }
    return null;
  }, [lumaModel, lumaPrompt]);

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
  const originalSegmentPreviewIdentity = useMemo(() => {
    if (selectedSegment?.segmentClipKey) return `segment:${selectedSegment.segmentClipKey}`;
    if (!task?.video?.editSource?.s3Key || !segmentWindow) return null;
    return `edit:${task.video.editSource.s3Key}:${segmentWindow.startSec.toFixed(3)}:${segmentWindow.endSec.toFixed(3)}`;
  }, [selectedSegment?.segmentClipKey, segmentWindow, task?.video?.editSource?.s3Key]);
  const originalPreviewIsSegmentClip = Boolean(selectedSegment?.segmentClipUrl);
  const [stableOriginalSegmentPreviewUrl, setStableOriginalSegmentPreviewUrl] = useState<string | null>(null);
  const stableOriginalSegmentPreviewIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!originalSegmentPreviewUrl || !originalSegmentPreviewIdentity) {
      stableOriginalSegmentPreviewIdentityRef.current = null;
      setStableOriginalSegmentPreviewUrl(null);
      return;
    }
    if (
      stableOriginalSegmentPreviewIdentityRef.current !== originalSegmentPreviewIdentity ||
      !stableOriginalSegmentPreviewUrl
    ) {
      stableOriginalSegmentPreviewIdentityRef.current = originalSegmentPreviewIdentity;
      setStableOriginalSegmentPreviewUrl(originalSegmentPreviewUrl);
    }
  }, [originalSegmentPreviewIdentity, originalSegmentPreviewUrl, stableOriginalSegmentPreviewUrl]);
  const generatedSegmentPreviewIdentity = useMemo(() => {
    if (!selectedPreviewGeneration) return null;
    return selectedPreviewGeneration.outputKey || selectedPreviewGeneration.genId;
  }, [selectedPreviewGeneration]);
  const generatedSegmentPreviewUrl = selectedPreviewGeneration?.downloadUrl ?? null;
  const generatedSegmentPreviewPosterUrl = useMemo(
    () => (selectedPreviewGeneration ? generationThumbnailUrl(selectedPreviewGeneration) : null),
    [selectedPreviewGeneration],
  );
  const [stableGeneratedSegmentPreviewUrl, setStableGeneratedSegmentPreviewUrl] = useState<string | null>(null);
  const [stableGeneratedSegmentPreviewPosterUrl, setStableGeneratedSegmentPreviewPosterUrl] = useState<string | null>(null);
  const stableGeneratedSegmentPreviewIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!generatedSegmentPreviewIdentity || !generatedSegmentPreviewUrl) {
      stableGeneratedSegmentPreviewIdentityRef.current = null;
      setStableGeneratedSegmentPreviewUrl(null);
      setStableGeneratedSegmentPreviewPosterUrl(null);
      return;
    }
    if (
      stableGeneratedSegmentPreviewIdentityRef.current !== generatedSegmentPreviewIdentity ||
      !stableGeneratedSegmentPreviewUrl
    ) {
      stableGeneratedSegmentPreviewIdentityRef.current = generatedSegmentPreviewIdentity;
      setStableGeneratedSegmentPreviewUrl(generatedSegmentPreviewUrl);
      setStableGeneratedSegmentPreviewPosterUrl(generatedSegmentPreviewPosterUrl);
    }
  }, [
    generatedSegmentPreviewIdentity,
    generatedSegmentPreviewPosterUrl,
    generatedSegmentPreviewUrl,
    stableGeneratedSegmentPreviewUrl,
  ]);
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

  const syncOriginalToGenerated = useCallback((generatedVideo: HTMLVideoElement) => {
    const originalVideo = compareOriginalRef.current;
    if (!originalVideo || !segmentWindow) return;
    const targetTime = originalPreviewIsSegmentClip ? generatedVideo.currentTime : segmentWindow.startSec + generatedVideo.currentTime;
    if (syncLockRef.current) return;
    if (originalVideo.readyState < 2) return;
    syncLockRef.current = true;
    if (Math.abs(originalVideo.currentTime - targetTime) > 0.18) {
      originalVideo.currentTime = targetTime;
    }
    window.setTimeout(() => {
      syncLockRef.current = false;
    }, 0);
  }, [originalPreviewIsSegmentClip, segmentWindow]);

  const keepOriginalWithinSegment = useCallback((video: HTMLVideoElement) => {
    if (!segmentWindow) return;
    if (originalPreviewIsSegmentClip) {
      if (video.currentTime < 0) {
        video.currentTime = 0;
        return;
      }
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const maxTime = Math.max(0, video.duration - 0.001);
        if (video.currentTime > maxTime) {
          video.currentTime = maxTime;
        }
      }
      return;
    }
    if (video.currentTime < segmentWindow.startSec) {
      video.currentTime = segmentWindow.startSec;
    }
    if (video.currentTime >= segmentWindow.endSec) {
      video.currentTime = segmentWindow.startSec;
    }
  }, [originalPreviewIsSegmentClip, segmentWindow]);

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
    if (modelName === "kling-o1") {
      return {
        title: "Kling O1 Edit",
        lines: [
          "Uses the selected segment video as the base edit input and the selected edited first frame as a reference image.",
          "Prompt must include both <<<video_1>>> and <<<image_1>>> so the model knows which video and reference image to use.",
          'Example prompt: "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. keep motions, camera movement and background the same".',
        ],
      };
    }
    if (modelName === "kling-v3-omni-video") {
      return {
        title: "Kling v3 Omni Video",
        lines: [
          "Uses the selected segment video as the base edit input and the selected edited first frame as a reference image.",
          "Prompt must include both <<<video_1>>> and <<<image_1>>> so the model knows which video and reference image to use.",
          'Example prompt: "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. keep motions, camera movement and background the same".',
        ],
      };
    }
    if (modelName === "seedance-2.0-reference-to-video") {
      return {
        title: "Seedance 2.0 Reference to Video",
        lines: [
          "Uses the selected segment video as the motion reference and the selected edited first frame as the image reference.",
          "Prompt must include both @Video1 and @Image1 so Seedance knows which uploaded video and image to follow.",
          "The source clip is conformed into Seedance's smaller reference-video bounds, then the generated result is upscaled back to the segment size for the rest of the app.",
          "Limitation: Fal/Seedance may reject clips or reference frames that appear to contain real-person likenesses or private information; this app cannot disable that provider moderation check.",
          'Example prompt: "Transform the horse in @Video1 into the unicorn in @Image1. Keep the motion, camera movement and background the same."',
        ],
      };
    }
    if (modelName === "wan2.7-videoedit") {
      return {
        title: "Wan 2.7 VideoEdit",
        lines: [
          "Uses the selected segment video for motion and structure, with the selected edited first frame sent as reference_image.",
          "720p is faster. 1080p is slower but can preserve more detail on cleaner source clips.",
          'Example prompt: "Change the horse into the white unicorn, keep the background and motion the same".',
        ],
      };
    }
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

  async function deleteCustomReport(taskId: string, report: CustomReportRecord) {
    const ok = window.confirm(`Delete custom report "${report.name}"?`);
    if (!ok) return;
    try {
      await deleteCustomReportMutation.mutateAsync({ taskId, reportId: report.reportId });
      if (activeCustomReportId === report.reportId) {
        goToReport(taskId, "reports", null, true);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to delete report.");
    }
  }

  function openCustomReport(taskId: string, report: CustomReportRecord) {
    goToReport(taskId, "reports", report.reportId);
  }

  function openTaskReport(taskId: string) {
    goToReport(taskId, "frames", null);
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

  useEffect(() => {
    if (!isPageVisible) return;
    const hiddenAt = pageHiddenAtRef.current;
    if (hiddenAt && Date.now() - hiddenAt < URL_REFRESH_IDLE_MS) return;
    refreshSignedUrlsForTask(selectedTaskId);
    if (reportTaskId && reportTaskId !== selectedTaskId) {
      refreshSignedUrlsForTask(reportTaskId);
    }
  }, [isPageVisible, refreshSignedUrlsForTask, reportTaskId, selectedTaskId]);

  useEffect(() => {
    if (isPageVisible) {
      return;
    }
    pageHiddenAtRef.current = Date.now();
  }, [isPageVisible]);

  const openNewTaskWithAutomationDefaults = useCallback(() => {
    setAutomationEnabled(false);
    setAutomationStartPrompt("");
    setAutomationEndPrompt("");
    setAutomationVideoPrompt("");
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
      logs: [...previous.logs, formatAutomationLogEntry("User requested automation cancel.")].slice(-200),
    }));
  }, []);

  const appendAutomationLog = useCallback((message: string) => {
    setAutomationRunState((previous) => ({
      ...previous,
      logs: [...previous.logs, formatAutomationLogEntry(message)].slice(-200),
    }));
  }, []);

  const waitForAutomationJob = useCallback(
    async (jobId: string, label: string, timeoutMs = 25 * 60 * 1000) => {
      const startedAt = Date.now();
      let lastStatus = "";
      while (true) {
        if (automationCancelRef.current) {
          throw new Error(AUTOMATION_CANCELLED);
        }
        const job = await apiClient.getJob(jobId);
        const statusLine = `${job.status.toUpperCase()} (${job.progress ?? 0}%)`;
        if (statusLine !== lastStatus) {
          appendAutomationLog(`${label}: ${statusLine}`);
          lastStatus = statusLine;
        }
        setAutomationRunState((previous) =>
          previous.isOpen
            ? { ...previous, phase: label, detail: statusLine }
            : previous,
        );
        if (job.status === "complete") {
          appendAutomationLog(`${label}: completed`);
          return job;
        }
        if (job.status === "failed") {
          const errorMessage = job.error || `${label} failed`;
          appendAutomationLog(`${label}: failed - ${errorMessage}`);
          throw new Error(errorMessage);
        }
        if (Date.now() - startedAt > timeoutMs) {
          appendAutomationLog(`${label}: timed out`);
          throw new Error(`${label} timed out`);
        }
        await sleep(2000);
      }
    },
    [appendAutomationLog],
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
      videoPrompt,
      selectedVideoOptions,
    }: {
      taskId: string;
      startPrompt: string;
      endPrompt: string;
      videoPrompt: string;
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
          logs: [
            formatAutomationLogEntry("Automation started."),
            formatAutomationLogEntry(
              `Selected video model runs: ${selectedVideoOptions.length ? selectedVideoOptions.map((option) => option.label).join(" | ") : "none"}`,
            ),
          ],
        });

      const imageModels: Array<{ model: "nano_banana_pro" | "chatgpt"; label: string }> = [
        { model: "nano_banana_pro", label: "Nano Banana Pro" },
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
          const variants: Array<{ variantId: string; model: string }> = [];
          const maxAttemptsPerModel = 3;
          for (let index = 0; index < imageModels.length; index += 1) {
            throwIfCancelled();
            const modelEntry = imageModels[index];
            let modelSucceeded = false;
            for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
              throwIfCancelled();
              setAutomationRunState((previous) => ({
                ...previous,
                phase: `Editing ${frameLabel} frame`,
                detail: `Queueing ${modelEntry.label} (${index + 1}/${imageModels.length}) attempt ${attempt}/${maxAttemptsPerModel}...`,
              }));
              try {
                const created = await apiClient.fullEdit(taskId, frameId, {
                  model: modelEntry.model,
                  prompt: promptValue,
                  sourceVariantId: "original",
                });
                setJobIds((previous) => appendTrackedJobId(previous, created.jobId));
                appendAutomationLog(`Queued ${frameLabel} frame edit: ${modelEntry.label} (job ${created.jobId}).`);
                const completed = await waitForAutomationJob(
                  created.jobId,
                  `Editing ${frameLabel} frame (${modelEntry.model})`,
                );
                const variantId = completed.resultRefs?.variantId;
                if (typeof variantId === "string" && variantId) {
                  variants.push({ variantId, model: modelEntry.model });
                  appendAutomationLog(`Produced ${frameLabel} frame variant ${variantId} (${modelEntry.model}).`);
                } else {
                  appendAutomationLog(`Completed ${frameLabel} frame edit (${modelEntry.model}) but no variantId was returned.`);
                }
                modelSucceeded = true;
                break;
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                const retryable = /(429|too many|rate|throttl|timeout|temporar|5\d\d)/i.test(reason);
                if (attempt < maxAttemptsPerModel && retryable && reason !== AUTOMATION_CANCELLED) {
                  const backoffMs = 1500 * attempt;
                  appendAutomationLog(
                    `${modelEntry.label} ${frameLabel} edit failed (attempt ${attempt}): ${reason}. Retrying in ${(
                      backoffMs / 1000
                    ).toFixed(1)}s.`,
                  );
                  await sleep(backoffMs);
                  continue;
                }
                appendAutomationLog(`Failed ${frameLabel} frame edit (${modelEntry.model}): ${reason}`);
                break;
              }
            }
            if (index < imageModels.length - 1) {
              await sleep(750);
            }
            if (!modelSucceeded) {
              setAutomationRunState((previous) => ({
                ...previous,
                phase: `Editing ${frameLabel} frame`,
                detail: `${modelEntry.label} did not produce a variant. Continuing...`,
              }));
            }
          }
          return variants;
        };

        const trimmedEndPrompt = endPrompt.trim();
        if (!trimmedEndPrompt) {
          appendAutomationLog("No end-frame prompt provided, skipping end-frame model edits.");
        }
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

        setAutomationRunState((previous) => ({
          ...previous,
          isOpen: true,
          taskId,
          phase: "Video generation",
          detail: "Queueing model runs...",
          cancelRequested: false,
          terminal: false,
          logs: [...previous.logs, formatAutomationLogEntry("Frame selection confirmed. Starting video generation queue.")].slice(-200),
        }));

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
        setRefineSourceVariantIds({
          first: choice.startVariantId,
          last: choice.endVariantId,
        });

        const generationJobs: Array<{ option: AutomationVideoRunOption; jobId: string }> = [];
        const queueFailures: string[] = [];
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
              prompt: videoPrompt || undefined,
              firstFrameVariantId: choice.startVariantId,
              lastFrameVariantId: option.inputMode === "start_end" ? choice.endVariantId ?? undefined : undefined,
            });
            generationJobs.push({ option, jobId: created.jobId });
            setJobIds((previous) => appendTrackedJobId(previous, created.jobId));
            appendAutomationLog(`Queued ${option.label} (job ${created.jobId}).`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown generation queue error";
            queueFailures.push(`${option.label}: ${message}`);
            setAutomationRunState((previous) => ({
              ...previous,
              detail: `Failed to queue ${option.label}: ${message}`,
            }));
            appendAutomationLog(`Failed to queue ${option.label}: ${message}`);
          }
        }

        if (!generationJobs.length) {
          throw new Error("No automated video generations were queued.");
        }

        const generationResults = await Promise.allSettled(
          generationJobs.map((entry) => waitForAutomationJob(entry.jobId, `Generating ${entry.option.label}`, 35 * 60 * 1000)),
        );
        throwIfCancelled();
        const failedRuns: string[] = [...queueFailures];
        const fulfilledGenerationIds: Array<{ option: AutomationVideoRunOption; genId: string }> = [];
        generationResults.forEach((result, index) => {
          if (result.status === "fulfilled") {
            const genId = result.value.resultRefs?.genId;
            if (typeof genId === "string" && genId) {
              fulfilledGenerationIds.push({ option: generationJobs[index].option, genId });
            } else {
              const noGenMessage = `${generationJobs[index].option.label}: job completed but no generation ID was returned`;
              failedRuns.push(noGenMessage);
              appendAutomationLog(`Generation verification failed for ${noGenMessage}`);
            }
            return;
          }
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          failedRuns.push(`${generationJobs[index].option.label}: ${reason}`);
          appendAutomationLog(`Generation failed for ${generationJobs[index].option.label}: ${reason}`);
        });

        await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "report", taskId] });
        const refreshedTask = await apiClient.getTask(taskId);
        const confirmedSuccesses = fulfilledGenerationIds.filter((entry) => {
          const generation = refreshedTask.segmentGenerations?.[entry.genId];
          const valid = Boolean(generation && generation.status === "complete" && generation.outputKey);
          if (!valid) {
            const reason = `${entry.option.label}: job completed but output asset is missing`;
            failedRuns.push(reason);
            appendAutomationLog(`Generation verification failed for ${reason}`);
          }
          return valid;
        });
        const succeededCount = confirmedSuccesses.length;
        if (!succeededCount) {
          throw new Error(
            failedRuns.length
              ? `All automated video generations failed. ${failedRuns.join(" | ")}`
              : "All automated video generations failed.",
          );
        }

        setSelectedTaskId(taskId);
        setSelectedSegmentId(segment.segmentId);
        goToReport(taskId, "reports", null, true);
        setAutomationRunState((previous) => ({
          ...previous,
          isOpen: true,
          taskId,
          phase: "Completed",
          detail:
            failedRuns.length > 0
              ? `Automation complete. ${succeededCount} of ${selectedVideoOptions.length} selected model runs produced saved outputs.`
              : `Automation complete. ${succeededCount} of ${generationJobs.length} video generations succeeded.`,
          cancelRequested: false,
          terminal: true,
          logs: [
            ...previous.logs,
            ...failedRuns.map((item) => formatAutomationLogEntry(`Model failed: ${item}`)),
            formatAutomationLogEntry(`Automation completed with ${succeededCount} successful video generations.`),
          ].slice(-200),
        }));
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
          logs: [...previous.logs, formatAutomationLogEntry(cancelled ? "Automation cancelled." : `Automation failed: ${message}`)].slice(-200),
        }));
      }
    },
    [
      appendAutomationLog,
      fpsValue,
      goToReport,
      queryClient,
      requestAutomationSelection,
      setSelectedFrameId,
      setSelectedSegmentId,
      setSelectedTaskId,
      setTab,
      waitForAutomationJob,
    ],
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
    const videoPrompt = automationVideoPrompt.trim();
    const selectedVideoOptions = [...selectedAutomationVideoOptions];
    void handleCreateTaskWithUpload(
      automationEnabled
        ? {
            onIngestComplete: async (taskId) => {
              await runAutomatedPipeline({ taskId, startPrompt, endPrompt, videoPrompt, selectedVideoOptions });
            },
          }
        : undefined,
    );
  }, [
    automationEnabled,
    automationEndPrompt,
    automationStartPrompt,
    automationVideoPrompt,
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
    await taskQuery.refetch();
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
    if (tab === "timeline" && nextTab !== "timeline" && nextTab !== "report" && nextTab !== "custom_qc" && nextTab !== "api_logs") {
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

  function selectRefineSourceVariant(tabKey: "first" | "last", variantId: string) {
    setRefineSourceVariantIds((previous) => ({ ...previous, [tabKey]: variantId }));
  }

  function openQualityMatchForVariant(frameRecord: typeof activeEditFrame, variantId: string) {
    if (!frameRecord) return;
    const fullFrameRecord = task?.frames?.[frameRecord.frameId];
    if (!fullFrameRecord) return;
    const variantRecord = fullFrameRecord.variants.find((variant) => variant.variantId === variantId);
    if (!variantRecord?.imageUrl) return;
    setQualityMatchModal({
      isOpen: true,
      frameId: fullFrameRecord.frameId,
      variantId,
      variantLabel: `${variantRecord.model} / ${variantRecord.type} · frame ${fullFrameRecord.frameIndex} (${fullFrameRecord.timecode})`,
      originalFrameUrl: fullFrameRecord.imageUrl ?? null,
      generatedFrameUrl: variantRecord.imageUrl,
      alreadyReviewed: Boolean(variantRecord?.qualityMatch?.analysisId),
    });
  }

  function openVideoCleanupModalForGeneration(generation: SegmentGeneration) {
    setVideoCleanupModal({
      isOpen: true,
      generationId: generation.genId,
    });
  }

  const openMotionSyncModal = useCallback((exportId: string) => {
    setMotionSyncModalExportId(exportId);
  }, []);

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
    { id: "timeline", label: "Select Frames" },
    { id: "frames", label: "Edit frames" },
    { id: "refine", label: "Refine Frames" },
    { id: "generate", label: "Generate Video" },
    { id: "merge", label: "Merge Video" },
    { id: "assets", label: "Download Assets" },
  ];

  function renderCustomReportBox(taskId: string | null, reports: CustomReportRecord[] | undefined) {
    return (
      <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold">QC Reports</h3>
            <p className="text-xs text-ink/60">Report creation now lives on the Reports page.</p>
          </div>
          <button
            type="button"
            className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!taskId}
            onClick={() => taskId && goToReport(taskId, "frames", null)}
          >
            Open Reports
          </button>
        </div>
        {customReportNotice ? <p className="text-xs text-ink/70">{customReportNotice}</p> : null}
        {!reports?.length ? (
          <p className="text-sm text-ink/60">No custom reports yet.</p>
        ) : (
          <div className="space-y-2">
            {reports.map((report) => (
              <div key={report.reportId} className="flex items-center justify-between rounded border border-ink/10 bg-white p-2 text-sm">
                <a
                  className="text-left text-ink underline"
                  href={taskId ? `${taskRoute(taskId, "report")}?view=reports&reportId=${encodeURIComponent(report.reportId)}` : "#"}
                  onClick={(event) => {
                    event.preventDefault();
                    if (taskId) {
                      openCustomReport(taskId, report);
                    }
                  }}
                >
                  {report.name} ({report.reportType === "qc_frame" ? "QC Frame" : report.reportType === "video_compare" ? "Video Compare" : "QC Video"}) - {report.status}
                </a>
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
      refreshPatchOverlay: () => renderPatchOverlay(),
      formatCompactTimestamp,
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
      renderPatchOverlay,
    ],
  );

  const refineFramesTabCtx = useMemo<RefineFramesTabCtx>(
    () => ({
      refineFrameTab,
      setRefineFrameTab,
      activeRefineFrame,
      refineGroups: activeRefineGroups,
      focusedEditedVariantId: activeRefineFocusedEditedVariantId,
      selectedSourceVariantId: refineSourceVariantIds[refineFrameTab],
      openRefineModalForVariant: (variant) => openQualityMatchForVariant(activeRefineFrame, variant.variantId),
      selectRefineSourceVariant: (variantId) => selectRefineSourceVariant(refineFrameTab, variantId),
      setImagePreviewModal,
      formatCompactTimestamp,
      selectedTaskId,
      refreshTask: async () => {
        if (selectedTaskId) {
          await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
        }
      },
      handleDeleteAsset,
    }),
    [
      activeRefineFrame,
      activeRefineFocusedEditedVariantId,
      activeRefineGroups,
      formatCompactTimestamp,
      handleDeleteAsset,
      queryClient,
      refineFrameTab,
      refineSourceVariantIds,
      selectedTaskId,
      setImagePreviewModal,
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
      selectedStartSourceLabel: describeSelectedFrameSource(editFirstFrame, refineSourceVariantIds.first || compareVariantIds.first),
      selectedEndSourceLabel:
        generationInputMode === "start_end"
          ? describeSelectedFrameSource(editLastFrame, refineSourceVariantIds.last || compareVariantIds.last)
          : null,
      setGenerationModelByInput,
      generationModelOptions,
      advancedMode,
      setAdvancedMode,
      replicateKlingMode,
      setReplicateKlingMode,
      replicateKlingV3Mode,
      setReplicateKlingV3Mode,
      wan27Resolution,
      setWan27Resolution,
      lumaPrompt,
      setLumaPrompt,
      generationPromptPlaceholder,
      generationPromptError,
      generationInputNote,
      generationHelp,
      selectedSegmentOverLimit,
      lumaHardLimitSeconds,
      selectedSegmentLimitMessage,
      selectedSegmentId,
      generateSegmentMutation,
      segmentWindow,
      originalSegmentPreviewUrl: stableOriginalSegmentPreviewUrl,
      generatedSegmentPreviewUrl: stableGeneratedSegmentPreviewUrl,
      generatedSegmentPreviewPosterUrl: stableGeneratedSegmentPreviewPosterUrl,
      selectedPreviewGeneration,
      task,
      compareOriginalRef,
      keepOriginalWithinSegment,
      compareVariantRef,
      syncOriginalToGenerated,
      originalPreviewIsSegmentClip,
      selectedSegmentGenerations,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      generationCardsVisible,
      truncateIdentifier,
      selectSegmentGeneration,
      describeGeneration,
      generationThumbnailUrl,
      formatCompactTimestamp,
      setVideoPreviewModal,
      openVideoCleanupModal: openVideoCleanupModalForGeneration,
      onAssetError: () => refreshSignedUrlsForTask(selectedTaskId),
      handleDeleteAsset,
      setGenerationCardsVisible,
    }),
    [
      generationModelByInput,
      generationInputMode,
      selectedSegment,
      lumaModel,
      describeSelectedFrameSource,
      editFirstFrame,
      editLastFrame,
      refineSourceVariantIds,
      compareVariantIds,
      generationModelOptions,
      advancedMode,
      replicateKlingMode,
      replicateKlingV3Mode,
      wan27Resolution,
      lumaPrompt,
      generationPromptPlaceholder,
      generationPromptError,
      generationInputNote,
      generationHelp,
      selectedSegmentOverLimit,
      lumaHardLimitSeconds,
      selectedSegmentLimitMessage,
      selectedSegmentId,
      generateSegmentMutation,
      segmentWindow,
      stableOriginalSegmentPreviewUrl,
      stableGeneratedSegmentPreviewUrl,
      stableGeneratedSegmentPreviewPosterUrl,
      selectedPreviewGeneration,
      task,
      originalPreviewIsSegmentClip,
      selectedSegmentGenerations,
      selectedReportOutputs,
      generationCardsVisible,
      selectSegmentGeneration,
      openVideoCleanupModalForGeneration,
      selectedTaskId,
      refreshSignedUrlsForTask,
      handleDeleteAsset,
    ],
  );

  const mergeTabCtx = useMemo<MergeTabCtx>(
    () => ({
      mergeTargetGeneration,
      mergeTargetSegment,
      completeGenerations,
      describeGeneration,
      describeSegment,
      getSegmentForGeneration,
      sourceFrameCount: task?.video?.editSource?.frameCount ?? 0,
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
      extendGeneration: extendSegmentGenerationMutation.mutate,
      isExtendingGeneration: extendSegmentGenerationMutation.isPending,
      extendGenerationError:
        extendSegmentGenerationMutation.error instanceof Error ? extendSegmentGenerationMutation.error.message : null,
      sortedExports,
      humanizeFilename,
      keyBasenameFromS3Key,
      formatCompactTimestamp,
      openMotionSyncModal,
    }),
    [
      mergeTargetGeneration,
      mergeTargetSegment,
      completeGenerations,
      getSegmentForGeneration,
      task?.video?.editSource?.frameCount,
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
      extendSegmentGenerationMutation.mutate,
      extendSegmentGenerationMutation.isPending,
      extendSegmentGenerationMutation.error,
      sortedExports,
      openMotionSyncModal,
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
      <>
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
              createCustomReportMutation,
              deleteCustomReportMutation,
              toggleCustomReportOutput,
              setVideoPreviewModal,
              setImagePreviewModal,
              formatCompactTimestamp,
              asNumber,
              describeSegment,
              setReportGraphModal,
            }}
          />
        </Suspense>
        <PreviewModals
          imagePreview={imagePreviewModal}
          videoPreview={videoPreviewModal}
          onCloseImage={() => setImagePreviewModal(null)}
          onCloseVideo={() => setVideoPreviewModal(null)}
          onMediaError={() => refreshSignedUrlsForTask(reportTaskId ?? selectedTaskId)}
        />
      </>
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
          onOpenCustomQc={() => {
            void handleTabChange("custom_qc");
          }}
          onOpenApiLogs={() => {
            void handleTabChange("api_logs");
          }}
        />

        <section className="col-span-12 space-y-4 md:col-span-10">
          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            {tab !== "custom_qc" && tab !== "api_logs" ? (
              <WorkflowTabs
                tabs={tabs}
                activeTab={tab}
                onSelect={(tabId) => {
                  void handleTabChange(tabId);
                }}
              />
            ) : null}

            {tab === "timeline" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Select Frames...</p>}>
                <PickFrameTab ctx={pickFrameTabCtx} />
              </Suspense>
            )}

            {tab === "frames" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Edit frames...</p>}>
                <EditFrameTab ctx={editFrameTabCtx} />
              </Suspense>
            )}

            {tab === "refine" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Refine Frames...</p>}>
                <RefineFramesTab ctx={refineFramesTabCtx} />
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

            {tab === "custom_qc" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Custom QC...</p>}>
                <CustomQcPage
                  task={task}
                  taskId={selectedTaskId}
                  taskQuery={taskQuery}
                  createCustomReportMutation={createCustomReportMutation}
                  deleteCustomReportMutation={deleteCustomReportMutation}
                  openReport={(taskId, reportId) => goToReport(taskId, "reports", reportId)}
                  formatAssetDate={formatAssetDate}
                />
              </Suspense>
            )}

            {tab === "api_logs" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading API logs...</p>}>
                <ApiLogsPage />
              </Suspense>
            )}
          </div>

          {tab !== "api_logs" ? (
            <Suspense fallback={<div className="rounded-2xl border border-ink/10 bg-card p-4 text-sm text-ink/60">Loading jobs...</div>}>
              <JobsPanel ctx={jobsPanelCtx} />
            </Suspense>
          ) : null}
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
          <div className="w-full max-w-2xl rounded-2xl border border-ink/15 bg-card p-5 shadow-xl">
            <h3 className="text-lg font-semibold">{automationRunState.phase || "Running automation"}</h3>
            <p className="mt-2 text-sm text-ink/75">{automationRunState.detail || "Working..."}</p>
            <div className="mt-3 rounded-lg border border-ink/10 bg-white/80 p-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Automation log</p>
              <div className="mt-2 max-h-52 space-y-1 overflow-y-auto rounded border border-ink/10 bg-bg/60 p-2">
                {automationRunState.logs.length ? (
                  automationRunState.logs.map((entry, index) => (
                    <p key={`automation-log-${index}`} className="font-mono text-[11px] text-ink/80">
                      {entry}
                    </p>
                  ))
                ) : (
                  <p className="text-xs text-ink/50">No events logged yet.</p>
                )}
              </div>
            </div>
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
      <MotionSyncModal
        isOpen={Boolean(motionSyncModalExportId && selectedMotionSyncExport)}
        exportRecord={selectedMotionSyncExport}
        isRunPending={runMotionSyncMutation.isPending}
        onClose={() => setMotionSyncModalExportId(null)}
        onRun={(exportId) => runMotionSyncMutation.mutate({ exportId })}
      />
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
        onApplied={(result) => {
          setQualityMatchModal((previous) => ({
            ...previous,
            isOpen: false,
          }));
          if (selectedTaskId) {
            setTab("refine", selectedTaskId);
          }
          if (result?.frameId && result?.variantId) {
            const frameId = result.frameId;
            if (editFirstFrame?.frameId === frameId) {
              setRefineFrameTab("first");
              setRefineSourceVariantIds((previous) => ({ ...previous, first: result.variantId ?? previous.first }));
            }
            if (editLastFrame?.frameId === frameId) {
              setRefineFrameTab((current) => (editFirstFrame?.frameId === frameId ? current : "last"));
              setRefineSourceVariantIds((previous) => ({ ...previous, last: result.variantId ?? previous.last }));
            }
          }
          if (selectedTaskId) {
            void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
            void queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
            void queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
          }
        }}
      />
      <VideoCleanupModal
        isOpen={videoCleanupModal.isOpen && Boolean(activeVideoCleanupGeneration)}
        task={task}
        generation={activeVideoCleanupGeneration}
        onClose={() =>
          setVideoCleanupModal({
            isOpen: false,
            generationId: null,
          })
        }
        onTrackJobId={(jobId) => setJobIds((previous) => appendTrackedJobId(previous, jobId))}
        refreshTask={async () => {
          if (!selectedTaskId) return;
          await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
          await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
          await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
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
        automationVideoPrompt={automationVideoPrompt}
        automationVideoOptions={automationVideoOptions}
        automationSelectedVideoOptionIds={automationSelectedVideoOptionIds}
        onClose={() => {
          setAutomationUiError(null);
          setIsNewTaskModalOpen(false);
        }}
        onTaskNameChange={setNewTaskName}
        onFileSelect={handleNewTaskFileSelect}
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
        onAutomationVideoPromptChange={setAutomationVideoPrompt}
        onAutomationVideoSelectionChange={(selectedIds) => {
          setAutomationSelectedVideoOptionIds(selectedIds);
          if (automationUiError) setAutomationUiError(null);
        }}
        onSubmit={handleNewTaskSubmit}
      />
    </main>
  );
}

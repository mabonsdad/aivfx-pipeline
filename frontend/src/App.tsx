import { Suspense, lazy, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import { apiClient } from "./api/client";
import VideoCleanupModal from "./components/cleanup/VideoCleanupModal";
import PreviewModals from "./components/layout/PreviewModals";
import { StatusNotice } from "./components/layout/UiFeedback";
import TaskSidebar from "./components/layout/TaskSidebar";
import WorkflowTabs from "./components/layout/WorkflowTabs";
import MotionSyncModal from "./components/quality/MotionSyncModal";
import QualityMatchModal from "./components/quality/QualityMatchModal";
import NewTaskModal from "./components/tasks/NewTaskModal";
import CreateRoutePicker from "./components/workflow/CreateRoutePicker";
import { CurrentWorkingReferencePanel } from "./components/workflow/WorkingRangePanel";
import {
  taskRoute,
  type ReportView,
  type TabId,
  useCanonicalTaskRoute,
  useReportRouteState,
  useWorkflowRouteState,
} from "./hooks/useWorkflowRouting";
import { useVideoFrameStrip, type VideoFrameStripItem } from "./hooks/useVideoFrameStrip";
import { useTaskLifecycle } from "./hooks/useTaskLifecycle";
import { useGenerationConfigState } from "./hooks/useGenerationConfigState";
import { useGenerationMergeState } from "./hooks/useGenerationMergeState";
import { useReportOutputSelection } from "./hooks/useReportOutputSelection";
import type {
  PatchEditModelId,
  VideoModeId,
  VideoModelId,
} from "./lib/generated/videoContracts";
import { getGenerationModeConfig, type GenerateInputMode } from "./lib/generationModeRegistry";
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
  ExportRecord,
  FrameVariant,
  JobStatus,
  SegmentGeneration,
  SegmentRecord,
  TaskDetail,
} from "./types/api";

type VideoModel = VideoModelId;

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

type PatchEngine = PatchEditModelId;
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

const MAX_TRACKED_JOB_IDS = 40;
const TASK_URL_REFRESH_MS = 15 * 60 * 1000;
const ACTIVE_TASK_POLL_MS = 3000;
const URL_REFRESH_IDLE_MS = 2 * 60 * 1000;
const AUTOMATION_CANCELLED = "__automation_cancelled__";
const SEGMENT_SELECTION_STORAGE_KEY = "aivfx:lastSegmentByTask:v1";
const VIDEO_WORK_MODE_STORAGE_KEY = "aivfx:videoWorkModeByTask:v1";
const WHOLE_VIDEO_SINGLE_PASS_LIMIT_SECONDS = 10;

type VideoWorkMode = "whole_video" | "custom_segment";
type PrimaryWorkflowSection = "source" | "create" | "outputs" | "post" | "reports" | "assets";

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

function generatedOutputFrameToSourceFrame(
  outputFrameIndex: number,
  trimStartFrames: number,
  visibleSourceFrames: number,
  effectiveOutputFrames: number,
): number {
  const safeVisibleSourceFrames = Math.max(1, visibleSourceFrames);
  const safeEffectiveOutputFrames = Math.max(1, effectiveOutputFrames);
  if (safeVisibleSourceFrames <= 1 || safeEffectiveOutputFrames <= 1) {
    return trimStartFrames;
  }
  const clampedOutputFrameIndex = clampInteger(outputFrameIndex, 0, safeEffectiveOutputFrames - 1);
  const sourceOffset =
    safeEffectiveOutputFrames === safeVisibleSourceFrames
      ? clampedOutputFrameIndex
      : Math.round((clampedOutputFrameIndex * (safeVisibleSourceFrames - 1)) / (safeEffectiveOutputFrames - 1));
  return trimStartFrames + clampInteger(sourceOffset, 0, safeVisibleSourceFrames - 1);
}

function remapGeneratedStripItems(
  displayFrameIndices: number[],
  sourceFrameIndices: number[],
  sourceItems: VideoFrameStripItem[],
): VideoFrameStripItem[] {
  const imageBySourceFrame = new Map(sourceItems.map((item) => [item.frameIndex, item.imageUrl ?? null]));
  return displayFrameIndices.map((displayFrameIndex, idx) => {
    const sourceFrameIndex = sourceFrameIndices[idx] ?? sourceFrameIndices[sourceFrameIndices.length - 1] ?? 0;
    return {
      frameIndex: displayFrameIndex,
      sourceFrameIndex,
      imageUrl: imageBySourceFrame.get(sourceFrameIndex) ?? null,
    };
  });
}

function hasActiveTaskWork(task: TaskDetail | undefined): boolean {
  if (!task) return false;
  for (const generation of Object.values(task.segmentGenerations ?? {})) {
    if (generation.status === "queued" || generation.status === "running") return true;
  }
  for (const run of task.chunkedGenerationRuns ?? []) {
    if (run.status === "created" || run.status === "running") return true;
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

function workflowSectionForTab(tab: TabId): PrimaryWorkflowSection | null {
  if (tab === "timeline") return "source";
  if (tab === "frames" || tab === "refine") return "create";
  if (tab === "generate" || tab === "outputs") return "outputs";
  if (tab === "merge") return "post";
  if (tab === "report") return "reports";
  if (tab === "assets") return "assets";
  return null;
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

function readVideoWorkModeMap(): Record<string, VideoWorkMode> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VIDEO_WORK_MODE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const output: Record<string, VideoWorkMode> = {};
    for (const [taskId, mode] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof taskId === "string" && (mode === "whole_video" || mode === "custom_segment")) {
        output[taskId] = mode;
      }
    }
    return output;
  } catch {
    return {};
  }
}

function writeVideoWorkModeMap(value: Record<string, VideoWorkMode>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIDEO_WORK_MODE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage errors without breaking app flow.
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
  if (model === "sora-2-image-to-video") return "Sora 2 Image to Video";
  if (model === "happy-horse-video-edit") return "Happy Horse 1.0 Video Edit";
  if (model === "happy-horse-image-to-video") return "Happy Horse 1.0 Image to Video";
  if (model === "runway-gen4-aleph") return "Runway Gen-4 Aleph";
  if (model === "kling-2.6") return "Kling 2.6";
  if (model === "kling-o1") return "Kling O1 Edit";
  if (model === "kling-v3-omni-video") return "Kling v3 Omni Video";
  if (model === "seedance-2.0-reference-to-video") return "Seedance 2.0 Reference to Video";
  if (model === "veo-3.1") return "Veo 3.1";
  if (model === "veo-3.1-fast") return "Veo 3.1 Fast";
  if (model === "wan2.2-a14b") return "Wan 2.2 A14B";
  if (model === "wan2.2-animate") return "Wan 2.2 Animate";
  if (model === "wan2.7-videoedit") return "Wan 2.7 VideoEdit";
  if (model === "wan2.7-i2v") return "Wan 2.7 Image to Video";
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
  if (model === "sora-2-image-to-video") return { minSeconds: 4, maxSeconds: 10 };
  if (model === "happy-horse-video-edit" || model === "happy-horse-image-to-video") return { minSeconds: 3, maxSeconds: 15 };
  if (model === "runway-gen4-aleph") return { maxSeconds: 10 };
  if (model === "kling-2.6") return { maxSeconds: 10 };
  if (model === "kling-o1") return { minSeconds: 3, maxSeconds: 10 };
  if (model === "kling-v3-omni-video") return { minSeconds: 3, maxSeconds: 10 };
  if (model === "seedance-2.0-reference-to-video") return { minSeconds: 4, maxSeconds: 15 };
  if (model === "veo-3.1" || model === "veo-3.1-fast") return { maxSeconds: 8, frameBudgetFps: MODEL_FRAME_BUDGET_FPS };
  if (model === "wan2.2-a14b") return { maxSeconds: 5 };
  if (model === "wan2.2-animate") return { maxSeconds: 10 };
  if (model === "wan2.7-videoedit") return { minSeconds: 2, maxSeconds: 10 };
  if (model === "wan2.7-i2v") return { minSeconds: 2, maxSeconds: 10 };
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
      message: `${label} requires a source working range between ${minSeconds}s and ${maxSeconds}s. Your selection is ${durationSec.toFixed(2)}s.`,
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

const AUTOMATION_VIDEO_OPTIONS: AutomationVideoOption[] = [
  { id: "ray-flash-2:start_video:flex_1", label: "Luma Ray Flash 2 (Start frame + video)", inputMode: "start_video", lumaModel: "ray-flash-2", mode: "flex_1" },
  { id: "ray-2:start_video:flex_1", label: "Luma Ray 2 (Start frame + video)", inputMode: "start_video", lumaModel: "ray-2", mode: "flex_1" },
  { id: "happy-horse-video-edit:start_video:happy_horse_video_edit", label: "Happy Horse 1.0 Video Edit (Start frame + video)", inputMode: "start_video", lumaModel: "happy-horse-video-edit", mode: "happy_horse_video_edit" },
  { id: "runway-gen4-aleph:start_video:runway_aleph_v2v", label: "Runway Gen-4 Aleph (Start frame + video)", inputMode: "start_video", lumaModel: "runway-gen4-aleph", mode: "runway_aleph_v2v" },
  { id: "kling-v3-omni-video:start_video:kling_v3_omni_video_edit", label: "Kling v3 Omni Video (Start frame + video)", inputMode: "start_video", lumaModel: "kling-v3-omni-video", mode: "kling_v3_omni_video_edit" },
  { id: "seedance-2.0-reference-to-video:start_video:seedance_reference_to_video", label: "Seedance 2.0 Reference to Video (Start frame + video)", inputMode: "start_video", lumaModel: "seedance-2.0-reference-to-video", mode: "seedance_reference_to_video" },
  { id: "kling-2.6:start_end:kling_start_end", label: "Kling 2.6 (Start/End frame)", inputMode: "start_end", lumaModel: "kling-2.6", mode: "kling_start_end" },
  { id: "kling-2.6:start_only:kling_start_only", label: "Kling 2.6 (Start frame only)", inputMode: "start_only", lumaModel: "kling-2.6", mode: "kling_start_only" },
  { id: "veo-3.1:start_end:veo_start_end", label: "Veo 3.1 (Start/End frame)", inputMode: "start_end", lumaModel: "veo-3.1", mode: "veo_start_end" },
  { id: "veo-3.1:start_only:veo_start_only", label: "Veo 3.1 (Start frame only)", inputMode: "start_only", lumaModel: "veo-3.1", mode: "veo_start_only" },
  { id: "veo-3.1-fast:start_end:veo_start_end", label: "Veo 3.1 Fast (Start/End frame)", inputMode: "start_end", lumaModel: "veo-3.1-fast", mode: "veo_start_end" },
  { id: "veo-3.1-fast:start_only:veo_start_only", label: "Veo 3.1 Fast (Start frame only)", inputMode: "start_only", lumaModel: "veo-3.1-fast", mode: "veo_start_only" },
  { id: "runway-gen4.5:start_only:runway_i2v", label: "Runway Gen-4.5 (Start frame only)", inputMode: "start_only", lumaModel: "runway-gen4.5", mode: "runway_i2v" },
  { id: "sora-2-image-to-video:start_only:sora_i2v", label: "Sora 2 Image to Video (Start frame only)", inputMode: "start_only", lumaModel: "sora-2-image-to-video", mode: "sora_i2v" },
  { id: "happy-horse-image-to-video:start_only:happy_horse_i2v", label: "Happy Horse 1.0 Image to Video (Start frame only)", inputMode: "start_only", lumaModel: "happy-horse-image-to-video", mode: "happy_horse_i2v" },
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
          <img src={frame.imageUrl} alt={`${title} preview`} className="max-h-28 w-full rounded-md bg-bg object-contain" loading="lazy" decoding="async" />
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

function MergeTrackStrip({
  title,
  items,
  anchorFrame,
  anchorEdge = "start",
  anchorSlotIndex = 3,
  overlapStart,
  overlapEnd,
  prefix,
  frameLabelPosition = "bottom",
}: {
  title: string;
  items: VideoFrameStripItem[];
  anchorFrame: number;
  anchorEdge?: "start" | "end";
  anchorSlotIndex?: number;
  overlapStart?: number;
  overlapEnd?: number;
  prefix: string;
  frameLabelPosition?: "top" | "bottom";
}) {
  const itemWidthPx = 96;
  const overlapMin = overlapStart != null && overlapEnd != null ? Math.min(overlapStart, overlapEnd) : null;
  const overlapMax = overlapStart != null && overlapEnd != null ? Math.max(overlapStart, overlapEnd) : null;
  const clampedAnchorSlotIndex = clampInteger(anchorSlotIndex, 0, 6);
  const slotOffsets = Array.from({ length: 7 }, (_, idx) => idx - clampedAnchorSlotIndex);
  const itemsByFrame = new Map(items.map((item) => [item.frameIndex, item]));
  const slots = slotOffsets.map((offset) => ({
    offset,
    frameIndex: anchorFrame + offset,
    item: itemsByFrame.get(anchorFrame + offset) ?? null,
  }));
  const overlapStartSlot = overlapMin != null ? overlapMin - anchorFrame + clampedAnchorSlotIndex : -1;
  const overlapEndSlot = overlapMax != null ? overlapMax - anchorFrame + clampedAnchorSlotIndex : -1;
  const cutPx = (clampedAnchorSlotIndex + (anchorEdge === "end" ? 1 : 0)) * itemWidthPx;
  const overlapStartPx = overlapStartSlot * itemWidthPx;
  const overlapEndPx = (overlapEndSlot + 1) * itemWidthPx;
  const showOverlapStartGuide =
    overlapMin != null && overlapMax != null && overlapStartSlot >= 0 && overlapStartSlot <= slotOffsets.length && Math.abs(overlapStartPx - cutPx) > 0.5;
  const showOverlapEndGuide =
    overlapMin != null && overlapMax != null && overlapEndSlot >= -1 && overlapEndSlot < slotOffsets.length && Math.abs(overlapEndPx - cutPx) > 0.5;

  return (
    <div className="flex items-start gap-2">
      <div className="w-14 shrink-0 pt-1 text-[11px] font-medium leading-4 text-ink/75">
        {title}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto rounded border border-ink/15 bg-white">
        <div className="relative inline-flex min-w-full">
          {slots.map((slot) => {
            const item = slot.item;
            const inOverlap = overlapMin != null && overlapMax != null && slot.frameIndex >= overlapMin && slot.frameIndex <= overlapMax;
            return (
              <div
                key={`${title}:${slot.frameIndex}`}
                className={`shrink-0 border-r border-ink/15 ${
                  inOverlap ? "bg-amber-50" : item ? "bg-bg" : "bg-ink/5"
                } last:border-r-0`}
                style={{ width: `${itemWidthPx}px` }}
              >
                {frameLabelPosition === "top" ? (
                  <p className="truncate px-1 py-1 text-[10px] text-ink/70">
                    {slot.frameIndex >= 0 ? `${prefix}${slot.frameIndex}` : ""}
                  </p>
                ) : null}
                {item?.imageUrl ? (
                  <img src={item.imageUrl} alt={`${prefix}${slot.frameIndex}`} className="h-16 w-full object-contain" />
                ) : item ? (
                  <div className="flex h-16 w-full items-center justify-center text-[10px] text-ink/60">loading…</div>
                ) : (
                  <div className="flex h-16 w-full items-center justify-center text-[10px] text-ink/35">out of range</div>
                )}
                {frameLabelPosition === "bottom" ? (
                  <p className="truncate px-1 py-1 text-[10px] text-ink/70">
                    {slot.frameIndex >= 0 ? `${prefix}${slot.frameIndex}` : ""}
                  </p>
                ) : null}
              </div>
            );
          })}
          <div
            className="pointer-events-none absolute bottom-0 top-0 w-[2px] bg-teal-600"
            style={{ left: `${cutPx}px` }}
            title="Merge cut"
          />
          {showOverlapStartGuide ? (
            <div
              className="pointer-events-none absolute bottom-0 top-0 w-px border-l border-dashed border-amber-500"
              style={{ left: `${overlapStartPx}px` }}
              title="Feather start"
            />
          ) : null}
          {showOverlapEndGuide ? (
            <div
              className="pointer-events-none absolute bottom-0 top-0 w-px border-l border-dashed border-amber-500"
              style={{ left: `${overlapEndPx}px` }}
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
  actionLabel,
  onAction,
  firstTrack,
  secondTrack,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
  firstTrack: {
    title: string;
    items: VideoFrameStripItem[];
    anchorFrame: number;
    anchorEdge?: "start" | "end";
    anchorSlotIndex?: number;
    overlapStart?: number;
    overlapEnd?: number;
    prefix: string;
    frameLabelPosition?: "top" | "bottom";
  };
  secondTrack: {
    title: string;
    items: VideoFrameStripItem[];
    anchorFrame: number;
    anchorEdge?: "start" | "end";
    anchorSlotIndex?: number;
    overlapStart?: number;
    overlapEnd?: number;
    prefix: string;
    frameLabelPosition?: "top" | "bottom";
  };
}) {
  return (
    <div className="space-y-1 rounded-lg border border-ink/10 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{title}</p>
        <button
          type="button"
          className="rounded-md border border-ink/20 bg-white px-3 py-1.5 text-xs text-ink transition hover:border-teal-500 hover:text-teal-700"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      </div>
      <div className="space-y-1">
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
  const {
    selectedReportOutputs,
    selectedOutputRefsByTask,
    reportOutputRefKey,
    toggleCustomReportOutput,
    clearCustomReportOutputs,
  } = useReportOutputSelection();
  const [mergedAssetsVisible, setMergedAssetsVisible] = useState(6);
  const [editedFrameAssetsVisible, setEditedFrameAssetsVisible] = useState(6);
  const [generatedAssetsVisible, setGeneratedAssetsVisible] = useState(6);
  const [libraryMergedAssetsVisible, setLibraryMergedAssetsVisible] = useState(6);
  const [libraryEditedFrameAssetsVisible, setLibraryEditedFrameAssetsVisible] = useState(6);
  const [libraryGeneratedAssetsVisible, setLibraryGeneratedAssetsVisible] = useState(6);
  const [generationCardsVisible, setGenerationCardsVisible] = useState(6);
  const [jobsVisible, setJobsVisible] = useState(6);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<"nano_banana" | "nano_banana_pro" | "chatgpt" | "chatgpt_latest">("nano_banana_pro");
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
  const {
    generationInputMode,
    setGenerationInputMode,
    generationModelByInput,
    setGenerationModelByInput,
    lumaModel,
    advancedMode,
    setAdvancedMode,
    lumaPrompt,
    setLumaPrompt,
    lumaContinuationPrompt,
    setLumaContinuationPrompt,
    preserveFrames,
    setPreserveFrames,
    replicateKlingMode,
    setReplicateKlingMode,
    replicateKlingV3Mode,
    setReplicateKlingV3Mode,
    wan27Resolution,
    setWan27Resolution,
    happyHorseResolution,
    setHappyHorseResolution,
    wan27NegativePrompt,
    setWan27NegativePrompt,
    sora2Resolution,
    setSora2Resolution,
    generationModelOptions,
  } = useGenerationConfigState();
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
  const [imageCompareModal, setImageCompareModal] = useState<{ originalUrl: string; compareUrl: string; label: string } | null>(null);
  const [videoCompareModal, setVideoCompareModal] = useState<{
    originalUrl: string;
    compareUrl: string;
    label: string;
    posterUrl?: string | null;
    segmentStartSec?: number;
    originalIsSegmentClip?: boolean;
  } | null>(null);
  const [, setReportGraphModal] = useState<{ url: string; label: string } | null>(null);
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
  const [appUiError, setAppUiError] = useState<string | null>(null);
  const [mergeApplyRetime, setMergeApplyRetime] = useState(false);
  const [mergePlaybackRate, setMergePlaybackRate] = useState(1);
  const [mergeAlignmentSuggestion, setMergeAlignmentSuggestion] = useState<{
    suggested: {
      startFrameOverride: number;
      trimStartFrames: number;
      trimEndFrames: number;
    };
    analysis: {
      sourceFrameOffset: number;
      sourceOffsetSec: number;
      earlyMedianDriftFrames: number;
      lateMedianDriftFrames: number;
      residualEndFrames: number;
      meanAbsDriftFrames: number;
      residualMeanAbsDriftFrames: number;
      suggestedPlaybackRate: number;
      recommendation: string;
      confidence: number;
      notes: string[];
    };
  } | null>(null);
  const [mergeAlignmentSuggestionJobId, setMergeAlignmentSuggestionJobId] = useState<string | null>(null);
  const [mergeAlignmentSuggestionError, setMergeAlignmentSuggestionError] = useState<string | null>(null);
  const [reconcileTimingJobId, setReconcileTimingJobId] = useState<string | null>(null);
  const [reconcileTimingError, setReconcileTimingError] = useState<string | null>(null);
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
  const [videoWorkMode, setVideoWorkModeState] = useState<VideoWorkMode | null>(null);
  const [segmentDraftActive, setSegmentDraftActive] = useState(false);
  const [segmentDraftFallbackId, setSegmentDraftFallbackId] = useState<string | null>(null);
  const [editFrameTab, setEditFrameTab] = useState<"first" | "last">("first");
  const [refineFrameTab, setRefineFrameTab] = useState<"first" | "last">("first");
  const timelineVideoRef = useRef<HTMLVideoElement | null>(null);
  const patchOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchDrawStateRef = useRef<{ tool: PatchToolMode; points: MaskPoint[]; last: MaskPoint | null } | null>(null);
  const signedUrlRefreshRef = useRef<Map<string, number>>(new Map());
  const pageHiddenAtRef = useRef<number | null>(null);
  const automationCancelRef = useRef(false);
  const defaultSegmentInitRef = useRef<Set<string>>(new Set());
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

  const tab: TabId = routeState.tab ?? "timeline";
  const activeWorkflowSection = workflowSectionForTab(tab);
  const activePostTab: TabId = tab === "merge" ? tab : "merge";
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

  const setVideoWorkMode = useCallback(
    (mode: VideoWorkMode | null, taskIdOverride?: string | null) => {
      const targetTaskId = taskIdOverride ?? selectedTaskId ?? null;
      setVideoWorkModeState(mode);
      if (!targetTaskId) return;
      const stored = readVideoWorkModeMap();
      if (!mode) {
        if (stored[targetTaskId]) {
          delete stored[targetTaskId];
          writeVideoWorkModeMap(stored);
        }
        return;
      }
      if (stored[targetTaskId] !== mode) {
        stored[targetTaskId] = mode;
        writeVideoWorkModeMap(stored);
      }
    },
    [selectedTaskId],
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

  const handlePrimaryWorkflowSectionChange = useCallback(
    (section: PrimaryWorkflowSection) => {
      if (section === "source") {
        setTab("timeline");
        return;
      }
      if (section === "create") {
        setTab("frames");
        return;
      }
      if (section === "outputs") {
        setTab("outputs");
        return;
      }
      if (section === "post") {
        setTab(activePostTab);
        return;
      }
      if (section === "reports") {
        if (!selectedTaskId) return;
        goToReport(selectedTaskId, "reports", activeCustomReportId);
        return;
      }
      setTab("assets");
    },
    [activeCustomReportId, activePostTab, goToReport, selectedTaskId, setTab],
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
      enabled: isAuthed && tab === "asset_library" && isPageVisible,
      refetchOnWindowFocus: false as const,
    })),
  });
  const task = taskQuery.data;
  const reportTask = reportTaskQuery.data;
  const assetTasks = useMemo(
    () => assetTaskQueries.map((query) => query.data).filter((item): item is TaskDetail => Boolean(item)),
    [assetTaskQueries],
  );
  const selectedMotionSyncExport = useMemo<ExportRecord | null>(() => {
    if (!motionSyncModalExportId) return null;
    return (task?.exports ?? []).find((item) => item.exportId === motionSyncModalExportId) ?? null;
  }, [motionSyncModalExportId, task?.exports]);
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

  const assetsLoading = tab === "assets" && (taskQuery.isPending || taskQuery.isFetching) && !task;
  const assetLibraryLoading = tab === "asset_library" && assetTaskQueries.some((query) => query.isPending || query.isFetching) && assetTasks.length === 0;
  const selectedSegment = task?.segments.find((s) => s.segmentId === selectedSegmentId) ?? null;
  const totalVideoFrames = frameCount(task);
  const defaultVideoSegment = useMemo(
    () =>
      (task?.segments ?? []).find(
        (segment) => !segment.internalOnly && segment.startFrame === 0 && totalVideoFrames > 0 && segment.endFrameExclusive === totalVideoFrames,
      ) ?? null,
    [task?.segments, totalVideoFrames],
  );
  const isWholeVideoSelection = Boolean(
    selectedSegment &&
      totalVideoFrames > 0 &&
      selectedSegment.startFrame === 0 &&
      selectedSegment.endFrameExclusive === totalVideoFrames,
  );
  const wholeVideoNeedsChunking = Boolean(
    isWholeVideoSelection && selectedSegment && selectedSegment.durationSec > WHOLE_VIDEO_SINGLE_PASS_LIMIT_SECONDS + 1e-6,
  );
  useEffect(() => {
    if (generationInputMode === "start_end") return;
    if (editFrameTab === "last") {
      setEditFrameTab("first");
    }
    if (refineFrameTab === "last") {
      setRefineFrameTab("first");
    }
  }, [editFrameTab, generationInputMode, refineFrameTab]);
  const completeGenerations = useMemo(
    () => segmentGenerations.filter((generation) => generation.status === "complete" && Boolean(generation.outputKey) && !generation.isChunkInternal),
    [segmentGenerations],
  );
  const selectedSegmentChunkedGenerationRuns = useMemo(
    () =>
      [...(task?.chunkedGenerationRuns ?? [])]
        .filter((run) => run.sourceSegmentId === selectedSegmentId && run.status !== "canceled")
        .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()),
    [selectedSegmentId, task?.chunkedGenerationRuns],
  );
  const getSegmentForGeneration = useCallback(
    (generation: SegmentGeneration) => segmentsById.get(generation.segmentId) ?? null,
    [segmentsById],
  );
  const frameVariantImageUrl = useCallback(
    (frameId: string | null | undefined, variantId: string | null | undefined) => {
      if (!frameId || !variantId) return null;
      const frame = task?.frames?.[frameId];
      const variant = frame?.variants?.find((item) => item.variantId === variantId);
      return variant?.imageUrl ?? null;
    },
    [task?.frames],
  );
  const activeVideoCleanupGeneration = useMemo<SegmentGeneration | null>(() => {
    if (!videoCleanupModal.generationId) return null;
    return task?.segmentGenerations?.[videoCleanupModal.generationId] ?? null;
  }, [task?.segmentGenerations, videoCleanupModal.generationId]);
  const firstFrame = task && firstFrameId ? task.frames[firstFrameId] ?? null : null;
  const lastFrame = task && lastFrameId ? task.frames[lastFrameId] ?? null : null;
  const lastHydratedSegmentIdRef = useRef<string | null>(null);
  const editFirstFrame = (firstFrameId ? task?.frames[firstFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.startFrameId] : null) ?? null;
  const editLastFrame = (lastFrameId ? task?.frames[lastFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.endFrameId] : null) ?? null;
  const activeEditFrame = editFrameTab === "first" ? editFirstFrame : editLastFrame;
  const activeRefineFrame = refineFrameTab === "first" ? editFirstFrame : editLastFrame;
  const activeEditVariants = useMemo(
    () =>
      [...(activeEditFrame?.variants ?? [])].sort(
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
  const activeChosenVariantId = refineSourceVariantIds[editFrameTab] || activeCompareVariantId;
  const activeSelectedVariant = useMemo(
    () =>
      activeEditSourceVariantId
        ? activeEditVariants.find((variant) => variant.variantId === activeEditSourceVariantId) ?? null
        : null,
    [activeEditSourceVariantId, activeEditVariants],
  );
  const activeEditSourceImageUrl = activeSelectedVariant?.imageUrl ?? activeEditFrame?.imageUrl ?? null;
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
        isSelected: !activeChosenVariantId,
      },
    ];
    for (const variant of activeEditVariants) {
      if (!variant.imageUrl) continue;
      candidates.push({
        id: variant.variantId,
        kind: "variant",
        imageUrl: variant.imageUrl,
        label:
          variant.generationSettings?.workflow === "manual_frame_upload"
            ? "Manual upload"
            : `${variant.model} / ${variant.type}`,
        createdAt: variant.createdAt,
        variantId: variant.variantId,
        variant,
        qualityMatched: Boolean(variant.qualityMatch?.analysisId),
        isSelected: activeChosenVariantId === variant.variantId,
      });
    }
    return candidates;
  }, [activeChosenVariantId, activeEditFrame, activeEditVariants]);
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
  useEffect(() => {
    setFirstFrameId(null);
    setLastFrameId(null);
    setSelectedSegmentId(null);
    setVideoWorkModeState(null);
    setSegmentDraftActive(false);
    setSegmentDraftFallbackId(null);
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
    if (!selectedTaskId) return;
    const stored = readVideoWorkModeMap();
    setVideoWorkModeState(stored[selectedTaskId] ?? null);
  }, [selectedTaskId]);

  useEffect(() => {
    if (tab !== "refine") return;
    setRefineFrameTab(editFrameTab);
  }, [editFrameTab, tab]);

  useEffect(() => {
    if (!selectedTaskId || selectedSegmentId || segmentDraftActive) return;
    const rememberedByTask = readSegmentSelectionMap();
    const rememberedSegmentId = rememberedByTask[selectedTaskId];
    if (rememberedSegmentId && task?.segments?.length) {
      const exists = task.segments.some((segment) => segment.segmentId === rememberedSegmentId);
      if (!exists) {
        delete rememberedByTask[selectedTaskId];
        writeSegmentSelectionMap(rememberedByTask);
      } else {
        setSelectedSegmentId(rememberedSegmentId);
        return;
      }
    }
    if (defaultVideoSegment) {
      setSelectedSegmentId(defaultVideoSegment.segmentId);
      return;
    }
    if (rememberedSegmentId && task?.segments?.length) {
      setSelectedSegmentId(rememberedSegmentId);
    }
  }, [defaultVideoSegment, segmentDraftActive, selectedSegmentId, selectedTaskId, setSelectedSegmentId, task?.segments, videoWorkMode]);

  useEffect(() => {
    if (!selectedTaskId || !selectedSegmentId) return;
    const rememberedByTask = readSegmentSelectionMap();
    if (rememberedByTask[selectedTaskId] === selectedSegmentId) return;
    rememberedByTask[selectedTaskId] = selectedSegmentId;
    writeSegmentSelectionMap(rememberedByTask);
  }, [selectedSegmentId, selectedTaskId]);

  useEffect(() => {
    if (segmentDraftActive) return;
    if (!selectedSegmentId) {
      setSegmentDraftFallbackId(null);
      return;
    }
    setSegmentDraftFallbackId(selectedSegmentId);
  }, [segmentDraftActive, selectedSegmentId]);

  useEffect(() => {
    if (segmentDraftActive && selectedSegmentId) {
      setSegmentDraftActive(false);
    }
  }, [segmentDraftActive, selectedSegmentId]);

  useEffect(() => {
    if (!selectedSegment) {
      lastHydratedSegmentIdRef.current = null;
      return;
    }
    const segmentChanged = lastHydratedSegmentIdRef.current !== selectedSegment.segmentId;
    if (segmentChanged || videoWorkMode === "whole_video") {
      setFirstFrameId(selectedSegment.startFrameId);
      setLastFrameId(selectedSegment.endFrameId);
      lastHydratedSegmentIdRef.current = selectedSegment.segmentId;
    }
  }, [selectedSegment, videoWorkMode]);

  useEffect(() => {
    if (!selectedSegment) return;
    if (isWholeVideoSelection) {
      if (videoWorkMode !== "whole_video") {
        setVideoWorkMode("whole_video");
      }
      return;
    }
    if (videoWorkMode !== "custom_segment") {
      setVideoWorkMode("custom_segment");
    }
  }, [defaultVideoSegment, isWholeVideoSelection, selectedSegment, setVideoWorkMode, videoWorkMode]);

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
      setMergedAssetsVisible(6);
      setEditedFrameAssetsVisible(6);
      setGeneratedAssetsVisible(6);
    }
    if (tab === "asset_library") {
      setLibraryMergedAssetsVisible(6);
      setLibraryEditedFrameAssetsVisible(6);
      setLibraryGeneratedAssetsVisible(6);
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

  useEffect(() => {
    if (!task || !selectedTaskId || !totalVideoFrames || defaultVideoSegment || createSegmentMutation.isPending) return;
    const initKey = `${selectedTaskId}:${totalVideoFrames}`;
    if (defaultSegmentInitRef.current.has(initKey)) return;
    defaultSegmentInitRef.current.add(initKey);
    void createSegmentMutation
      .mutateAsync({
        startFrameIndex: 0,
        endFrameExclusive: totalVideoFrames,
      })
      .catch(() => {
        defaultSegmentInitRef.current.delete(initKey);
      });
  }, [createSegmentMutation, defaultVideoSegment, selectedTaskId, task, totalVideoFrames]);

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
      setSegmentDraftActive(false);
      setSegmentDraftFallbackId(variables.segmentId);
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

  const resolveSelectedGenerationMode = useCallback((): string => {
    return lumaModel === "runway-gen4.5"
      ? "runway_i2v"
      : lumaModel === "sora-2-image-to-video"
        ? "sora_i2v"
      : lumaModel === "happy-horse-video-edit"
        ? "happy_horse_video_edit"
      : lumaModel === "happy-horse-image-to-video"
        ? "happy_horse_i2v"
      : lumaModel === "runway-gen4-aleph"
        ? "runway_aleph_v2v"
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
      : lumaModel === "wan2.7-i2v"
        ? generationInputMode === "start_end"
          ? "wan27_i2v_start_end"
          : "wan27_i2v_start_only"
      : lumaModel === "wan2.7-videoedit"
        ? "wan27_video_edit"
      : advancedMode;
  }, [advancedMode, generationInputMode, lumaModel]);

  const generateSegmentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !selectedSegmentId) throw new Error("Select a segment");
      const trimmedPrompt = lumaPrompt.trim();
      const selectedMode = resolveSelectedGenerationMode();
      return apiClient.generateSegment(selectedTaskId, selectedSegmentId, {
        lumaModel,
        mode: selectedMode as VideoModeId,
        prompt: lumaModel === "wan2.2-animate" ? undefined : trimmedPrompt || undefined,
        negativePrompt: lumaModel === "wan2.7-i2v" ? wan27NegativePrompt.trim() || undefined : undefined,
        firstFrameVariantId: refineSourceVariantIds.first || compareVariantIds.first || undefined,
        lastFrameVariantId: generationInputMode === "start_end" ? refineSourceVariantIds.last || compareVariantIds.last || undefined : undefined,
        replicateKlingMode: lumaModel === "kling-o1" ? replicateKlingMode : undefined,
        replicateKlingV3Mode: lumaModel === "kling-v3-omni-video" ? replicateKlingV3Mode : undefined,
        wan27Resolution: lumaModel === "wan2.7-videoedit" || lumaModel === "wan2.7-i2v" ? wan27Resolution : undefined,
        sora2Resolution: lumaModel === "sora-2-image-to-video" ? sora2Resolution : undefined,
        happyHorseResolution: lumaModel === "happy-horse-video-edit" || lumaModel === "happy-horse-image-to-video" ? happyHorseResolution : undefined,
        preserveFrames,
      });
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      setTab("outputs");
    },
  });

  const generateChunkedSegmentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !selectedSegmentId) throw new Error("Select a segment");
      const trimmedPrompt = lumaPrompt.trim();
      const selectedMode =
        lumaModel === "kling-o1"
          ? "kling_o1_video_edit"
          : lumaModel === "kling-v3-omni-video"
            ? "kling_v3_omni_video_edit"
            : lumaModel === "runway-gen4-aleph"
              ? "runway_aleph_v2v"
            : lumaModel === "seedance-2.0-reference-to-video"
              ? "seedance_reference_to_video"
              : lumaModel === "wan2.2-animate"
                ? "wan_animate_replace"
                : lumaModel === "wan2.7-videoedit"
                  ? "wan27_video_edit"
                  : advancedMode;
      return apiClient.generateSegmentChunked(selectedTaskId, selectedSegmentId, {
        lumaModel,
        mode: selectedMode as VideoModeId,
        openingPrompt: lumaModel === "wan2.2-animate" ? undefined : trimmedPrompt || undefined,
        continuationPrompt:
          lumaModel === "wan2.2-animate"
            ? undefined
            : lumaContinuationPrompt.trim()
              ? lumaContinuationPrompt.trim()
              : undefined,
        firstFrameVariantId: refineSourceVariantIds.first || compareVariantIds.first || undefined,
        replicateKlingMode: lumaModel === "kling-o1" ? replicateKlingMode : undefined,
        replicateKlingV3Mode: lumaModel === "kling-v3-omni-video" ? replicateKlingV3Mode : undefined,
        wan27Resolution: lumaModel === "wan2.7-videoedit" ? wan27Resolution : undefined,
        preserveFrames,
      });
    },
    onSuccess: async (result) => {
      if (result.jobId) {
        setJobIds((prev) => appendTrackedJobId(prev, result.jobId as string));
      }
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      setTab("outputs");
    },
  });

  const pauseChunkedGenerationMutation = useMutation({
    mutationFn: async ({ runId, reason }: { runId: string; reason?: string }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.pauseChunkedGeneration(selectedTaskId, runId, { reason });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const resumeChunkedGenerationMutation = useMutation({
    mutationFn: async ({ runId }: { runId: string }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.resumeChunkedGeneration(selectedTaskId, runId);
    },
    onSuccess: async (result) => {
      if (result.jobId) {
        setJobIds((prev) => appendTrackedJobId(prev, result.jobId as string));
      }
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const restartChunkedGenerationMutation = useMutation({
    mutationFn: async ({ runId, fromChunkIndex, prompt }: { runId: string; fromChunkIndex: number; prompt?: string }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.restartChunkedGeneration(selectedTaskId, runId, { fromChunkIndex, prompt });
    },
    onSuccess: async (result) => {
      if (result.jobId) {
        setJobIds((prev) => appendTrackedJobId(prev, result.jobId as string));
      }
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const saveChunkedGenerationDraftMutation = useMutation({
    mutationFn: async ({ runId }: { runId: string }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.saveChunkedGenerationDraft(selectedTaskId, runId);
    },
    onSuccess: async (result) => {
      if (result.jobId) {
        setJobIds((prev) => appendTrackedJobId(prev, result.jobId as string));
      }
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const cancelChunkedGenerationMutation = useMutation({
    mutationFn: async ({ runId, reason }: { runId: string; reason?: string }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.cancelChunkedGeneration(selectedTaskId, runId, { reason });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
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
      setTab("outputs");
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId) throw new Error("Select a task");
      const generationAdjustments =
        mergeTargetGeneration && selectedGenIds.includes(mergeTargetGeneration.genId)
                ? {
                    [mergeTargetGeneration.genId]: {
                      startFrameOverride: mergeInsertStartFrameEffective,
                      trimStartFrames: mergeTrimStartUserClamped,
                      trimEndFrames: mergeTrimEndClamped,
                      playbackRate: mergeApplyRetime ? mergePlaybackRate : undefined,
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

  const suggestMergeAlignmentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !mergeTargetGeneration?.genId) throw new Error("Choose a completed output first");
      return apiClient.suggestMergeAlignment(selectedTaskId, mergeTargetGeneration.genId);
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      setMergeAlignmentSuggestion(null);
      setMergeAlignmentSuggestionError(null);
      setMergeAlignmentSuggestionJobId(result.jobId);
      if (selectedTaskId) {
        await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      }
    },
  });

  const reconcileTimingMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !mergeTargetGeneration?.genId) throw new Error("Choose a completed output first");
      return apiClient.reconcileSegmentGenerationTiming(selectedTaskId, mergeTargetGeneration.genId, {
        trimStartFrames: mergeTrimStartUserClamped,
        trimEndFrames: mergeTrimEndClamped,
        playbackRate: mergeApplyRetime ? mergePlaybackRate : undefined,
      });
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      setReconcileTimingJobId(result.jobId);
      setReconcileTimingError(null);
      if (selectedTaskId) {
        await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      }
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
      const mergeSuggestionJobId = generation.mergeAlignmentSuggestion?.jobId;
      if (mergeSuggestionJobId) ids.push(mergeSuggestionJobId);
      const reconcileJobId = generation.timingReconcile?.jobId;
      if (reconcileJobId) ids.push(reconcileJobId);
    }
    for (const run of task?.chunkedGenerationRuns ?? []) {
      for (const chunk of run.chunks ?? []) {
        if (chunk.jobId) ids.push(chunk.jobId);
      }
    }
    for (const report of task?.customReports ?? []) {
      if (report.jobId) ids.push(report.jobId);
    }
    for (const exportItem of task?.exports ?? []) {
      const motionJobId = exportItem.motionSyncQc?.jobId;
      if (motionJobId) ids.push(motionJobId);
    }
    return ids;
  }, [task?.chunkedGenerationRuns, task?.customReports, task?.exports, task?.segmentGenerations]);

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

  const mergeAlignmentSuggestionJob = useMemo(() => {
    if (!mergeAlignmentSuggestionJobId) return null;
    for (const jq of jobQueries) {
      const data = jq.data;
      if (data?.jobId === mergeAlignmentSuggestionJobId) return data;
    }
    return null;
  }, [jobQueries, mergeAlignmentSuggestionJobId]);

  const reconcileTimingJob = useMemo(() => {
    if (!reconcileTimingJobId) return null;
    for (const jq of jobQueries) {
      const data = jq.data;
      if (data?.jobId === reconcileTimingJobId) return data;
    }
    return null;
  }, [jobQueries, reconcileTimingJobId]);

  const jobStatusById = useMemo(() => {
    const statuses = new Map<string, JobStatus["status"]>();
    for (const jq of jobQueries) {
      const data = jq.data;
      if (data?.jobId && data.status) statuses.set(data.jobId, data.status);
    }
    return statuses;
  }, [jobQueries]);

  const isSuggestingMergeAlignment = useMemo(() => {
    if (suggestMergeAlignmentMutation.isPending) return true;
    if (!mergeAlignmentSuggestionJobId) return false;
    const status = mergeAlignmentSuggestionJob?.status ?? jobStatusById.get(mergeAlignmentSuggestionJobId);
    return status !== "complete" && status !== "failed";
  }, [jobStatusById, mergeAlignmentSuggestionJob?.status, mergeAlignmentSuggestionJobId, suggestMergeAlignmentMutation.isPending]);

  const isReconcilingTiming = useMemo(() => {
    if (reconcileTimingMutation.isPending) return true;
    if (!reconcileTimingJobId) return false;
    const status = reconcileTimingJob?.status ?? jobStatusById.get(reconcileTimingJobId);
    return status !== "complete" && status !== "failed";
  }, [jobStatusById, reconcileTimingJob?.status, reconcileTimingJobId, reconcileTimingMutation.isPending]);

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
  const mergeStoredOutputFrameCount = Math.max(
    0,
    asNumber(mergeTargetGeneration?.generationSettings?.storedOutput?.frameCount) ?? 0,
  );
  const mergeGeneratedDurationFrames = Math.max(
    1,
    mergeStoredOutputFrameCount > 0
      ? Math.round(mergeStoredOutputFrameCount)
      : Math.round(Math.max(1 / Math.max(1, mergeFps), mergeProviderDurationSec) * mergeFps),
  );
  const mergeMaxFrameIndex = Math.max(0, frameCount(task) - 1);
  const mergeInsertStartFrameLowerBound = -(mergeTargetSegment?.startFrame ?? 0);
  const mergeInsertStartFrameUpperBound = mergeMaxFrameIndex - (mergeTargetSegment?.startFrame ?? 0);
  const mergeInsertStartFrameClamped = clampInteger(mergeInsertStartFrame, mergeInsertStartFrameLowerBound, mergeInsertStartFrameUpperBound);
  const mergeInsertStartFrameEffective = clampInteger(
    (mergeTargetSegment?.startFrame ?? 0) + mergeInsertStartFrameClamped,
    0,
    mergeMaxFrameIndex,
  );
  const mergeTrimStartUserClamped = clampInteger(mergeTrimStartFrames, 0, Math.max(0, mergeGeneratedDurationFrames - 1));
  const mergeTrimStartClamped = mergeTrimStartUserClamped;
  const mergeTrimEndClamped = clampInteger(
    mergeTrimEndFrames,
    0,
    Math.max(0, mergeGeneratedDurationFrames - 1 - mergeTrimStartClamped),
  );
  const mergeVisibleDurationFramesBeforeRetime = Math.max(1, mergeGeneratedDurationFrames - mergeTrimStartClamped - mergeTrimEndClamped);
  const mergeEffectiveDurationFrames = mergeApplyRetime
    ? Math.max(1, Math.round(mergeVisibleDurationFramesBeforeRetime / Math.max(0.05, mergePlaybackRate || 1)))
    : mergeVisibleDurationFramesBeforeRetime;
  const mergeEffectiveEndFrameExclusive = mergeInsertStartFrameEffective + mergeEffectiveDurationFrames;
  const mergeEffectiveEndFrameInclusive = Math.max(mergeInsertStartFrameEffective, mergeEffectiveEndFrameExclusive - 1);
  const mergeEndOffsetFrames = mergeEffectiveEndFrameExclusive - mergeOriginalEndFrameExclusive;
  const mergeGeneratedStartAnchor = 0;
  const mergeGeneratedEndAnchor = Math.max(0, mergeEffectiveDurationFrames - 1);
  const mergeFeatherClamped = clampInteger(temporalFeatherFrames, 0, 30);
  const mergeOriginalVideoForPreview = task?.video?.previewSource?.downloadUrl ?? task?.video?.editSource?.downloadUrl ?? null;
  const mergeGeneratedVideoForPreview = mergeTargetGeneration?.downloadUrl ?? null;
  const mergeSourceWidth = task?.video?.editSource?.width ?? task?.video?.previewSource?.width ?? 0;
  const mergeSourceHeight = task?.video?.editSource?.height ?? task?.video?.previewSource?.height ?? 0;
  const mergeOriginalSourceCacheKey = task?.video?.previewSource?.s3Key ?? task?.video?.editSource?.s3Key ?? "merge:original";
  const mergeGeneratedSourceCacheKey = mergeTargetGeneration?.outputKey ?? mergeTargetGeneration?.genId ?? "merge:generated";
  const mergeFrameStripEnabled = tab === "merge" && Boolean(mergeTargetGeneration && mergeTargetSegment);
  const startBoundaryOriginalFrames = useMemo(
    () => frameWindow(mergeInsertStartFrameEffective, 3, 3, 0, mergeMaxFrameIndex),
    [mergeInsertStartFrameEffective, mergeMaxFrameIndex],
  );
  const endBoundaryOriginalFrames = useMemo(
    () => frameWindow(mergeEffectiveEndFrameExclusive, 3, 3, 0, mergeMaxFrameIndex),
    [mergeEffectiveEndFrameExclusive, mergeMaxFrameIndex],
  );
  const generatedMaxFrameIndex = Math.max(0, mergeEffectiveDurationFrames - 1);
  const startBoundaryGeneratedFrames = useMemo(
    () => frameWindow(mergeGeneratedStartAnchor, 3, 3, 0, generatedMaxFrameIndex),
    [generatedMaxFrameIndex, mergeGeneratedStartAnchor],
  );
  const endBoundaryGeneratedFrames = useMemo(
    () => frameWindow(mergeGeneratedEndAnchor, 3, 3, 0, generatedMaxFrameIndex),
    [generatedMaxFrameIndex, mergeGeneratedEndAnchor],
  );
  const startBoundaryGeneratedSourceFrames = useMemo(
    () =>
      startBoundaryGeneratedFrames.map((frameIndex) =>
        generatedOutputFrameToSourceFrame(
          frameIndex,
          mergeTrimStartClamped,
          mergeVisibleDurationFramesBeforeRetime,
          mergeEffectiveDurationFrames,
        ),
      ),
    [
      startBoundaryGeneratedFrames,
      mergeTrimStartClamped,
      mergeVisibleDurationFramesBeforeRetime,
      mergeEffectiveDurationFrames,
    ],
  );
  const endBoundaryGeneratedSourceFrames = useMemo(
    () =>
      endBoundaryGeneratedFrames.map((frameIndex) =>
        generatedOutputFrameToSourceFrame(
          frameIndex,
          mergeTrimStartClamped,
          mergeVisibleDurationFramesBeforeRetime,
          mergeEffectiveDurationFrames,
        ),
      ),
    [
      endBoundaryGeneratedFrames,
      mergeTrimStartClamped,
      mergeVisibleDurationFramesBeforeRetime,
      mergeEffectiveDurationFrames,
    ],
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
    frameIndices: startBoundaryGeneratedSourceFrames,
    cachePrefix: "merge:start:generated",
    sourceCacheKey: mergeGeneratedSourceCacheKey,
  });
  const endBoundaryGeneratedThumbs = useVideoFrameStrip({
    videoUrl: mergeFrameStripEnabled ? mergeGeneratedVideoForPreview : null,
    fps: mergeFps,
    frameIndices: endBoundaryGeneratedSourceFrames,
    cachePrefix: "merge:end:generated",
    sourceCacheKey: mergeGeneratedSourceCacheKey,
  });
  const startBoundaryGeneratedDisplayThumbs = useMemo(
    () => remapGeneratedStripItems(startBoundaryGeneratedFrames, startBoundaryGeneratedSourceFrames, startBoundaryGeneratedThumbs),
    [startBoundaryGeneratedFrames, startBoundaryGeneratedSourceFrames, startBoundaryGeneratedThumbs],
  );
  const endBoundaryGeneratedDisplayThumbs = useMemo(
    () => remapGeneratedStripItems(endBoundaryGeneratedFrames, endBoundaryGeneratedSourceFrames, endBoundaryGeneratedThumbs),
    [endBoundaryGeneratedFrames, endBoundaryGeneratedSourceFrames, endBoundaryGeneratedThumbs],
  );
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
  const generationHelp = useMemo(
    () => generationModelHelp(lumaModel, advancedMode, generationInputMode),
    [advancedMode, generationInputMode, lumaModel],
  );
  const generationModeConfig = useMemo(() => getGenerationModeConfig(generationInputMode), [generationInputMode]);
  const requiresEndFrameForRoute = generationModeConfig.requiresEndFrame;
  const missingRouteInputsMessage = useMemo(() => {
    if (!editFirstFrame && requiresEndFrameForRoute && !editLastFrame) {
      return "No edited start or end frame selected. Generation will use the original source start and end frames.";
    }
    if (!editFirstFrame) {
      return "No edited start frame selected. Generation will use the original source start frame.";
    }
    if (requiresEndFrameForRoute && !editLastFrame) {
      return "No edited end frame selected. Generation will use the original source end frame.";
    }
    return null;
  }, [editFirstFrame, editLastFrame, requiresEndFrameForRoute]);
  const generationInputNote = useMemo(() => {
    if (lumaModel === "kling-o1") {
      return "Uses the selected working-range video as <<<video_1>>> and the selected edited start frame as <<<image_1>>>. Prompt must reference both.";
    }
    if (lumaModel === "kling-v3-omni-video") {
      return "Uses the selected working-range video as <<<video_1>>> and the selected edited start frame as <<<image_1>>> for base video editing. Prompt must reference both.";
    }
    if (lumaModel === "seedance-2.0-reference-to-video") {
      return "Uses the selected working-range video as @Video1 and the selected edited start frame as @Image1. Prompt must reference both. The working range is conformed to Seedance's smaller reference-video bounds, then the result is upscaled back to the working-range size.";
    }
    if (lumaModel === "wan2.7-videoedit") {
      return "Uses the selected working-range video plus the selected edited start frame as reference_image. Prompt should describe only the intended edit.";
    }
    if (lumaModel === "happy-horse-video-edit") {
      return "Uses the selected working-range video plus the selected edited start frame as @Image1. Prompt must reference @Image1.";
    }
    if (lumaModel === "happy-horse-image-to-video") {
      return "Uses only the selected edited start frame. No source working-range video is sent.";
    }
    if (lumaModel === "wan2.7-i2v") {
      return generationInputMode === "start_end"
        ? "Uses the selected edited start and end frames only. No source working-range video is sent."
        : "Uses only the selected edited start frame. No source working-range video is sent.";
    }
    if (lumaModel === "runway-gen4-aleph") {
      return "Uses the selected working-range video plus the selected edited start frame as an image reference. Prompt should describe the intended transformation while preserving motion and camera continuity. Runway may center-crop to the chosen output ratio.";
    }
    if (lumaModel === "sora-2-image-to-video") {
      return "Uses only the selected edited start frame. No source working-range video is sent.";
    }
    if (lumaModel === "wan2.2-a14b" || lumaModel === "runway-gen4.5") {
      return "Start frame variant is taken automatically from your Edit frames selection.";
    }
    if (lumaModel === "wan2.2-animate") {
      return "Wan2.2 Animate uses start frame + source working-range video. Text prompt is disabled in this flow unless LoRA inputs are used.";
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
    if (lumaModel === "happy-horse-video-edit") {
      return "change the horse into the white unicorn in @Image1 and keep the background and motion exactly the same";
    }
    if (lumaModel === "happy-horse-image-to-video") {
      return "Animate from this first frame with clear subject motion, stable background continuity and coherent camera movement.";
    }
    if (lumaModel === "wan2.7-i2v") {
      return generationInputMode === "start_end"
        ? "Animate from the first frame to the final frame with coherent camera motion and stable subject detail."
        : "Animate from this first frame with clear subject motion, camera motion and scene continuity.";
    }
    if (lumaModel === "runway-gen4-aleph") {
      return "Transform the horse into the white unicorn from the reference image while preserving camera movement, timing and background continuity.";
    }
    if (lumaModel === "sora-2-image-to-video") {
      return "Animate from this first frame with clear subject motion, camera motion and scene continuity.";
    }
    return "Optional generation prompt";
  }, [generationInputMode, lumaModel]);
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
    if (lumaModel === "happy-horse-video-edit") {
      if (!promptValue) return "Happy Horse 1.0 Video Edit requires a prompt that references @Image1.";
      if (!promptValue.includes("@Image1")) return "Happy Horse 1.0 Video Edit prompt must include @Image1.";
      return null;
    }
    if (lumaModel === "happy-horse-image-to-video" && !promptValue) {
      return "Happy Horse 1.0 Image to Video requires a prompt describing the intended motion from the first frame.";
    }
    if (lumaModel === "wan2.7-i2v" && !promptValue) {
      return generationInputMode === "start_end"
        ? "Wan 2.7 Image to Video requires a prompt describing the motion and the transition between the start and end frames."
        : "Wan 2.7 Image to Video requires a prompt describing the intended motion from the first frame.";
    }
    if (lumaModel === "runway-gen4-aleph" && !promptValue) {
      return "Runway Gen-4 Aleph requires a prompt describing the intended transformation.";
    }
    if (lumaModel === "sora-2-image-to-video" && !promptValue) {
      return "Sora 2 Image to Video requires a prompt describing the intended motion from the first frame.";
    }
    return null;
  }, [generationInputMode, lumaModel, lumaPrompt]);

  const editedFrameAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    if (!task || !selectedTaskId) return assets;
    for (const frame of Object.values(task.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.imageUrl) continue;
        assets.push({
          id: `variant:${selectedTaskId}:${frame.frameId}:${variant.variantId}`,
          taskId: selectedTaskId,
          title: humanizeFilename(keyBasenameFromS3Key(variant.outputKey)),
          subtitle: `${task.name} · frame ${frame.frameIndex} · ${variant.model}/${variant.type}`,
          createdAt: variant.createdAt,
          previewUrl: variant.imageUrl,
          downloadUrl: variant.imageUrl,
          mediaType: "image",
          customReportRef: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
          deletePayload: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
        });
      }
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [keyBasenameFromS3Key, selectedTaskId, task]);

  const generatedVideoAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    if (!task || !selectedTaskId) return assets;
    for (const generation of Object.values(task.segmentGenerations ?? {})) {
      if (generation.status === "failed") continue;
      if (!generation.downloadUrl) continue;
      if (generation.isChunkInternal) continue;
      assets.push({
        id: `generation:${selectedTaskId}:${generation.genId}`,
        taskId: selectedTaskId,
        title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
        subtitle: `${task.name} · ${generation.luma.model} · ${generation.luma.mode}${generation.manualUpload ? " · manual upload" : ""}`,
        createdAt: generation.createdAt,
        previewUrl: generation.downloadUrl,
        downloadUrl: generation.downloadUrl,
        thumbnailUrl: generationThumbnailUrl(generation) ?? undefined,
        mediaType: "video",
        customReportRef: { assetType: "segment_generation", genId: generation.genId },
        deletePayload: { assetType: "segment_generation", genId: generation.genId },
      });
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [generationThumbnailUrl, keyBasenameFromS3Key, selectedTaskId, task]);

  const mergedVideoAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    if (!task || !selectedTaskId) return assets;
    for (const exportItem of task.exports ?? []) {
      if (!exportItem.downloadUrl) continue;
      assets.push({
        id: `export:${selectedTaskId}:${exportItem.exportId}`,
        taskId: selectedTaskId,
        title: humanizeFilename(keyBasenameFromS3Key(exportItem.outputKey || `${exportItem.exportId}.mp4`)),
        subtitle: `${task.name} · merged export`,
        createdAt: exportItem.createdAt,
        previewUrl: exportItem.downloadUrl,
        downloadUrl: exportItem.downloadUrl,
        mediaType: "video",
        customReportRef: { assetType: "export", exportId: exportItem.exportId },
        deletePayload: { assetType: "export", exportId: exportItem.exportId },
      });
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [keyBasenameFromS3Key, selectedTaskId, task]);

  const libraryEditedFrameAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      for (const frame of Object.values(taskItem.frames ?? {})) {
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

  const libraryGeneratedVideoAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      for (const generation of Object.values(taskItem.segmentGenerations ?? {})) {
        if (generation.status === "failed" || generation.isChunkInternal || !generation.downloadUrl) continue;
        assets.push({
          id: `generation:${taskItem.taskId}:${generation.genId}`,
          taskId: taskItem.taskId,
          title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
          subtitle: `${taskItem.name} · ${generation.luma.model} · ${generation.luma.mode}${generation.manualUpload ? " · manual upload" : ""}`,
          createdAt: generation.createdAt,
          previewUrl: generation.downloadUrl,
          downloadUrl: generation.downloadUrl,
          thumbnailUrl: generationThumbnailUrl(generation) ?? undefined,
          mediaType: "video",
          customReportRef: { assetType: "segment_generation", genId: generation.genId },
          deletePayload: { assetType: "segment_generation", genId: generation.genId },
        });
      }
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks, generationThumbnailUrl, keyBasenameFromS3Key]);

  const libraryMergedVideoAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      for (const exportItem of taskItem.exports ?? []) {
        if (!exportItem.downloadUrl) continue;
        assets.push({
          id: `export:${taskItem.taskId}:${exportItem.exportId}`,
          taskId: taskItem.taskId,
          title: humanizeFilename(keyBasenameFromS3Key(exportItem.outputKey || `${exportItem.exportId}.mp4`)),
          subtitle: `${taskItem.name} · merged export`,
          createdAt: exportItem.createdAt,
          previewUrl: exportItem.downloadUrl,
          downloadUrl: exportItem.downloadUrl,
          mediaType: "video",
          customReportRef: { assetType: "export", exportId: exportItem.exportId },
          deletePayload: { assetType: "export", exportId: exportItem.exportId },
        });
      }
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks, keyBasenameFromS3Key]);

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
    if (!task?.video?.editSource?.downloadUrl) return null;
    return task.video.editSource.downloadUrl;
  }, [selectedSegment?.segmentClipUrl, task?.video?.editSource?.downloadUrl]);
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
  const timelinePlaybackUrl = task?.video?.previewSource?.downloadUrl ?? task?.video?.editSource?.downloadUrl ?? "";

  useEffect(() => {
    if (mergeInsertStartFrame !== mergeInsertStartFrameClamped) {
      setMergeInsertStartFrame(mergeInsertStartFrameClamped);
    }
    if (mergeTrimStartFrames !== mergeTrimStartUserClamped) {
      setMergeTrimStartFrames(mergeTrimStartUserClamped);
    }
    if (mergeTrimEndFrames !== mergeTrimEndClamped) {
      setMergeTrimEndFrames(mergeTrimEndClamped);
    }
  }, [
    mergeInsertStartFrame,
    mergeInsertStartFrameClamped,
    mergeInsertStartFrameLowerBound,
    mergeInsertStartFrameUpperBound,
    mergeTrimEndClamped,
    mergeTrimEndFrames,
    mergeTrimStartClamped,
    mergeTrimStartUserClamped,
    mergeTrimStartFrames,
  ]);

  useEffect(() => {
    setMergeAlignmentSuggestion(null);
    setMergeAlignmentSuggestionJobId(null);
    setMergeAlignmentSuggestionError(null);
    setReconcileTimingJobId(null);
    setReconcileTimingError(null);
    setMergeApplyRetime(false);
    setMergePlaybackRate(1);
  }, [mergeTargetGeneration?.genId]);

  useEffect(() => {
    const state = mergeTargetGeneration?.mergeAlignmentSuggestion;
    if (!state || typeof state !== "object") return;
    const stateJobStatus = state.jobId ? jobStatusById.get(state.jobId) : undefined;
    if (
      (state.status === "queued" || state.status === "running") &&
      state.jobId &&
      stateJobStatus !== "complete" &&
      stateJobStatus !== "failed" &&
      (!mergeAlignmentSuggestionJobId || state.jobId === mergeAlignmentSuggestionJobId)
    ) {
      setMergeAlignmentSuggestionJobId(state.jobId);
      setMergeAlignmentSuggestionError(null);
      return;
    }
    if (
      state.status === "complete" &&
      state.suggestion &&
      (mergeAlignmentSuggestionJobId ? state.jobId === mergeAlignmentSuggestionJobId : !mergeAlignmentSuggestion)
    ) {
      const segmentStartFrame = mergeTargetSegment?.startFrame ?? 0;
      setMergeInsertStartFrame(state.suggestion.suggested.startFrameOverride - segmentStartFrame);
      setMergeTrimStartFrames(state.suggestion.suggested.trimStartFrames);
      setMergeTrimEndFrames(state.suggestion.suggested.trimEndFrames);
      setMergePlaybackRate(state.suggestion.analysis.suggestedPlaybackRate || 1);
      setMergeApplyRetime(state.suggestion.analysis.recommendation === "retime_recommended");
      setMergeAlignmentSuggestion(state.suggestion);
      setMergeAlignmentSuggestionJobId(null);
      setMergeAlignmentSuggestionError(null);
      return;
    }
    if (state.status === "failed" && (!mergeAlignmentSuggestionJobId || state.jobId === mergeAlignmentSuggestionJobId)) {
      setMergeAlignmentSuggestionJobId(null);
      setMergeAlignmentSuggestionError(state.error || "Alignment suggestion failed");
    }
  }, [
    jobStatusById,
    mergeAlignmentSuggestion,
    mergeAlignmentSuggestionJobId,
    mergeTargetSegment?.startFrame,
    mergeTargetGeneration?.mergeAlignmentSuggestion,
    setMergeInsertStartFrame,
    setMergeTrimEndFrames,
    setMergeTrimStartFrames,
  ]);

  useEffect(() => {
    if (!mergeAlignmentSuggestionJobId || !mergeAlignmentSuggestionJob) return;
    if (mergeAlignmentSuggestionJob.status === "failed") {
      setMergeAlignmentSuggestionJobId(null);
      setMergeAlignmentSuggestionError(mergeAlignmentSuggestionJob.error || "Alignment suggestion failed");
      return;
    }
    if (mergeAlignmentSuggestionJob.status !== "complete") return;
    const result = mergeAlignmentSuggestionJob.resultRefs?.suggestion;
    if (!result || typeof result !== "object") {
      setMergeAlignmentSuggestionJobId(null);
      setMergeAlignmentSuggestionError("Alignment suggestion completed without a result payload");
      return;
    }
    const suggestion = result as NonNullable<typeof mergeAlignmentSuggestion>;
    const segmentStartFrame = mergeTargetSegment?.startFrame ?? 0;
    setMergeInsertStartFrame(suggestion.suggested.startFrameOverride - segmentStartFrame);
    setMergeTrimStartFrames(suggestion.suggested.trimStartFrames);
    setMergeTrimEndFrames(suggestion.suggested.trimEndFrames);
    setMergePlaybackRate(suggestion.analysis.suggestedPlaybackRate || 1);
    setMergeApplyRetime(suggestion.analysis.recommendation === "retime_recommended");
    setMergeAlignmentSuggestion(suggestion);
    setMergeAlignmentSuggestionJobId(null);
    setMergeAlignmentSuggestionError(null);
  }, [
    mergeAlignmentSuggestionJob,
    mergeAlignmentSuggestionJobId,
    mergeTargetSegment?.startFrame,
    setMergeInsertStartFrame,
    setMergeTrimEndFrames,
    setMergeTrimStartFrames,
  ]);

  useEffect(() => {
    const state = mergeTargetGeneration?.timingReconcile;
    if (!state || typeof state !== "object") return;
    const stateJobStatus = state.jobId ? jobStatusById.get(state.jobId) : undefined;
    if (
      (state.status === "queued" || state.status === "running") &&
      state.jobId &&
      stateJobStatus !== "complete" &&
      stateJobStatus !== "failed" &&
      (!reconcileTimingJobId || state.jobId === reconcileTimingJobId)
    ) {
      setReconcileTimingJobId(state.jobId);
      setReconcileTimingError(null);
      return;
    }
    if (state.status === "failed" && (!reconcileTimingJobId || state.jobId === reconcileTimingJobId)) {
      setReconcileTimingJobId(null);
      setReconcileTimingError(state.error || "Timing reconcile failed");
    }
  }, [jobStatusById, mergeTargetGeneration?.timingReconcile, reconcileTimingJobId]);

  useEffect(() => {
    if (!reconcileTimingJobId || !reconcileTimingJob) return;
    if (reconcileTimingJob.status === "failed") {
      setReconcileTimingJobId(null);
      setReconcileTimingError(reconcileTimingJob.error || "Timing reconcile failed");
      return;
    }
    if (reconcileTimingJob.status !== "complete") return;
    const reconciledGenId = typeof reconcileTimingJob.resultRefs?.genId === "string" ? reconcileTimingJob.resultRefs.genId : null;
    if (reconciledGenId) {
      selectSegmentGeneration(reconciledGenId);
    }
    setReconcileTimingJobId(null);
    setReconcileTimingError(null);
  }, [reconcileTimingJob, reconcileTimingJobId, selectSegmentGeneration]);

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
    const manualLabel = generation.manualUpload ? " · manual upload" : "";
    return `${outputLabel} · ${generation.luma.model}/${generation.luma.mode}${manualLabel} · ${segmentText} · ${formatCompactTimestamp(generation.createdAt)}`;
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
          "Uses the working-range video plus the selected edited start frame.",
          "Prompt must include both <<<video_1>>> and <<<image_1>>>.",
          'Example: "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. Keep motion and background the same."',
        ],
      };
    }
    if (modelName === "kling-v3-omni-video") {
      return {
        title: "Kling v3 Omni Video",
        lines: [
          "Uses the working-range video plus the selected edited start frame.",
          "Prompt must include both <<<video_1>>> and <<<image_1>>>.",
          'Example: "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. Keep motion and background the same."',
        ],
      };
    }
    if (modelName === "seedance-2.0-reference-to-video") {
      return {
        title: "Seedance 2.0 Reference to Video",
        lines: [
          "Uses the working-range video as @Video1 and the selected edited start frame as @Image1.",
          "Prompt must include both @Video1 and @Image1.",
          "The app conforms the input to Seedance reference-video bounds, then scales the result back to the working range.",
          'Example: "Transform the horse in @Video1 into the unicorn in @Image1. Keep motion and background the same."',
        ],
      };
    }
    if (modelName === "wan2.7-videoedit") {
      return {
        title: "Wan 2.7 VideoEdit",
        lines: [
          "Uses the working-range video plus the selected edited start frame.",
          "Prompt should focus on the visual change, not restate motion or camera behavior.",
          "Resolution can be 720p or 1080p.",
        ],
      };
    }
    if (modelName === "happy-horse-video-edit") {
      return {
        title: "Happy Horse 1.0 Video Edit",
        lines: [
          "Uses the working-range video plus the selected edited start frame as @Image1.",
          "Prompt must include @Image1.",
          'Example: "change the horse into the white unicorn in @Image1 and keep the background and motion exactly the same".',
        ],
      };
    }
    if (modelName === "happy-horse-image-to-video") {
      return {
        title: "Happy Horse 1.0 Image to Video",
        lines: [
          "Uses only the selected start frame and prompt. No source working-range video is sent.",
          "Resolution can be set to 720p or 1080p.",
          "Happy Horse supports clips from 3 to 15 seconds in this flow.",
        ],
      };
    }
    if (modelName === "wan2.7-i2v") {
      return {
        title: inputMode === "start_end" ? "Wan 2.7 Image to Video (Start/End)" : "Wan 2.7 Image to Video",
        lines: [
          inputMode === "start_end"
            ? "Uses the selected start and end frames only. No source working-range video is sent."
            : "Uses the selected start frame only. No source working-range video is sent.",
          "Supports an optional negative prompt plus 720p or 1080p output. This app caps the path at 10 seconds.",
          inputMode === "start_end"
            ? "Best prompt style: describe how motion develops from the start frame into the supplied end frame while keeping camera motion coherent."
            : "Best prompt style: describe the subject motion, camera movement and scene continuity clearly from the first frame.",
        ],
      };
    }
    if (modelName === "kling-2.6") {
      return {
        title: inputMode === "start_only" ? "Kling 2.6 (Start Frame)" : "Kling 2.6 Start/End",
        lines: [
          inputMode === "start_only"
            ? "Uses only the selected start frame in this tab. It does not use source working-range video."
            : "Uses start frame + end frame + working-range duration. It does not use the source working-range video for motion.",
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
          "Uses only the selected start frame as the initial frame. It does not use source working-range motion.",
          "Best prompt style: describe the motion and evolution from frame one while preserving composition.",
          "Avoid conflicting scene changes in one prompt; short and specific prompts usually hold frame identity better.",
        ],
      };
    }
    if (modelName === "sora-2-image-to-video") {
      return {
        title: "Sora 2 Image to Video",
        lines: [
          "Uses only the selected start frame. No source working-range video is sent.",
          "Resolution can be auto, 720p or 1080p. This app exposes up to 10 seconds in the UI and trims longer provider outputs back to the requested duration when needed.",
          "Best prompt style: describe the motion, camera movement and continuity from the first frame clearly and concretely.",
        ],
      };
    }
    if (modelName === "runway-gen4-aleph") {
      return {
        title: "Runway Gen-4 Aleph",
        lines: [
          "Uses the working-range video plus the selected edited start frame as an image reference.",
          "Prompts work best when they start with a clear verb and reference the first frame.",
          'Example: "edit the video to start on the input image as the first frame. add motion so that the car floats weightlessly, as if in zero gravity, throughout the video".',
          "Runway may center-crop to fit supported output ratios.",
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
            ? "Uses only the selected start frame in this tab. No source working-range video is sent."
            : "Uses selected start and end frames as keyframes. No source working-range video is sent.",
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
          "Uses the start frame as the anchor image; this flow does not consume the source working-range video.",
          "Prompt tips: describe camera motion and subject movement clearly, keep style constraints concise and specific.",
        ],
      };
    }
    return {
      title: modelName === "ray-flash-2" ? "Luma Ray Flash 2" : "Luma Ray 2",
      lines: [
        "Uses the working-range video plus the selected edited start frame.",
        "Luma modes: adhere = closest to source, flex = moderate change, reimagine = strongest change.",
        `Current mode: ${modeValue}. Use lower modes for continuity and higher modes for stronger visual change.`,
      ],
    };
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

      const imageModels: Array<{ model: "nano_banana_pro" | "chatgpt" | "chatgpt_latest"; label: string }> = [
        { model: "nano_banana_pro", label: "Nano Banana Pro" },
        { model: "chatgpt", label: "ChatGPT-image 1.5" },
        { model: "chatgpt_latest", label: "ChatGPT-image 2.0" },
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
              mode: option.mode as VideoModeId,
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
      setSegmentDraftActive(false);
      setSegmentDraftFallbackId(existing.segmentId);
      return existing.segmentId;
    }
    const created = await createSegmentMutation.mutateAsync({
      startFrameIndex: selectedRange.startFrame,
      endFrameExclusive: selectedRange.endFrameExclusive,
    });
    setSelectedSegmentId(created.segmentId);
    setSegmentDraftActive(false);
    setSegmentDraftFallbackId(created.segmentId);
    await taskQuery.refetch();
    return created.segmentId;
  }

  async function ensureDefaultVideoSegment(): Promise<string | null> {
    if (!task) return null;
    if (defaultVideoSegment) {
      setSelectedSegmentId(defaultVideoSegment.segmentId);
      setSegmentDraftActive(false);
      setSegmentDraftFallbackId(defaultVideoSegment.segmentId);
      return defaultVideoSegment.segmentId;
    }
    const totalFrames = frameCount(task);
    if (!totalFrames) return null;
    const created = await createSegmentMutation.mutateAsync({
      startFrameIndex: 0,
      endFrameExclusive: totalFrames,
    });
    setSelectedSegmentId(created.segmentId);
    setSegmentDraftActive(false);
    setSegmentDraftFallbackId(created.segmentId);
    await taskQuery.refetch();
    return created.segmentId;
  }

  async function chooseWholeVideoWorkMode() {
    const segmentId = await ensureDefaultVideoSegment();
    if (!segmentId) {
      throw new Error("Full video range is not ready yet.");
    }
    const defaultSegment = task?.segments.find((segment) => segment.segmentId === segmentId) ?? defaultVideoSegment;
    if (defaultSegment) {
      setFirstFrameId(defaultSegment.startFrameId);
      setLastFrameId(defaultSegment.endFrameId);
      setCurrentFrameIndex(defaultSegment.startFrame);
    }
    setSegmentDraftActive(false);
    setSegmentDraftFallbackId(segmentId);
    setVideoWorkMode("whole_video");
    setTab("frames");
  }

  function cancelWorkingRangeDraft() {
    const fallbackSegment =
      (segmentDraftFallbackId && task?.segments.find((segment) => segment.segmentId === segmentDraftFallbackId)) ??
      defaultVideoSegment ??
      null;
    if (fallbackSegment) {
      setSelectedSegmentId(fallbackSegment.segmentId);
      setFirstFrameId(fallbackSegment.startFrameId);
      setLastFrameId(fallbackSegment.endFrameId);
      setCurrentFrameIndex(fallbackSegment.startFrame);
      setVideoWorkMode(
        totalVideoFrames > 0 && fallbackSegment.startFrame === 0 && fallbackSegment.endFrameExclusive === totalVideoFrames
          ? "whole_video"
          : "custom_segment",
      );
    } else {
      setSelectedSegmentId(null);
      setVideoWorkMode(null);
    }
    setSegmentDraftActive(false);
  }

  function chooseCustomSegmentWorkMode() {
    setVideoWorkMode("custom_segment");
    setSegmentDraftActive(true);
    setSegmentDraftFallbackId(selectedSegmentId ?? defaultVideoSegment?.segmentId ?? null);
    setSelectedSegmentId(null);
    if (defaultVideoSegment) {
      setFirstFrameId(defaultVideoSegment.startFrameId);
      setLastFrameId(defaultVideoSegment.endFrameId);
      setCurrentFrameIndex(defaultVideoSegment.startFrame);
    }
  }

  function beginCustomSegmentEdit() {
    setVideoWorkMode("custom_segment");
    setSegmentDraftActive(true);
    setSegmentDraftFallbackId(selectedSegmentId ?? segmentDraftFallbackId ?? defaultVideoSegment?.segmentId ?? null);
    if (selectedSegmentId) {
      setSelectedSegmentId(null);
    }
    if (selectedSegment) {
      setFirstFrameId((current) => current ?? selectedSegment.startFrameId);
      setLastFrameId((current) => current ?? selectedSegment.endFrameId);
      setCurrentFrameIndex(selectedSegment.startFrame);
    }
  }

  const saveSegmentCrop = useCallback(
    async (crop: { aspect: "16:9" | "9:16"; x: number; y: number; width: number; height: number; featherPx?: number } | null) => {
      if (!selectedTaskId) throw new Error("Select a task first.");
      let sourceSegment = selectedSegment;
      if (!sourceSegment) {
        const segmentId = await ensureSegmentForSelectedFrames();
        if (!segmentId) {
          throw new Error("You need to pick start and end frames before cropping.");
        }
        sourceSegment = task?.segments.find((segment) => segment.segmentId === segmentId) ?? null;
      }
      if (!sourceSegment) {
        throw new Error("Working range not found.");
      }
      const normalizedCrop = crop
        ? {
            aspect: crop.aspect,
            x: crop.x,
            y: crop.y,
            width: crop.width,
            height: crop.height,
            featherPx: crop.featherPx,
          }
        : null;
      const sameRangeSegments = (task?.segments ?? []).filter(
        (segment) =>
          !segment.internalOnly &&
          segment.startFrame === sourceSegment?.startFrame &&
          segment.endFrameExclusive === sourceSegment?.endFrameExclusive,
      );
      const existing = sameRangeSegments.find((segment) => {
        const segmentCrop = segment.crop?.enabled ? segment.crop : null;
        if (!normalizedCrop && !segmentCrop) return true;
        if (!normalizedCrop || !segmentCrop) return false;
        return (
          segmentCrop.aspect === normalizedCrop.aspect &&
          segmentCrop.x === normalizedCrop.x &&
          segmentCrop.y === normalizedCrop.y &&
          segmentCrop.width === normalizedCrop.width &&
          segmentCrop.height === normalizedCrop.height &&
          (segmentCrop.featherPx ?? 0) === (normalizedCrop.featherPx ?? 0)
        );
      });
      if (existing) {
        setSelectedSegmentId(existing.segmentId);
        setFirstFrameId(existing.startFrameId);
        setLastFrameId(existing.endFrameId);
        setCurrentFrameIndex(existing.startFrame);
        return existing.segmentId;
      }
      if (!normalizedCrop) {
        return sourceSegment.segmentId;
      }
      const created = await apiClient.createSegment(selectedTaskId, {
        startFrameIndex: sourceSegment.startFrame,
        endFrameExclusive: sourceSegment.endFrameExclusive,
      });
      const patched = await saveSegmentCropMutation.mutateAsync({ segmentId: created.segmentId, crop: normalizedCrop });
      const resolvedSegment = patched.segment ?? task?.segments.find((segment) => segment.segmentId === created.segmentId) ?? null;
      if (resolvedSegment?.segmentId) {
        setSelectedSegmentId(resolvedSegment.segmentId);
        setFirstFrameId(resolvedSegment.startFrameId);
        setLastFrameId(resolvedSegment.endFrameId);
        setCurrentFrameIndex(resolvedSegment.startFrame);
        return resolvedSegment.segmentId;
      }
      return created.segmentId;
    },
    [ensureSegmentForSelectedFrames, saveSegmentCropMutation, selectedSegment, selectedTaskId, setCurrentFrameIndex, task?.segments],
  );

  async function handleTabChange(nextTab: TabId) {
    if (nextTab === tab) return;
    if (tab === "timeline" && nextTab !== "timeline" && nextTab !== "report" && nextTab !== "custom_qc" && nextTab !== "api_logs" && nextTab !== "asset_library") {
      const shouldUseWholeVideo = videoWorkMode !== "custom_segment" || (!selectedSegmentId && !selectedRange);
      if (shouldUseWholeVideo) {
        try {
          await ensureDefaultVideoSegment();
          if (videoWorkMode !== "whole_video") {
            setVideoWorkMode("whole_video");
          }
        } catch (error) {
          setAppUiError(error instanceof Error ? error.message : "Failed to prepare the full video range.");
          return;
        }
      } else {
        if (selectedSegmentId) {
          setSegmentDraftActive(false);
          setVideoWorkMode("custom_segment");
        } else {
          if (!selectedRange) {
            const fallbackSegment =
              (segmentDraftFallbackId && task?.segments.find((segment) => segment.segmentId === segmentDraftFallbackId)) ?? null;
            if (fallbackSegment) {
              setSelectedSegmentId(fallbackSegment.segmentId);
              setFirstFrameId(fallbackSegment.startFrameId);
              setLastFrameId(fallbackSegment.endFrameId);
              setCurrentFrameIndex(fallbackSegment.startFrame);
              setSegmentDraftActive(false);
              setVideoWorkMode(
                totalVideoFrames > 0 && fallbackSegment.startFrame === 0 && fallbackSegment.endFrameExclusive === totalVideoFrames
                  ? "whole_video"
                  : "custom_segment",
              );
            } else {
              try {
                await ensureDefaultVideoSegment();
                setVideoWorkMode("whole_video");
              } catch (error) {
                setAppUiError(error instanceof Error ? error.message : "Failed to prepare the full video range.");
                return;
              }
            }
          } else {
            const fallbackSegment =
              (segmentDraftFallbackId && task?.segments.find((segment) => segment.segmentId === segmentDraftFallbackId)) ?? null;
            if (
              fallbackSegment &&
              fallbackSegment.startFrame === selectedRange.startFrame &&
              fallbackSegment.endFrameExclusive === selectedRange.endFrameExclusive
            ) {
              setSelectedSegmentId(fallbackSegment.segmentId);
              setSegmentDraftActive(false);
              setVideoWorkMode(
                totalVideoFrames > 0 && fallbackSegment.startFrame === 0 && fallbackSegment.endFrameExclusive === totalVideoFrames
                  ? "whole_video"
                  : "custom_segment",
              );
            } else {
              try {
                await ensureSegmentForSelectedFrames();
                setVideoWorkMode("custom_segment");
              } catch (error) {
                setAppUiError(error instanceof Error ? error.message : "Failed to create segment from selected frames.");
                return;
              }
            }
          }
        }
      }
    }
    setTab(nextTab);
  }

  function selectCompareCandidate(frameId: string, tabKey: "first" | "last", candidate: EditFrameCandidate) {
    const isRefined = candidate.kind === "variant" && candidate.variant?.variantKind === "refined";
    const sourceVariantId = candidate.kind === "variant" ? candidate.variantId ?? null : null;
    const parentVariantId = candidate.kind === "variant" ? candidate.variant?.sourceVariantId ?? null : null;
    setCompareVariantIds((previous) => ({
      ...previous,
      [tabKey]: candidate.kind === "original" ? null : isRefined ? parentVariantId : sourceVariantId,
    }));
    setRefineSourceVariantIds((previous) => ({
      ...previous,
      [tabKey]: candidate.kind === "variant" && isRefined ? sourceVariantId : null,
    }));
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

  async function uploadManualEditedFrame(tabKey: "first" | "last", file: File): Promise<string> {
    if (!selectedTaskId) throw new Error("No task selected");
    const frameRecord = tabKey === "first" ? editFirstFrame : editLastFrame;
    if (!frameRecord?.frameId) throw new Error("No source frame selected");
    const init = await apiClient.initManualFrameUpload(selectedTaskId, frameRecord.frameId, {
      filename: file.name,
      contentType: file.type || "image/png",
    });
    const uploadResponse = await fetch(init.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }
    const completed = await apiClient.completeManualFrameUpload(selectedTaskId, frameRecord.frameId, {
      uploadKey: init.uploadKey,
      filename: file.name,
    });
    setCompareVariantIds((previous) => ({ ...previous, [tabKey]: completed.variant.variantId ?? previous[tabKey] }));
    setRefineSourceVariantIds((previous) => ({ ...previous, [tabKey]: null }));
    setEditSourceVariantIds((previous) => ({ ...previous, [tabKey]: completed.variant.variantId ?? previous[tabKey] }));
    await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    return completed.variant.variantId;
  }

  async function uploadManualGeneratedVideo(file: File): Promise<string> {
    if (!selectedTaskId) throw new Error("No task selected");
    if (!selectedSegmentId) throw new Error("No working range selected");
    const init = await apiClient.initManualSegmentGenerationUpload(selectedTaskId, selectedSegmentId, {
      filename: file.name,
      contentType: file.type || "video/mp4",
    });
    const uploadResponse = await fetch(init.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }
    const trimmedPrompt = lumaPrompt.trim();
    const completed = await apiClient.completeManualSegmentGenerationUpload(selectedTaskId, selectedSegmentId, {
      uploadKey: init.uploadKey,
      filename: file.name,
      model: lumaModel,
      mode: resolveSelectedGenerationMode(),
      prompt: lumaModel === "wan2.2-animate" ? undefined : trimmedPrompt || undefined,
      negativePrompt: lumaModel === "wan2.7-i2v" ? wan27NegativePrompt.trim() || undefined : undefined,
      firstFrameVariantId: refineSourceVariantIds.first || compareVariantIds.first || undefined,
      lastFrameVariantId: generationInputMode === "start_end" ? refineSourceVariantIds.last || compareVariantIds.last || undefined : undefined,
    });
    await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    if (completed.generation?.genId) {
      selectSegmentGeneration(completed.generation.genId);
      setTab("outputs");
      return completed.generation.genId;
    }
    throw new Error("Uploaded video did not return a generation id");
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
        clearCustomReportOutputs(item.taskId, [item.customReportRef]);
      }
    } catch (error) {
      setAppUiError(error instanceof Error ? error.message : "Failed to delete asset");
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
  const primaryTabs: Array<{ id: PrimaryWorkflowSection; label: string }> = [
    { id: "source", label: "Select" },
    { id: "create", label: "Edit" },
    { id: "outputs", label: "Generate" },
    { id: "post", label: "Post Process" },
    { id: "assets", label: "Assets" },
    { id: "reports", label: "Reports" },
  ];
  const currentReferenceSegment = selectedSegment ?? defaultVideoSegment ?? null;
  const currentReferenceStartImageUrl = currentReferenceSegment ? task?.frames?.[currentReferenceSegment.startFrameId]?.imageUrl ?? null : null;
  const currentReferenceEndImageUrl = currentReferenceSegment ? task?.frames?.[currentReferenceSegment.endFrameId]?.imageUrl ?? null : null;
  const currentReferenceAssets = useMemo(() => {
    const assets: Array<{ label: string; imageUrl?: string | null; videoUrl?: string | null; posterUrl?: string | null }> = [];
    const useGenerationBoundInputs =
      (activeWorkflowSection === "outputs" || activeWorkflowSection === "post") && Boolean(selectedPreviewGeneration);
    const firstFrameVariantId = useGenerationBoundInputs
      ? selectedPreviewGeneration?.sourceFirstFrameVariantId ?? null
      : refineSourceVariantIds.first || compareVariantIds.first;
    const lastFrameVariantId = useGenerationBoundInputs
      ? selectedPreviewGeneration?.sourceLastFrameVariantId ?? null
      : refineSourceVariantIds.last || compareVariantIds.last;
    const firstFrameEditUrl = frameVariantImageUrl(editFirstFrame?.frameId, firstFrameVariantId);
    const lastFrameEditUrl =
      generationInputMode === "start_end" ? frameVariantImageUrl(editLastFrame?.frameId, lastFrameVariantId) : null;

    if (firstFrameEditUrl) {
      assets.push({ label: "First frame edit", imageUrl: firstFrameEditUrl });
    }
    if (lastFrameEditUrl) {
      assets.push({ label: "Last frame edit", imageUrl: lastFrameEditUrl });
    }
    if (selectedPreviewGeneration?.downloadUrl) {
      assets.push({
        label: "Generated video",
        videoUrl: selectedPreviewGeneration.downloadUrl,
        posterUrl: generationThumbnailUrl(selectedPreviewGeneration),
      });
    }
    return assets;
  }, [
    compareVariantIds.first,
    compareVariantIds.last,
    editFirstFrame?.frameId,
    editLastFrame?.frameId,
    frameVariantImageUrl,
    generationInputMode,
    generationThumbnailUrl,
    activeWorkflowSection,
    refineSourceVariantIds.first,
    refineSourceVariantIds.last,
    selectedPreviewGeneration,
  ]);
  const currentReferenceWarning =
    wholeVideoNeedsChunking && currentReferenceSegment?.segmentId === defaultVideoSegment?.segmentId
      ? "This video is longer than single-pass generation limit and will require chunking."
      : undefined;

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
      generationInputMode,
      lumaModel,
      videoWorkMode,
      defaultVideoSegment,
      wholeVideoNeedsChunking,
      wholeVideoSinglePassLimitSeconds: WHOLE_VIDEO_SINGLE_PASS_LIMIT_SECONDS,
      onChooseWholeVideo: () => {
        void chooseWholeVideoWorkMode();
      },
      onChooseCustomSegment: chooseCustomSegmentWorkMode,
      onBeginCustomSegmentEdit: beginCustomSegmentEdit,
      onCancelWorkingRangeDraft: cancelWorkingRangeDraft,
      onContinueToEditFrames: () => {
        void handleTabChange("frames");
      },
      selectedSegmentId,
      selectedSegment,
      segmentDraftFallbackAvailable: Boolean(segmentDraftFallbackId),
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
      generationInputMode,
      lumaModel,
      videoWorkMode,
      defaultVideoSegment,
      wholeVideoNeedsChunking,
      selectedSegmentId,
      selectedSegment,
      segmentDraftFallbackId,
      chooseCustomSegmentWorkMode,
      beginCustomSegmentEdit,
      cancelWorkingRangeDraft,
      chooseWholeVideoWorkMode,
      handleTabChange,
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
      allowEndFrameTab: generationModeConfig.requiresEndFrame,
      openRefineModalForVariant: (variantId) => {
        openQualityMatchForVariant(activeEditFrame, variantId);
      },
      onNext: () => {
        void handleTabChange("outputs");
      },
      nextWarning: missingRouteInputsMessage,
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
      refreshPatchOverlay: () => renderPatchOverlay(),
      formatCompactTimestamp,
    }),
    [
      generationModeConfig.requiresEndFrame,
      activeEditFrame,
      handleTabChange,
      missingRouteInputsMessage,
      editFrameTab,
      activeEditFrame,
      prompt,
      model,
      fullEditMutation,
      activeEditSourceImageUrl,
      activeEditCandidates,
      selectCompareCandidate,
      setImageCompareModal,
      selectedTaskId,
      uploadManualEditedFrame,
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
      allowEndFrameTab: generationModeConfig.requiresEndFrame,
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
      generationModeConfig.requiresEndFrame,
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
      viewMode: "outputs",
      onNext: () => {
        void handleTabChange("merge");
      },
      nextDisabled: !selectedPreviewGeneration || selectedPreviewGeneration.status !== "complete" || !selectedPreviewGeneration.downloadUrl,
      nextWarning:
        !selectedPreviewGeneration || selectedPreviewGeneration.status !== "complete" || !selectedPreviewGeneration.downloadUrl
          ? "Choose a completed output before continuing to Post Process."
          : null,
      generationModelByInput,
      generationInputMode,
      selectedSegment,
      isWholeVideoSelection,
      wholeVideoNeedsChunking,
      wholeVideoSinglePassLimitSeconds: WHOLE_VIDEO_SINGLE_PASS_LIMIT_SECONDS,
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
      happyHorseResolution,
      setHappyHorseResolution,
      wan27NegativePrompt,
      setWan27NegativePrompt,
      sora2Resolution,
      setSora2Resolution,
      preserveFrames,
      setPreserveFrames,
      lumaPrompt,
      setLumaPrompt,
      lumaContinuationPrompt,
      setLumaContinuationPrompt,
      generationPromptPlaceholder,
      generationPromptError,
      missingRouteInputsMessage,
      generationInputNote,
      generationHelp,
      selectedSegmentOverLimit,
      selectedSegmentLimitMessage,
      selectedSegmentId,
      generateSegmentMutation,
      generateChunkedSegmentMutation,
      selectedSegmentChunkedGenerationRuns,
      pauseChunkedGeneration: pauseChunkedGenerationMutation.mutate,
      resumeChunkedGeneration: resumeChunkedGenerationMutation.mutate,
      restartChunkedGeneration: restartChunkedGenerationMutation.mutate,
      saveChunkedGenerationDraft: saveChunkedGenerationDraftMutation.mutate,
      cancelChunkedGeneration: cancelChunkedGenerationMutation.mutate,
      isChunkedGenerationMutationPending:
        generateChunkedSegmentMutation.isPending ||
        pauseChunkedGenerationMutation.isPending ||
        resumeChunkedGenerationMutation.isPending ||
        restartChunkedGenerationMutation.isPending ||
        saveChunkedGenerationDraftMutation.isPending ||
        cancelChunkedGenerationMutation.isPending,
      frameVariantImageUrl,
      segmentWindow,
      originalSegmentPreviewUrl: stableOriginalSegmentPreviewUrl,
      uploadManualGeneratedVideo,
      selectedPreviewGeneration,
      task,
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
      setVideoCompareModal,
      openVideoCleanupModal: openVideoCleanupModalForGeneration,
      onAssetError: () => refreshSignedUrlsForTask(selectedTaskId),
      handleDeleteAsset,
      setGenerationCardsVisible,
    }),
    [
      handleTabChange,
      generationModelByInput,
      generationInputMode,
      selectedSegment,
      isWholeVideoSelection,
      wholeVideoNeedsChunking,
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
      happyHorseResolution,
      wan27NegativePrompt,
      sora2Resolution,
      preserveFrames,
      lumaPrompt,
      lumaContinuationPrompt,
      generationPromptPlaceholder,
      generationPromptError,
      missingRouteInputsMessage,
      generationInputNote,
      generationHelp,
      selectedSegmentOverLimit,
      selectedSegmentLimitMessage,
      selectedSegmentId,
      generateSegmentMutation,
      generateChunkedSegmentMutation,
      selectedSegmentChunkedGenerationRuns,
      pauseChunkedGenerationMutation.mutate,
      resumeChunkedGenerationMutation.mutate,
      restartChunkedGenerationMutation.mutate,
      saveChunkedGenerationDraftMutation.mutate,
      cancelChunkedGenerationMutation.mutate,
      generateChunkedSegmentMutation.isPending,
      pauseChunkedGenerationMutation.isPending,
      resumeChunkedGenerationMutation.isPending,
      restartChunkedGenerationMutation.isPending,
      saveChunkedGenerationDraftMutation.isPending,
      cancelChunkedGenerationMutation.isPending,
      frameVariantImageUrl,
      segmentWindow,
      stableOriginalSegmentPreviewUrl,
      uploadManualGeneratedVideo,
      selectedPreviewGeneration,
      task,
      originalPreviewIsSegmentClip,
      selectedSegmentGenerations,
      selectedReportOutputs,
      generationCardsVisible,
      selectSegmentGeneration,
      setVideoCompareModal,
      openVideoCleanupModalForGeneration,
      selectedTaskId,
      refreshSignedUrlsForTask,
      handleDeleteAsset,
    ],
  );

  const mergeTabCtx = useMemo<MergeTabCtx>(
    () => ({
      onNext: () => {
        if (selectedTaskId) {
          setTab("assets");
        }
      },
      nextDisabled: !mergeTargetGeneration || mergeTargetGeneration.status !== "complete" || !mergeTargetGeneration.downloadUrl,
      nextWarning:
        !mergeTargetGeneration || mergeTargetGeneration.status !== "complete" || !mergeTargetGeneration.downloadUrl
          ? "Choose a completed output in Outputs before continuing to Reports."
          : null,
      generationInputMode,
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
      mergeVisibleDurationFramesBeforeRetime,
      mergeEffectiveDurationFrames,
      mergeInsertStartFrameLowerBound,
      mergeInsertStartFrameEffective,
      mergeInsertStartFrameUpperBound,
      mergeEffectiveEndFrameExclusive,
      mergeEffectiveEndFrameInclusive,
      mergeEndOffsetFrames,
      mergeGeneratedStartAnchor,
      mergeGeneratedMaxFrameIndex: generatedMaxFrameIndex,
      mergeFeatherClamped,
      mergeTrimStartFramesEffective: mergeTrimStartClamped,
      mergeOriginalVideoForPreview,
      mergeGeneratedVideoForPreview,
      mergeOriginalSourceCacheKey,
      mergeGeneratedSourceCacheKey,
      startBoundaryOriginalThumbs,
      startBoundaryGeneratedThumbs: startBoundaryGeneratedDisplayThumbs,
      MergeBoundaryPreview,
      mergeGeneratedEndAnchor,
      endBoundaryGeneratedThumbs: endBoundaryGeneratedDisplayThumbs,
      endBoundaryOriginalThumbs,
      mergeSourceWidth,
      mergeSourceHeight,
      mergeMutation,
      mergeApplyRetime,
      setMergeApplyRetime,
      mergePlaybackRate,
      setMergePlaybackRate,
      suggestMergeAlignment: suggestMergeAlignmentMutation.mutate,
      isSuggestingMergeAlignment,
      reconcileTiming: reconcileTimingMutation.mutate,
      isReconcilingTiming,
      mergeAlignmentSuggestion,
      mergeAlignmentSuggestionError:
        mergeAlignmentSuggestionError ??
        (suggestMergeAlignmentMutation.error instanceof Error ? suggestMergeAlignmentMutation.error.message : null),
      reconcileTimingError:
        reconcileTimingError ??
        (reconcileTimingMutation.error instanceof Error ? reconcileTimingMutation.error.message : null),
      extendGeneration: extendSegmentGenerationMutation.mutate,
      isExtendingGeneration: extendSegmentGenerationMutation.isPending,
      extendGenerationError:
        extendSegmentGenerationMutation.error instanceof Error ? extendSegmentGenerationMutation.error.message : null,
      sortedExports,
      humanizeFilename,
      keyBasenameFromS3Key,
      formatCompactTimestamp,
      openMotionSyncModal,
      openVideoCleanupModal: openVideoCleanupModalForGeneration,
    }),
    [
      selectedTaskId,
      setTab,
      mergeTargetGeneration,
      generationInputMode,
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
      mergeVisibleDurationFramesBeforeRetime,
      mergeEffectiveDurationFrames,
      mergeInsertStartFrameLowerBound,
      mergeInsertStartFrameEffective,
      mergeInsertStartFrameUpperBound,
      mergeEffectiveEndFrameExclusive,
      mergeEffectiveEndFrameInclusive,
      mergeEndOffsetFrames,
      mergeGeneratedStartAnchor,
      generatedMaxFrameIndex,
      mergeFeatherClamped,
      mergeTrimStartClamped,
      mergeOriginalVideoForPreview,
      mergeGeneratedVideoForPreview,
      mergeOriginalSourceCacheKey,
      mergeGeneratedSourceCacheKey,
      startBoundaryOriginalThumbs,
      startBoundaryGeneratedDisplayThumbs,
      mergeGeneratedEndAnchor,
      endBoundaryGeneratedDisplayThumbs,
      endBoundaryOriginalThumbs,
      mergeSourceWidth,
      mergeSourceHeight,
      mergeMutation,
      mergeApplyRetime,
      mergePlaybackRate,
      suggestMergeAlignmentMutation.mutate,
      isSuggestingMergeAlignment,
      reconcileTimingMutation.mutate,
      isReconcilingTiming,
      mergeAlignmentSuggestion,
      suggestMergeAlignmentMutation.error,
      reconcileTimingMutation.error,
      reconcileTimingError,
      extendSegmentGenerationMutation.mutate,
      extendSegmentGenerationMutation.isPending,
      extendSegmentGenerationMutation.error,
      sortedExports,
      openMotionSyncModal,
      openVideoCleanupModalForGeneration,
    ],
  );

  const assetsTabCtx = useMemo<AssetsTabCtx>(
    () => ({
      selectedTaskId,
      task,
      assetsLoading,
      mergedVideoAssets,
      mergedAssetsVisible,
      setMergedAssetsVisible,
      generatedVideoAssets,
      generatedAssetsVisible,
      setGeneratedAssetsVisible,
      editedFrameAssets,
      editedFrameAssetsVisible,
      setEditedFrameAssetsVisible,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      clearCustomReportOutputs,
      handleDeleteAsset,
      createCustomReport: createCustomReportMutation.mutateAsync,
      isCreatingCustomReport: createCustomReportMutation.isPending,
      formatAssetDate,
      onNext: () => {
        if (selectedTaskId) {
          goToReport(selectedTaskId, "reports", null);
        }
      },
      nextDisabled: !selectedTaskId,
      nextWarning: !selectedTaskId ? "Select a task before opening reports." : null,
    }),
    [
      selectedTaskId,
      task,
      assetsLoading,
      mergedVideoAssets,
      mergedAssetsVisible,
      generatedVideoAssets,
      generatedAssetsVisible,
      editedFrameAssets,
      editedFrameAssetsVisible,
      selectedReportOutputs,
      handleDeleteAsset,
      createCustomReportMutation.mutateAsync,
      createCustomReportMutation.isPending,
      goToReport,
      clearCustomReportOutputs,
    ],
  );

  const assetLibraryTabCtx = useMemo<AssetsTabCtx>(
    () => ({
      selectedTaskId,
      task,
      assetsLoading: assetLibraryLoading,
      pageTitle: "Asset Library",
      pageDescription: "Latest merged videos, generated videos, and edited frames across all source videos for this account.",
      showNext: false,
      mergedVideoAssets: libraryMergedVideoAssets,
      mergedAssetsVisible: libraryMergedAssetsVisible,
      setMergedAssetsVisible: setLibraryMergedAssetsVisible,
      generatedVideoAssets: libraryGeneratedVideoAssets,
      generatedAssetsVisible: libraryGeneratedAssetsVisible,
      setGeneratedAssetsVisible: setLibraryGeneratedAssetsVisible,
      editedFrameAssets: libraryEditedFrameAssets,
      editedFrameAssetsVisible: libraryEditedFrameAssetsVisible,
      setEditedFrameAssetsVisible: setLibraryEditedFrameAssetsVisible,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      clearCustomReportOutputs,
      handleDeleteAsset,
      createCustomReport: createCustomReportMutation.mutateAsync,
      isCreatingCustomReport: createCustomReportMutation.isPending,
      formatAssetDate,
      onNext: () => undefined,
      nextDisabled: true,
      nextWarning: null,
    }),
    [
      selectedTaskId,
      task,
      assetLibraryLoading,
      libraryMergedVideoAssets,
      libraryMergedAssetsVisible,
      libraryGeneratedVideoAssets,
      libraryGeneratedAssetsVisible,
      libraryEditedFrameAssets,
      libraryEditedFrameAssetsVisible,
      selectedReportOutputs,
      handleDeleteAsset,
      createCustomReportMutation.mutateAsync,
      createCustomReportMutation.isPending,
      clearCustomReportOutputs,
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
            void handleTabChange("asset_library");
          }}
          onOpenCustomQc={() => {
            void handleTabChange("custom_qc");
          }}
          onOpenApiLogs={() => {
            void handleTabChange("api_logs");
          }}
        />

        <section className="col-span-12 space-y-4 md:col-span-10">
          {appUiError ? (
            <StatusNotice variant="error">
              <div className="flex items-start justify-between gap-3">
                <p>{appUiError}</p>
                <button type="button" className="rounded border border-red-200 bg-white px-2 py-1 text-xs text-red-700" onClick={() => setAppUiError(null)}>
                  Dismiss
                </button>
              </div>
            </StatusNotice>
          ) : null}
          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            {tab !== "custom_qc" && tab !== "api_logs" && tab !== "asset_library" ? (
              <div className="space-y-3">
                <WorkflowTabs
                  tabs={primaryTabs}
                  activeTab={activeWorkflowSection ?? "source"}
                  onSelect={(sectionId) => {
                    handlePrimaryWorkflowSectionChange(sectionId as PrimaryWorkflowSection);
                  }}
                  variant="primary"
                />
                {activeWorkflowSection === "create" || activeWorkflowSection === "outputs" || activeWorkflowSection === "post" ? (
                  <div className="mb-4">
                    <CurrentWorkingReferencePanel
                      segment={currentReferenceSegment}
                      startFrameImageUrl={currentReferenceStartImageUrl}
                      endFrameImageUrl={currentReferenceEndImageUrl}
                      warning={currentReferenceWarning}
                      assets={currentReferenceAssets}
                      onPreviewImage={({ url, label }) => setImagePreviewModal({ url, label })}
                      onPreviewVideo={({ url, label }) => setVideoPreviewModal({ url, label })}
                    />
                  </div>
                ) : null}
                {activeWorkflowSection === "source" ? (
                  <div className="rounded-xl border border-ink/10 bg-bg p-3">
                    <CreateRoutePicker
                      activeMode={generationInputMode}
                      onSelect={(mode) => {
                        setGenerationInputMode(mode);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {tab === "timeline" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Source...</p>}>
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

            {tab === "outputs" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Outputs...</p>}>
                <GenerateTab ctx={generateTabCtx} />
              </Suspense>
            )}

            {tab === "report" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Reports...</p>}>
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
                    openSource: (taskId: string) => setTab("timeline", taskId),
                    openOutputs: (taskId: string) => setTab("outputs", taskId),
                    currentWorkingRangeLabel: selectedSegment ? describeSegment(selectedSegment) : "Whole video",
                    currentWorkingRangeSegment: selectedSegment,
                  }}
                />
              </Suspense>
            )}

            {tab === "merge" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Post Process...</p>}>
                <MergeTab ctx={mergeTabCtx} />
              </Suspense>
            )}

            {tab === "assets" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Download Assets...</p>}>
                <AssetsTab ctx={assetsTabCtx} />
              </Suspense>
            )}

            {tab === "asset_library" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Asset Library...</p>}>
                <AssetsTab ctx={assetLibraryTabCtx} />
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

          {tab !== "api_logs" && tab !== "asset_library" ? (
            <Suspense fallback={<div className="rounded-2xl border border-ink/10 bg-card p-4 text-sm text-ink/60">Loading jobs...</div>}>
              <JobsPanel ctx={jobsPanelCtx} />
            </Suspense>
          ) : null}
        </section>
      </div>
      <PreviewModals
        imagePreview={imagePreviewModal}
        videoPreview={videoPreviewModal}
        imageCompare={imageCompareModal}
        videoCompare={videoCompareModal}
        onCloseImage={() => setImagePreviewModal(null)}
        onCloseVideo={() => setVideoPreviewModal(null)}
        onCloseImageCompare={() => setImageCompareModal(null)}
        onCloseVideoCompare={() => setVideoCompareModal(null)}
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
          if (result?.frameId && result?.variantId) {
            const frameId = result.frameId;
            if (editFirstFrame?.frameId === frameId) {
              setRefineFrameTab("first");
              setRefineSourceVariantIds((previous) => ({ ...previous, first: result.variantId ?? previous.first }));
              setEditSourceVariantIds((previous) => ({ ...previous, first: result.variantId ?? previous.first }));
            }
            if (editLastFrame?.frameId === frameId) {
              setRefineFrameTab((current) => (editFirstFrame?.frameId === frameId ? current : "last"));
              setRefineSourceVariantIds((previous) => ({ ...previous, last: result.variantId ?? previous.last }));
              setEditSourceVariantIds((previous) => ({ ...previous, last: result.variantId ?? previous.last }));
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

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
  type WorkflowRouteState,
  useCanonicalTaskRoute,
  useReportRouteState,
  useWorkflowRouteState,
} from "./hooks/useWorkflowRouting";
import { useVideoFrameStrip, type VideoFrameStripItem } from "./hooks/useVideoFrameStrip";
import { useTaskLifecycle } from "./hooks/useTaskLifecycle";
import { useAssetLibraryState } from "./hooks/useAssetLibraryState";
import { useAssetsTabContexts } from "./hooks/useAssetsTabContexts";
import { useCurrentWorkingReferenceState } from "./hooks/useCurrentWorkingReferenceState";
import { useGenerationConfigState } from "./hooks/useGenerationConfigState";
import { useGenerationPromptGuidance } from "./hooks/useGenerationPromptGuidance";
import { useGenerationMergeState } from "./hooks/useGenerationMergeState";
import { useSelectedSegmentPreview } from "./hooks/useSelectedSegmentPreview";
import { useTaskDataQueries } from "./hooks/useTaskDataQueries";
import { useReportOutputSelection } from "./hooks/useReportOutputSelection";
import { getPromptWizardModelConfig, type PromptWizardMode, type PromptWizardResult } from "./lib/promptWizardConfig";
import type {
  PatchEditModelId,
  VideoModeId,
  VideoModelId,
} from "./lib/generated/videoContracts";
import { getGenerationModeConfig, type GenerateInputMode } from "./lib/generationModeRegistry";
import { PRIMARY_WORKFLOW_TABS, type PrimaryWorkflowSection } from "./lib/workflowSections";
import { currentUser, login, logout } from "./lib/auth";
import type { EditFrameTabCtx } from "./pages/workflow/EditFrameTab";
import type { EditVideoReferencesTabCtx } from "./pages/workflow/EditVideoReferencesTab";
import type { GenerateTabCtx } from "./pages/workflow/GenerateTab";
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
import type { LibraryAsset } from "./types/libraryAsset";

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

type PendingEditJobCard = {
  jobId: string;
  frameId: string;
  model: string;
  status: "queued" | "running" | "failed";
  progress: number;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
  type: "edit_full" | "edit_patch";
};

type PendingGenerationCard = {
  jobId: string;
  segmentId: string;
  genId?: string;
  model: string;
  mode: string;
  status: "queued" | "running" | "failed";
  progress: number;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
};

const ReportsPage = lazy(() => import("./pages/ReportsPage"));
const CustomQcPage = lazy(() => import("./pages/CustomQcPage"));
const ApiLogsPage = lazy(() => import("./pages/ApiLogsPage"));
const AdminPromptWizardPage = lazy(() => import("./pages/AdminPromptWizardPage"));
const PickFrameTab = lazy(() => import("./pages/workflow/PickFrameTab"));
const EditFrameTab = lazy(() => import("./pages/workflow/EditFrameTab"));
const EditVideoReferencesTab = lazy(() => import("./pages/workflow/EditVideoReferencesTab"));
const RefineFramesTab = lazy(() => import("./pages/workflow/RefineFramesTab"));
const GenerateTab = lazy(() => import("./pages/workflow/GenerateTab"));
const MergeTab = lazy(() => import("./pages/workflow/MergeTab"));
const AssetsTab = lazy(() => import("./pages/workflow/AssetsTab"));

const MAX_TRACKED_JOB_IDS = 40;
const URL_REFRESH_IDLE_MS = 2 * 60 * 1000;
const MEDIA_ERROR_FORCE_REFRESH_COOLDOWN_MS = 60 * 1000;
const JOB_TERMINAL_REFRESH_COOLDOWN_MS = 1500;
const AUTOMATION_CANCELLED = "__automation_cancelled__";
const SEGMENT_SELECTION_STORAGE_KEY = "aivfx:lastSegmentByTask:v1";
const VIDEO_WORK_MODE_STORAGE_KEY = "aivfx:videoWorkModeByTask:v1";
const WHOLE_VIDEO_SINGLE_PASS_LIMIT_SECONDS = 10;

type VideoWorkMode = "whole_video" | "custom_segment";

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

function promptWizardModeForInput(inputMode: GenerateInputMode): PromptWizardMode | null {
  if (inputMode === "start_video") return "start_video";
  if (inputMode === "start_end") return "start_end";
  if (inputMode === "edit_video") return "edit_video";
  return null;
}

function lumaModeBucket(mode: string): "adhere" | "flex" | "reimagine" | null {
  if (mode.startsWith("adhere")) return "adhere";
  if (mode.startsWith("flex")) return "flex";
  if (mode.startsWith("reimagine")) return "reimagine";
  return null;
}

function validatePromptWizardResult(result: PromptWizardResult, requiredMarkers: string[]): PromptWizardResult {
  const recommendedPrompt = result.recommended_prompt ?? "";
  const missing = requiredMarkers.filter((marker) => !recommendedPrompt.includes(marker));
  if (missing.length) {
    throw new Error(`Prompt Wizard response missing required marker(s): ${missing.join(", ")}`);
  }
  if (requiredMarkers.length && !result.required_markers_present) {
    throw new Error("Prompt Wizard response reported missing required markers.");
  }
  return { ...result, negative_prompt: "" };
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

function generationThumbnailUrl(generation: SegmentGeneration): string | null {
  return (
    generation.inputFirstFrameUrl ??
    generation.sourceFirstFrameCaptureUrl ??
    generation.inputLastFrameUrl ??
    generation.sourceLastFrameCaptureUrl ??
    null
  );
}

function jobPayloadString(job: JobStatus, key: string): string | null {
  const value = job.payload?.[key];
  return typeof value === "string" && value.trim() ? value : null;
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
  if (model === "ltx-2.3-pro") return "LTX 2.3 Pro";
  return model;
}

function formatFps(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function parsePresignedExpiryMs(url: string): number | null {
  try {
    const parsed = new URL(url);
    const amzDate = parsed.searchParams.get("X-Amz-Date");
    const amzExpires = parsed.searchParams.get("X-Amz-Expires");
    if (!amzDate || !amzExpires) return null;
    const expiresSeconds = Number(amzExpires);
    if (!Number.isFinite(expiresSeconds) || expiresSeconds <= 0) return null;
    const match = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) return null;
    const issuedAtMs = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    );
    return issuedAtMs + Math.round(expiresSeconds * 1000);
  } catch {
    return null;
  }
}

function isPresignedUrlNearExpiry(url: string | null | undefined, withinMs = 60_000): boolean {
  if (!url) return false;
  const expiryMs = parsePresignedExpiryMs(url);
  return typeof expiryMs === "number" && expiryMs - Date.now() <= withinMs;
}

function isLikelyVideoAssetUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(mp4|mov|m4v|webm|ogv|avi|mkv)$/i.test(pathname);
  } catch {
    return false;
  }
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
  if (model === "ltx-2.3-pro") return { minSeconds: 6, maxSeconds: 10 };
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
  { id: "ltx-2.3-pro:start_end:ltx23_i2v_start_end", label: "LTX 2.3 Pro (Start/End frame)", inputMode: "start_end", lumaModel: "ltx-2.3-pro", mode: "ltx23_i2v_start_end" },
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
              type="button"
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
          type="button"
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
  labelFrameSource = "display",
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
  labelFrameSource?: "display" | "source";
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
            const trackTintClass = prefix === "g" ? "bg-cyan-50/70" : "bg-bg";
            const labelFrameIndex =
              labelFrameSource === "source" && typeof item?.sourceFrameIndex === "number"
                ? item.sourceFrameIndex
                : slot.frameIndex;
            return (
              <div
                key={`${title}:${slot.frameIndex}`}
                className={`shrink-0 border-r border-ink/15 ${
                  inOverlap ? "bg-amber-50" : item ? trackTintClass : prefix === "g" ? "bg-cyan-50/40" : "bg-ink/5"
                } last:border-r-0`}
                style={{ width: `${itemWidthPx}px` }}
              >
                {frameLabelPosition === "top" ? (
                  <p className="truncate px-1 py-1 text-[10px] text-ink/70">
                    {labelFrameIndex >= 0 ? `${prefix}${labelFrameIndex}` : ""}
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
                    {labelFrameIndex >= 0 ? `${prefix}${labelFrameIndex}` : ""}
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
    labelFrameSource?: "display" | "source";
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
    labelFrameSource?: "display" | "source";
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
  const routeState = useWorkflowRouteState(location.pathname, location.hash);
  const [routeOverride, setRouteOverride] = useState<WorkflowRouteState | null>(null);
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
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<
    "nano_banana" | "nano_banana_pro" | "chatgpt" | "chatgpt_latest" | "luma_uni_1" | "luma_uni_1_max"
  >("nano_banana_pro");
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
  const [videoPreviewModal, setVideoPreviewModal] = useState<{
    url: string;
    label: string;
    taskId?: string;
    generationId?: string;
  } | null>(null);
  const [videoPreviewNeedsRefresh, setVideoPreviewNeedsRefresh] = useState(false);
  const [imageCompareModal, setImageCompareModal] = useState<{ originalUrl: string; compareUrl: string; label: string } | null>(null);
  const [videoCompareModal, setVideoCompareModal] = useState<{
    originalUrl: string;
    compareUrl: string;
    label: string;
    posterUrl?: string | null;
    segmentStartSec?: number;
    originalIsSegmentClip?: boolean;
    originalSegmentId?: string;
    compareGenerationId?: string;
    preferGenerationInputMediaAsOriginal?: boolean;
  } | null>(null);
  const [, setReportGraphModal] = useState<{ url: string; label: string } | null>(null);
  const [motionSyncModalExportId, setMotionSyncModalExportId] = useState<string | null>(null);
  const [topazUpscalePendingExportId, setTopazUpscalePendingExportId] = useState<string | null>(null);
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
  const [dismissedPendingGenerationJobIds, setDismissedPendingGenerationJobIds] = useState<Record<string, true>>({});
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
  const [editVideoSelectedReferenceIds, setEditVideoSelectedReferenceIds] = useState<string[]>([]);
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
  const mediaErrorRefreshRef = useRef<Map<string, number>>(new Map());
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

  const effectiveRouteState = routeOverride ?? routeState;
  const tab: TabId = effectiveRouteState.tab ?? "timeline";
  const activeWorkflowSection = workflowSectionForTab(tab);
  const activePostTab: TabId = tab === "merge" ? tab : "merge";
  const isReportTab = tab === "report";
  const selectedTaskId = effectiveRouteState.taskId ?? storeSelectedTaskId;
  const reportTaskId = selectedTaskId;

  useEffect(() => {
    if (!routeOverride) return;
    const routeSettled =
      routeState.taskId === routeOverride.taskId &&
      routeState.tab === routeOverride.tab;
    if (routeSettled) {
      setRouteOverride(null);
    }
  }, [routeOverride, routeState.tab, routeState.taskId]);

  const setTab = useCallback(
    (nextTab: TabId, taskIdOverride?: string | null, replace = false) => {
      const targetTaskId = taskIdOverride ?? selectedTaskId ?? tasksQuery.data?.[0]?.taskId ?? null;
      if (!targetTaskId) {
        if (nextTab === "admin") {
          setRouteOverride({ taskId: null, tab: "admin" });
          navigate("/admin", { replace });
        }
        return;
      }
      setRouteOverride({ taskId: targetTaskId, tab: nextTab });
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
      setRouteOverride({ taskId, tab: "report" });
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
    routeState: effectiveRouteState,
    storeSelectedTaskId,
    taskIds: (tasksQuery.data ?? []).map((taskItem) => taskItem.taskId),
    locationPathname: location.pathname,
    locationHash: location.hash,
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

  const { taskQuery, reportTaskQuery, task, reportTask, assetTasks, assetsLoading, assetLibraryLoading } =
    useTaskDataQueries({
      isAuthed,
      selectedTaskId,
      reportTaskId,
      isReportTab,
      isAssetLibraryTab: tab === "asset_library",
      isPageVisible,
      tasks: tasksQuery.data ?? [],
    });
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
    mergeFadeInFrames,
    setMergeFadeInFrames,
    mergeFadeOutFrames,
    setMergeFadeOutFrames,
    mergeSourceRestartFrame,
    setMergeSourceRestartFrame,
    mergeInsertStartFrame,
    setMergeInsertStartFrame,
    mergeTrimStartFrames,
    setMergeTrimStartFrames,
    mergeTrimEndFrames,
    setMergeTrimEndFrames,
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

  const assetsTabLoading = tab === "assets" && assetsLoading;
  const assetLibraryTabLoading = tab === "asset_library" && assetLibraryLoading;
  const selectedSegment = task?.segments.find((s) => s.segmentId === selectedSegmentId) ?? null;
  const editVideoReferences = useMemo(() => task?.editVideoReferences ?? [], [task?.editVideoReferences]);
  const editVideoReferenceLimitByModel = useMemo(() => {
    if (lumaModel === "seedance-2.0-reference-to-video" || lumaModel === "happy-horse-video-edit" || lumaModel === "kling-v3-omni-video") {
      return 3;
    }
    if (lumaModel === "wan2.7-videoedit" || lumaModel === "runway-gen4-aleph") {
      return 1;
    }
    return 0;
  }, [lumaModel]);
  const editVideoReferenceWarning = useMemo(() => {
    if (generationInputMode !== "edit_video") return null;
    if (!editVideoReferenceLimitByModel) return null;
    if (editVideoSelectedReferenceIds.length > editVideoReferenceLimitByModel) {
      return `This model will use only the first ${editVideoReferenceLimitByModel} selected reference image${editVideoReferenceLimitByModel > 1 ? "s" : ""}.`;
    }
    return null;
  }, [editVideoReferenceLimitByModel, editVideoSelectedReferenceIds.length, generationInputMode]);
  const generationModelOptionsForInput = useMemo(() => {
    if (generationInputMode !== "edit_video") return generationModelOptions;
    const count = editVideoSelectedReferenceIds.length;
    return generationModelOptions.filter((option) => {
      if (option.value === "seedance-2.0-reference-to-video" || option.value === "happy-horse-video-edit" || option.value === "kling-v3-omni-video") {
        return count <= 3;
      }
      if (option.value === "wan2.7-videoedit" || option.value === "runway-gen4-aleph") {
        return count <= 1;
      }
      return true;
    });
  }, [editVideoSelectedReferenceIds.length, generationInputMode, generationModelOptions]);
  const editVideoReferencePreview = useMemo(() => {
    if (generationInputMode !== "edit_video") return [];
    const tokenForIndex = (index: number): string => {
      if (lumaModel === "seedance-2.0-reference-to-video" || lumaModel === "happy-horse-video-edit") return `@Image${index + 1}`;
      if (lumaModel === "kling-v3-omni-video") return `<<<image_${index + 1}>>>`;
      return `Reference ${index + 1}`;
    };
    const output: Array<{ referenceId: string; imageUrl?: string; token: string }> = [];
    for (let index = 0; index < editVideoSelectedReferenceIds.length; index += 1) {
      const id = editVideoSelectedReferenceIds[index];
      const reference = editVideoReferences.find((item) => item.referenceId === id);
      if (!reference) continue;
      output.push({
        referenceId: id,
        imageUrl: reference.imageUrl,
        token: tokenForIndex(index),
      });
    }
    return output;
  }, [editVideoReferences, editVideoSelectedReferenceIds, generationInputMode, lumaModel]);
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
    const availableIds = new Set(editVideoReferences.map((item) => item.referenceId));
    setEditVideoSelectedReferenceIds((previous) => previous.filter((id) => availableIds.has(id)));
  }, [editVideoReferences]);
  useEffect(() => {
    if (generationInputMode !== "edit_video") return;
    if (generationModelOptionsForInput.some((option) => option.value === lumaModel)) return;
    const fallback = generationModelOptionsForInput[0]?.value;
    if (!fallback) return;
    setGenerationModelByInput((previous) => ({ ...previous, [generationInputMode]: fallback }));
  }, [generationInputMode, generationModelOptionsForInput, lumaModel, setGenerationModelByInput]);
  useEffect(() => {
    if (generationInputMode === "start_end") return;
    if (editFrameTab === "last") {
      setEditFrameTab("first");
    }
    if (refineFrameTab === "last") {
      setRefineFrameTab("first");
    }
  }, [editFrameTab, generationInputMode, refineFrameTab]);
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
      const rememberedSegment = task.segments.find((segment) => segment.segmentId === rememberedSegmentId);
      const isValidRemembered = Boolean(rememberedSegment && !rememberedSegment.internalOnly);
      if (!isValidRemembered) {
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
    const selectedForTask = task?.segments?.find((segment) => segment.segmentId === selectedSegmentId);
    if (!selectedForTask || selectedForTask.internalOnly) return;
    const rememberedByTask = readSegmentSelectionMap();
    if (rememberedByTask[selectedTaskId] === selectedSegmentId) return;
    rememberedByTask[selectedTaskId] = selectedSegmentId;
    writeSegmentSelectionMap(rememberedByTask);
  }, [selectedSegmentId, selectedTaskId, task?.segments]);

  useEffect(() => {
    if (!selectedSegment?.internalOnly) return;
    const fallbackId =
      defaultVideoSegment?.segmentId ??
      task?.segments?.find((segment) => !segment.internalOnly)?.segmentId ??
      null;
    if (fallbackId && fallbackId !== selectedSegmentId) {
      setSelectedSegmentId(fallbackId);
      return;
    }
    if (!fallbackId && selectedSegmentId) {
      setSelectedSegmentId(null);
    }
  }, [defaultVideoSegment?.segmentId, selectedSegment?.internalOnly, selectedSegmentId, setSelectedSegmentId, task?.segments]);

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
        assetType: "upload" | "frame_capture" | "frame_variant" | "segment_generation" | "export" | "edit_video_reference";
        frameId?: string;
        variantId?: string;
        genId?: string;
        exportId?: string;
        referenceId?: string;
      };
    }) => apiClient.deleteAsset(taskId, payload),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", variables.taskId] });
    },
  });
  const cancelJobMutation = useMutation({
    mutationFn: async ({ jobId, reason }: { jobId: string; reason?: string }) => apiClient.cancelJob(jobId, { reason }),
    onSuccess: async (_result, variables) => {
      setJobIds((previous) => appendTrackedJobId(previous, variables.jobId));
      await queryClient.invalidateQueries({ queryKey: ["job", variables.jobId] });
      if (selectedTaskId) {
        await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      }
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
      : lumaModel === "ltx-2.3-pro"
        ? "ltx23_i2v_start_end"
      : lumaModel === "wan2.7-videoedit"
        ? "wan27_video_edit"
      : advancedMode;
  }, [advancedMode, generationInputMode, lumaModel]);

  const improvePromptWizardMutation = useMutation({
    mutationFn: async (): Promise<PromptWizardResult> => {
      if (!selectedTaskId || !selectedSegmentId) throw new Error("Select a segment");
      const promptWizardMode = promptWizardModeForInput(generationInputMode);
      if (!promptWizardMode) {
        throw new Error("Prompt Wizard is not available for this mode.");
      }
      const config = getPromptWizardModelConfig(lumaModel, promptWizardMode);
      if (!config) {
        throw new Error("Prompt Wizard is not configured for this model and mode.");
      }
      const trimmedPrompt = lumaPrompt.trim();
      if (!trimmedPrompt) {
        throw new Error("Prompt is required");
      }
      const firstFrameVariantId = refineSourceVariantIds.first || compareVariantIds.first || null;
      const requestPayload = {
        selected_model: lumaModel,
        provider: config.provider,
        provider_model: config.providerModel,
        endpoint_used: config.endpointUsed,
        mode: promptWizardMode,
        user_draft_prompt: trimmedPrompt,
        has_source_video: generationInputMode === "start_video" || generationInputMode === "edit_video",
        has_edited_first_frame:
          generationInputMode === "edit_video"
            ? editVideoSelectedReferenceIds.length > 0
            : Boolean(firstFrameVariantId && firstFrameVariantId !== "original"),
        has_last_frame: generationInputMode === "start_end",
        app_required_markers: config.requiredMarkers,
        supports_negative_prompt: false as const,
        duration_seconds: selectedSegment ? selectedSegment.durationSec : null,
        aspect_ratio: selectedSegment?.crop?.aspect ?? null,
        luma_mode: lumaModel === "ray-2" || lumaModel === "ray-flash-2" ? lumaModeBucket(advancedMode) : null,
        user_visible_model_name: config.dropdownName,
        first_frame_variant_id: firstFrameVariantId,
        selected_reference_ids: generationInputMode === "edit_video" ? editVideoSelectedReferenceIds.slice(0, 3) : [],
      };
      const response = await apiClient.improveSegmentPrompt(selectedTaskId, selectedSegmentId, requestPayload);
      return validatePromptWizardResult(response.result, config.requiredMarkers);
    },
  });

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
        selectedReferenceIds:
          generationInputMode === "edit_video"
            ? editVideoSelectedReferenceIds.slice(0, editVideoReferenceLimitByModel || 3)
            : undefined,
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
      inputMode,
      continueToRangeEnd,
      useSourceLastFrame,
      lastFrameVariantId,
    }: {
      generationId: string;
      alignmentFrameIndex: number;
      anchorFramesFromEnd: number;
      durationSeconds?: number;
      prompt?: string;
      inputMode?: GenerateInputMode;
      continueToRangeEnd?: boolean;
      useSourceLastFrame?: boolean;
      lastFrameVariantId?: string;
    }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.extendSegmentGeneration(selectedTaskId, generationId, {
        alignmentFrameIndex,
        anchorFramesFromEnd,
        durationSeconds,
        prompt,
        inputMode,
        continueToRangeEnd,
        useSourceLastFrame,
        lastFrameVariantId,
      });
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async (options?: { cropEdgeFeather?: { top: number; right: number; bottom: number; left: number } | null }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      const mergeTargetAdjustment =
        mergeTargetGeneration && selectedGenIds.includes(mergeTargetGeneration.genId)
          ? {
              startFrameOverride: mergeInsertStartFrameEffective,
              sourceRestartFrame: mergeSourceRestartFrameEffective,
              trimStartFrames: mergeTrimStartUserClamped,
              trimEndFrames: mergeTrimEndClamped,
              playbackRate: mergeApplyRetime ? mergePlaybackRate : undefined,
              cropEdgeFeather: options?.cropEdgeFeather ?? undefined,
            }
          : null;
      const generationAdjustments =
        mergeTargetGeneration && mergeTargetAdjustment
          ? {
              [mergeTargetGeneration.genId]: mergeTargetAdjustment,
            }
          : undefined;
      return apiClient.merge(selectedTaskId, {
        selectedSegmentGenerationIds: selectedGenIds,
        temporalFeatherStartFrames: mergeFadeInClamped,
        temporalFeatherEndFrames: mergeFadeOutClamped,
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

  const runTopazUpscaleMutation = useMutation({
    mutationFn: async ({
      exportId,
      payload,
    }: {
      exportId: string;
      payload: {
        preset: "balanced" | "recover_detail" | "fast_sharpen";
        model: string;
        upscaleFactor: number;
        h264Output: boolean;
        force?: boolean;
      };
    }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.runTopazUpscale(selectedTaskId, exportId, payload);
    },
    onMutate: async ({ exportId }) => {
      setTopazUpscalePendingExportId(exportId);
    },
    onSuccess: async (result) => {
      if (result.jobId) {
        setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      }
      if (selectedTaskId) {
        await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      }
    },
    onSettled: () => {
      setTopazUpscalePendingExportId(null);
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
    const isActiveStatus = (status: string | null | undefined) => status === "queued" || status === "running";
    const ids: string[] = [];
    for (const generation of Object.values(task?.segmentGenerations ?? {})) {
      if (generation.jobId && isActiveStatus(generation.status)) ids.push(generation.jobId);
      const mergeSuggestionJobId = generation.mergeAlignmentSuggestion?.jobId;
      if (mergeSuggestionJobId && isActiveStatus(generation.mergeAlignmentSuggestion?.status)) ids.push(mergeSuggestionJobId);
      const reconcileJobId = generation.timingReconcile?.jobId;
      if (reconcileJobId && isActiveStatus(generation.timingReconcile?.status)) ids.push(reconcileJobId);
    }
    for (const run of task?.chunkedGenerationRuns ?? []) {
      if (run.saveJobId && isActiveStatus(run.saveStatus)) {
        ids.push(run.saveJobId);
      }
      for (const chunk of run.chunks ?? []) {
        if (chunk.jobId && isActiveStatus(chunk.status)) ids.push(chunk.jobId);
      }
    }
    for (const report of task?.customReports ?? []) {
      if (report.jobId && isActiveStatus(report.status)) ids.push(report.jobId);
    }
    for (const exportItem of task?.exports ?? []) {
      const motionJobId = exportItem.motionSyncQc?.jobId;
      if (motionJobId && isActiveStatus(exportItem.motionSyncQc?.status)) ids.push(motionJobId);
      const topazJobId = exportItem.topazUpscale?.jobId;
      if (topazJobId && isActiveStatus(exportItem.topazUpscale?.status)) ids.push(topazJobId);
    }
    return ids;
  }, [task?.chunkedGenerationRuns, task?.customReports, task?.exports, task?.segmentGenerations]);

  const trackedJobIds = useMemo(
    () => [...new Set([...jobIds, ...taskTrackedJobIds])],
    [jobIds, taskTrackedJobIds],
  );

  const jobPollingIntervalMs = useMemo(() => {
    const activeCount = trackedJobIds.length;
    if (activeCount <= 3) return 3000;
    if (activeCount <= 8) return 4500;
    return 6000;
  }, [trackedJobIds.length]);

  const jobQueries = useQueries({
    queries: trackedJobIds.map((jobId) => ({
      queryKey: ["job", jobId],
      queryFn: () => apiClient.getJob(jobId),
      refetchInterval: (q: { state: { data?: { status?: string } } }) => {
        if (!isPageVisible) return false;
        const status = q?.state?.data?.status;
        return status === "queued" || status === "running" ? jobPollingIntervalMs : false;
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

  useEffect(() => {
    setJobIds((previous) => {
      const next = previous.filter((jobId) => {
        const status = jobStatusById.get(jobId);
        return status == null || status === "queued" || status === "running";
      });
      if (next.length === previous.length && next.every((jobId, index) => previous[index] === jobId)) {
        return previous;
      }
      return next;
    });
  }, [jobStatusById]);

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
  const terminalRefreshAtRef = useRef(0);
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
    const now = Date.now();
    if (now - terminalRefreshAtRef.current < JOB_TERMINAL_REFRESH_COOLDOWN_MS) return;
    terminalRefreshAtRef.current = now;
    if (selectedTaskId) {
      void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      if (isReportTab) {
        void queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
      }
    }
    if (reportTaskId && reportTaskId !== selectedTaskId) {
      void queryClient.invalidateQueries({ queryKey: ["task", reportTaskId] });
      if (isReportTab) {
        void queryClient.invalidateQueries({ queryKey: ["task", "report", reportTaskId] });
      }
    }
    while (seenDoneRef.current.size > MAX_TRACKED_JOB_IDS * 5) {
      const oldest = seenDoneRef.current.values().next().value as string | undefined;
      if (!oldest) break;
      seenDoneRef.current.delete(oldest);
    }
  }, [isReportTab, jobQueries, queryClient, reportTaskId, selectedTaskId]);

  useEffect(() => {
    if (jobIds.length <= MAX_TRACKED_JOB_IDS) return;
    setJobIds((previous) => previous.slice(-MAX_TRACKED_JOB_IDS));
  }, [jobIds]);

  useEffect(() => {
    setJobIds([]);
    setDismissedPendingGenerationJobIds({});
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

  const dismissPendingEditJob = useCallback((jobId: string) => {
    setJobIds((previous) => previous.filter((id) => id !== jobId));
    seenDoneRef.current.delete(jobId);
  }, []);

  const dismissPendingGenerationJob = useCallback((jobId: string) => {
    setJobIds((previous) => previous.filter((id) => id !== jobId));
    setDismissedPendingGenerationJobIds((previous) => {
      if (previous[jobId]) return previous;
      return { ...previous, [jobId]: true };
    });
    seenDoneRef.current.delete(jobId);
  }, []);

  const removeFailedPendingGenerationJob = useCallback(
    async ({ jobId, genId }: { jobId: string; genId?: string }) => {
      if (selectedTaskId && genId) {
        try {
          await deleteAssetMutation.mutateAsync({
            taskId: selectedTaskId,
            payload: { assetType: "segment_generation", genId },
          });
        } catch (error) {
          setAppUiError(error instanceof Error ? error.message : "Failed to remove failed output");
        }
      }
      dismissPendingGenerationJob(jobId);
    },
    [deleteAssetMutation, dismissPendingGenerationJob, selectedTaskId, setAppUiError],
  );

  const requestCancelPendingEditJob = useCallback(
    async (jobId: string) => {
      try {
        await cancelJobMutation.mutateAsync({ jobId, reason: "Cancelled from Edit step" });
      } catch (error) {
        setAppUiError(error instanceof Error ? error.message : "Failed to cancel job");
      }
    },
    [cancelJobMutation, setAppUiError],
  );

  const requestCancelPendingGenerationJob = useCallback(
    async (jobId: string) => {
      try {
        await cancelJobMutation.mutateAsync({ jobId, reason: "Cancelled from Outputs step" });
      } catch (error) {
        setAppUiError(error instanceof Error ? error.message : "Failed to cancel job");
      }
    },
    [cancelJobMutation, setAppUiError],
  );

  const pendingEditJobs = useMemo<PendingEditJobCard[]>(() => {
    if (!activeEditFrame?.frameId) return [];
    const frameId = activeEditFrame.frameId;
    const cards: PendingEditJobCard[] = [];
    for (const job of sortedJobs) {
      if (job.type !== "edit_full" && job.type !== "edit_patch") continue;
      if (job.status !== "queued" && job.status !== "running" && job.status !== "failed") continue;
      const payloadFrameId = jobPayloadString(job, "frameId");
      if (payloadFrameId !== frameId) continue;
      cards.push({
        jobId: job.jobId,
        frameId,
        model: jobPayloadString(job, "model") ?? "Unknown model",
        status: job.status as "queued" | "running" | "failed",
        progress: Number.isFinite(job.progress) ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        error: job.error,
        type: job.type as "edit_full" | "edit_patch",
      });
    }
    return cards.sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime());
  }, [activeEditFrame?.frameId, sortedJobs]);

  const pendingGenerations = useMemo<PendingGenerationCard[]>(() => {
    if (!selectedSegmentId) return [];
    const cards: PendingGenerationCard[] = [];
    for (const job of sortedJobs) {
      if (dismissedPendingGenerationJobIds[job.jobId]) continue;
      if (job.type !== "segment_generate") continue;
      if (job.status !== "queued" && job.status !== "running" && job.status !== "failed") continue;
      const segmentId = jobPayloadString(job, "segmentId");
      if (segmentId !== selectedSegmentId) continue;
      cards.push({
        jobId: job.jobId,
        segmentId,
        genId: jobPayloadString(job, "genId") ?? undefined,
        model: jobPayloadString(job, "lumaModel") ?? "Unknown model",
        mode: jobPayloadString(job, "mode") ?? "unknown_mode",
        status: job.status as "queued" | "running" | "failed",
        progress: Number.isFinite(job.progress) ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        error: job.error,
      });
    }
    return cards.sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime());
  }, [dismissedPendingGenerationJobIds, selectedSegmentId, sortedJobs]);

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
  const mergeSourceRestartFrameLowerBound = Math.max(0, mergeInsertStartFrameEffective + 1);
  const mergeSourceRestartFrameUpperBound = mergeMaxFrameIndex + 1;
  const mergeSourceRestartFrameEffective = clampInteger(
    mergeSourceRestartFrame,
    mergeSourceRestartFrameLowerBound,
    mergeSourceRestartFrameUpperBound,
  );
  const mergeGeneratedStartAnchor = 0;
  const mergeGeneratedEndAnchor = Math.max(0, mergeEffectiveDurationFrames - 1);
  const mergeFadeInClamped = clampInteger(mergeFadeInFrames, 0, 30);
  const mergeFadeOutClamped = clampInteger(
    mergeFadeOutFrames,
    0,
    Math.min(30, mergeEffectiveDurationFrames, mergeSourceRestartFrameEffective),
  );
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
    () => frameWindow(Math.min(mergeSourceRestartFrameEffective, mergeMaxFrameIndex), 3, 3, 0, mergeMaxFrameIndex),
    [mergeMaxFrameIndex, mergeSourceRestartFrameEffective],
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
  const generationModeConfig = useMemo(() => getGenerationModeConfig(generationInputMode), [generationInputMode]);
  const promptWizardMode = useMemo(() => promptWizardModeForInput(generationInputMode), [generationInputMode]);
  const promptWizardConfig = useMemo(
    () => (promptWizardMode ? getPromptWizardModelConfig(lumaModel, promptWizardMode) : null),
    [lumaModel, promptWizardMode],
  );
  const requiresEndFrameForRoute = generationModeConfig.requiresEndFrame;
  const { generationHelp, missingRouteInputsMessage, generationInputNote, generationPromptPlaceholder, generationPromptError } =
    useGenerationPromptGuidance({
      lumaModel,
      advancedMode,
      generationInputMode,
      hasEditedStartFrame: generationInputMode === "edit_video" ? editVideoSelectedReferenceIds.length > 0 : Boolean(editFirstFrame),
      hasEditedEndFrame: Boolean(editLastFrame),
      requiresEndFrameForRoute,
      lumaPrompt,
    });

  const {
    editedFrameAssets,
    generatedVideoAssets,
    mergedVideoAssets,
    libraryEditedFrameAssets,
    libraryGeneratedVideoAssets,
    libraryMergedVideoAssets,
  } = useAssetLibraryState({
    selectedTaskId,
    selectedTask: task,
    assetTasks,
  });

  const { segmentWindow, originalPreviewIsSegmentClip, stableOriginalSegmentPreviewUrl, stableOriginalSegmentCompareUrl } = useSelectedSegmentPreview({
    selectedSegment,
    task,
  });
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
    mergeTargetGeneration?.mergeAlignmentSuggestion,
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
    setMergeAlignmentSuggestion(suggestion);
    setMergeAlignmentSuggestionJobId(null);
    setMergeAlignmentSuggestionError(null);
  }, [
    mergeAlignmentSuggestionJob,
    mergeAlignmentSuggestionJobId,
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

  function openTaskReport(taskId: string) {
    goToReport(taskId, "frames", null);
  }

  const refreshSignedUrlsForTask = useCallback(
    (taskId: string | null | undefined, options?: { force?: boolean; includeReport?: boolean; includeAssets?: boolean }) => {
      if (!taskId) return;
      const now = Date.now();
      const previous = signedUrlRefreshRef.current.get(taskId) ?? 0;
      if (!options?.force && now - previous < 15_000) return;
      signedUrlRefreshRef.current.set(taskId, now);
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      if (options?.includeReport) {
        void queryClient.invalidateQueries({ queryKey: ["task", "report", taskId] });
      }
      if (options?.includeAssets) {
        void queryClient.invalidateQueries({ queryKey: ["task", "assets", taskId] });
      }
    },
    [queryClient],
  );

  const handleMediaAssetError = useCallback(
    (url?: string) => {
      if (!selectedTaskId || !url) return;
      const expiryMs = typeof url === "string" && url ? parsePresignedExpiryMs(url) : null;
      const nearExpiry = typeof expiryMs === "number" && expiryMs - Date.now() <= 60_000;
      const isPresigned = typeof url === "string" && /[?&]X-Amz-Algorithm=AWS4-HMAC-SHA256/i.test(url);
      const shouldForce = nearExpiry || isPresigned;
      if (!shouldForce) return;
      if (shouldForce) {
        const now = Date.now();
        const throttleKey = `${selectedTaskId}:${url}`;
        const previous = mediaErrorRefreshRef.current.get(throttleKey) ?? 0;
        if (now - previous < MEDIA_ERROR_FORCE_REFRESH_COOLDOWN_MS) {
          return;
        }
        mediaErrorRefreshRef.current.set(throttleKey, now);
      }
      refreshSignedUrlsForTask(selectedTaskId, { force: shouldForce, includeReport: isReportTab });
    },
    [isReportTab, refreshSignedUrlsForTask, selectedTaskId],
  );

  const handlePreviewModalMediaError = useCallback(
    (url?: string) => {
      handleMediaAssetError(url);
      if (!videoPreviewModal?.generationId) return;
      if (url && url !== videoPreviewModal.url) return;
      setVideoPreviewNeedsRefresh(true);
    },
    [handleMediaAssetError, videoPreviewModal],
  );

  useEffect(() => {
    setVideoPreviewNeedsRefresh(false);
  }, [videoPreviewModal?.url]);

  useEffect(() => {
    if (!videoPreviewNeedsRefresh) return;
    if (!videoPreviewModal?.generationId || !task) return;
    if (videoPreviewModal.taskId && task.taskId !== videoPreviewModal.taskId) return;
    const refreshedUrl = task.segmentGenerations?.[videoPreviewModal.generationId]?.downloadUrl;
    if (!refreshedUrl || refreshedUrl === videoPreviewModal.url) return;
    setVideoPreviewModal((previous) => {
      if (!previous || previous.generationId !== videoPreviewModal.generationId) return previous;
      if (previous.url === refreshedUrl) return previous;
      return { ...previous, url: refreshedUrl };
    });
    setVideoPreviewNeedsRefresh(false);
  }, [task, videoPreviewModal, videoPreviewNeedsRefresh]);

  useEffect(() => {
    if (!videoCompareModal || !task) return;
    const shouldRefreshOriginal = isPresignedUrlNearExpiry(videoCompareModal.originalUrl);
    const shouldRefreshCompare = isPresignedUrlNearExpiry(videoCompareModal.compareUrl);
    if (!shouldRefreshOriginal && !shouldRefreshCompare) return;

    const nextOriginalUrl = (() => {
      if (
        shouldRefreshOriginal &&
        videoCompareModal.preferGenerationInputMediaAsOriginal &&
        videoCompareModal.compareGenerationId
      ) {
        const generation = task.segmentGenerations?.[videoCompareModal.compareGenerationId];
        if (isLikelyVideoAssetUrl(generation?.inputMediaUrl)) return generation?.inputMediaUrl ?? videoCompareModal.originalUrl;
      }
      if (shouldRefreshOriginal && videoCompareModal.originalSegmentId) {
        const segment = task.segments.find((item) => item.segmentId === videoCompareModal.originalSegmentId);
        if (segment?.segmentClipUrl) return segment.segmentClipUrl;
        return task.video?.editSource?.downloadUrl ?? task.video?.previewSource?.downloadUrl ?? videoCompareModal.originalUrl;
      }
      return videoCompareModal.originalUrl;
    })();
    const nextCompareUrl = shouldRefreshCompare &&
      videoCompareModal.compareGenerationId && task.segmentGenerations?.[videoCompareModal.compareGenerationId]?.downloadUrl
        ? task.segmentGenerations[videoCompareModal.compareGenerationId]?.downloadUrl ?? videoCompareModal.compareUrl
        : videoCompareModal.compareUrl;
    if (nextOriginalUrl === videoCompareModal.originalUrl && nextCompareUrl === videoCompareModal.compareUrl) return;
    setVideoCompareModal((previous) => {
      if (!previous) return previous;
      if (previous.originalUrl === nextOriginalUrl && previous.compareUrl === nextCompareUrl) return previous;
      return {
        ...previous,
        originalUrl: nextOriginalUrl,
        compareUrl: nextCompareUrl,
      };
    });
  }, [task, videoCompareModal]);

  useEffect(() => {
    if (isPageVisible) {
      const hiddenAt = pageHiddenAtRef.current;
      pageHiddenAtRef.current = null;
      if (!hiddenAt) return;
      if (Date.now() - hiddenAt < URL_REFRESH_IDLE_MS) return;
      refreshSignedUrlsForTask(selectedTaskId, { includeReport: isReportTab });
      if (reportTaskId && reportTaskId !== selectedTaskId) {
        refreshSignedUrlsForTask(reportTaskId, { includeReport: isReportTab });
      }
      return;
    }
    pageHiddenAtRef.current = Date.now();
  }, [isPageVisible, isReportTab, refreshSignedUrlsForTask, reportTaskId, selectedTaskId]);

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
    const leavingPostProcess = tab === "merge" && nextTab !== "merge";
    if (leavingPostProcess) {
      setMotionSyncModalExportId(null);
      setVideoCleanupModal({
        isOpen: false,
        generationId: null,
      });
    }
    if (
      tab === "timeline" &&
      nextTab !== "timeline" &&
      nextTab !== "report" &&
      nextTab !== "custom_qc" &&
      nextTab !== "api_logs" &&
      nextTab !== "asset_library" &&
      nextTab !== "admin"
    ) {
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

  async function uploadEditVideoReferenceImage(file: File): Promise<void> {
    if (!selectedTaskId) throw new Error("No task selected");
    const init = await apiClient.initEditVideoReferenceUpload(selectedTaskId, {
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
    await apiClient.completeEditVideoReferenceUpload(selectedTaskId, {
      referenceId: init.referenceId,
      uploadKey: init.key,
      filename: file.name,
    });
    await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
  }

  async function generateEditVideoReferenceImage(payload: {
    model: "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro";
    prompt: string;
  }): Promise<void> {
    if (!selectedTaskId) throw new Error("No task selected");
    await apiClient.generateEditVideoReference(selectedTaskId, payload);
    await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
  }

  async function deleteEditVideoReference(referenceId: string): Promise<void> {
    if (!selectedTaskId) throw new Error("No task selected");
    await deleteAssetMutation.mutateAsync({
      taskId: selectedTaskId,
      payload: {
        assetType: "edit_video_reference",
        referenceId,
      },
    });
    setEditVideoSelectedReferenceIds((previous) => previous.filter((id) => id !== referenceId));
  }

  function toggleEditVideoReferenceSelection(referenceId: string): void {
    setEditVideoSelectedReferenceIds((previous) => {
      if (previous.includes(referenceId)) {
        return previous.filter((id) => id !== referenceId);
      }
      if (previous.length >= 3) {
        setAppUiError("Select up to 3 reference images.");
        return previous;
      }
      return [...previous, referenceId];
    });
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
  const primaryTabs = useMemo(
    () => (generationInputMode === "edit_video" ? PRIMARY_WORKFLOW_TABS.filter((tabItem) => tabItem.id !== "post") : PRIMARY_WORKFLOW_TABS),
    [generationInputMode],
  );
  const {
    currentReferenceSegment,
    currentReferenceStartImageUrl,
    currentReferenceEndImageUrl,
    currentReferenceAssets,
    currentReferenceWarning,
  } = useCurrentWorkingReferenceState({
    activeWorkflowSection,
    selectedSegment,
    defaultVideoSegment,
    task,
    selectedPreviewGeneration,
    refineStartVariantId: refineSourceVariantIds.first,
    refineEndVariantId: refineSourceVariantIds.last,
    compareStartVariantId: compareVariantIds.first,
    compareEndVariantId: compareVariantIds.last,
    editFirstFrameId: editFirstFrame?.frameId ?? null,
    editLastFrameId: editLastFrame?.frameId ?? null,
    generationInputMode,
    wholeVideoNeedsChunking,
    frameVariantImageUrl,
    generationThumbnailUrl,
  });

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
      pendingEditJobs,
      dismissPendingEditJob,
      requestCancelPendingEditJob,
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
      pendingEditJobs,
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
      dismissPendingEditJob,
      requestCancelPendingEditJob,
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

  const editVideoReferencesTabCtx = useMemo<EditVideoReferencesTabCtx>(
    () => ({
      references: editVideoReferences,
      selectedReferenceIds: editVideoSelectedReferenceIds,
      toggleReferenceSelection: toggleEditVideoReferenceSelection,
      removeReference: deleteEditVideoReference,
      uploadReferenceImage: uploadEditVideoReferenceImage,
      generateReferenceImage: generateEditVideoReferenceImage,
    }),
    [
      editVideoReferences,
      editVideoSelectedReferenceIds,
      toggleEditVideoReferenceSelection,
      deleteEditVideoReference,
      uploadEditVideoReferenceImage,
      generateEditVideoReferenceImage,
    ],
  );

  const generateTabCtx = useMemo<GenerateTabCtx>(
    () => ({
      viewMode: "outputs",
      onNext: () => {
        void handleTabChange(generationInputMode === "edit_video" ? "assets" : "merge");
      },
      nextDisabled: !selectedPreviewGeneration || selectedPreviewGeneration.status !== "complete" || !selectedPreviewGeneration.downloadUrl,
      nextWarning:
        !selectedPreviewGeneration || selectedPreviewGeneration.status !== "complete" || !selectedPreviewGeneration.downloadUrl
          ? generationInputMode === "edit_video"
            ? "Choose a completed output before continuing to Assets."
            : "Choose a completed output before continuing to Post Process."
          : null,
      generationModelByInput,
      generationInputMode,
      editVideoSelectedReferenceIds,
      editVideoReferenceWarning,
      editVideoReferencePreview,
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
      generationModelOptions: generationModelOptionsForInput,
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
      promptWizardSupported: Boolean(promptWizardConfig),
      improvePromptWithWizard: async () => {
        const result = await improvePromptWizardMutation.mutateAsync();
        setLumaPrompt(result.recommended_prompt);
        return { userAdvice: result.user_advice, warnings: result.warnings };
      },
      isPromptWizardPending: improvePromptWizardMutation.isPending,
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
      originalSegmentCompareUrl: stableOriginalSegmentCompareUrl,
      uploadManualGeneratedVideo,
      selectedPreviewGeneration,
      task,
      originalPreviewIsSegmentClip,
      selectedSegmentGenerations,
      pendingGenerations,
      dismissPendingGenerationJob,
      removeFailedPendingGenerationJob,
      requestCancelPendingGenerationJob,
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
      onAssetError: handleMediaAssetError,
      handleDeleteAsset,
      setGenerationCardsVisible,
    }),
    [
      handleTabChange,
      generationModelByInput,
      generationInputMode,
      editVideoSelectedReferenceIds,
      editVideoReferenceWarning,
      editVideoReferencePreview,
      selectedSegment,
      isWholeVideoSelection,
      wholeVideoNeedsChunking,
      lumaModel,
      describeSelectedFrameSource,
      editFirstFrame,
      editLastFrame,
      refineSourceVariantIds,
      compareVariantIds,
      generationModelOptionsForInput,
      advancedMode,
      replicateKlingMode,
      replicateKlingV3Mode,
      wan27Resolution,
      happyHorseResolution,
      wan27NegativePrompt,
      sora2Resolution,
      preserveFrames,
      lumaPrompt,
      promptWizardConfig,
      improvePromptWizardMutation,
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
      stableOriginalSegmentCompareUrl,
      uploadManualGeneratedVideo,
      selectedPreviewGeneration,
      task,
      originalPreviewIsSegmentClip,
      selectedSegmentGenerations,
      pendingGenerations,
      dismissPendingGenerationJob,
      removeFailedPendingGenerationJob,
      selectedReportOutputs,
      generationCardsVisible,
      selectSegmentGeneration,
      setVideoCompareModal,
      openVideoCleanupModalForGeneration,
      selectedTaskId,
      refreshSignedUrlsForTask,
      handleDeleteAsset,
      requestCancelPendingGenerationJob,
      removeFailedPendingGenerationJob,
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
      mergeFadeInFrames,
      setMergeFadeInFrames,
      mergeFadeOutFrames,
      setMergeFadeOutFrames,
      mergeSourceRestartFrame,
      setMergeSourceRestartFrame,
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
      mergeSourceRestartFrameLowerBound,
      mergeSourceRestartFrameUpperBound,
      mergeSourceRestartFrameEffective,
      mergeGeneratedStartAnchor,
      mergeGeneratedMaxFrameIndex: generatedMaxFrameIndex,
      mergeFadeInClamped,
      mergeFadeOutClamped,
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
      cancelChunkedGeneration: cancelChunkedGenerationMutation.mutate,
      isChunkedGenerationMutationPending: cancelChunkedGenerationMutation.isPending,
      sortedExports,
      humanizeFilename,
      keyBasenameFromS3Key,
      formatCompactTimestamp,
      generationThumbnailUrl,
      openGenerationPreview: (generation) => {
        if (!generation.downloadUrl) return;
        setVideoPreviewModal({
          url: generation.downloadUrl,
          label: describeGeneration(generation),
          taskId: task?.taskId,
          generationId: generation.genId,
        });
      },
      openGenerationCompare: (generation) => {
        const shouldUseInputVideo = isLikelyVideoAssetUrl(generation.inputMediaUrl);
        const originalUrl = shouldUseInputVideo ? generation.inputMediaUrl ?? mergeOriginalVideoForPreview : mergeOriginalVideoForPreview;
        if (!originalUrl || !generation.downloadUrl) return;
        setVideoCompareModal({
          originalUrl,
          compareUrl: generation.downloadUrl,
          label: describeGeneration(generation),
          posterUrl: generationThumbnailUrl(generation),
          segmentStartSec: segmentWindow?.startSec,
          originalIsSegmentClip: shouldUseInputVideo || originalPreviewIsSegmentClip,
          originalSegmentId: shouldUseInputVideo ? undefined : mergeTargetSegment?.segmentId,
          compareGenerationId: generation.genId,
          preferGenerationInputMediaAsOriginal: shouldUseInputVideo,
        });
      },
      canOpenGenerationCompare: Boolean(mergeOriginalVideoForPreview),
      deleteGenerationOutput: async (generation) => {
        if (!task?.taskId) return;
        await handleDeleteAsset({
          id: `generation:${task.taskId}:${generation.genId}`,
          taskId: task.taskId,
          title: describeGeneration(generation),
          subtitle: `${generation.luma.model}/${generation.luma.mode}`,
          createdAt: generation.createdAt,
          previewUrl: generation.downloadUrl ?? "",
          downloadUrl: generation.downloadUrl ?? "",
          mediaType: "video",
          deletePayload: { assetType: "segment_generation", genId: generation.genId },
        });
      },
      onAssetError: handleMediaAssetError,
      openMotionSyncModal,
      queueTopazUpscale: (exportId, payload) => {
        runTopazUpscaleMutation.mutate({ exportId, payload });
      },
      isTopazUpscalePending: runTopazUpscaleMutation.isPending,
      topazUpscalePendingExportId,
      task,
      hasMultiChunkOutput: selectedSegmentChunkedGenerationRuns.some((run) => run.chunks.length > 1),
      onTrackJobId: (jobId) => setJobIds((previous) => appendTrackedJobId(previous, jobId)),
      refreshTask: async () => {
        if (!selectedTaskId) return;
        await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
        await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      },
    }),
    [
      selectedTaskId,
      queryClient,
      setTab,
      mergeTargetGeneration,
      generationInputMode,
      mergeTargetGeneration,
      mergeTargetSegment,
      getSegmentForGeneration,
      task?.video?.editSource?.frameCount,
      mergeMaxFrameIndex,
      mergeInsertStartFrame,
      mergeGeneratedDurationFrames,
      mergeTrimStartFrames,
      mergeTrimEndFrames,
      mergeFadeInFrames,
      mergeFadeOutFrames,
      mergeSourceRestartFrame,
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
      mergeSourceRestartFrameLowerBound,
      mergeSourceRestartFrameUpperBound,
      mergeSourceRestartFrameEffective,
      mergeGeneratedStartAnchor,
      generatedMaxFrameIndex,
      mergeFadeInClamped,
      mergeFadeOutClamped,
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
      cancelChunkedGenerationMutation.mutate,
      cancelChunkedGenerationMutation.isPending,
      sortedExports,
      generationThumbnailUrl,
      openMotionSyncModal,
      handleDeleteAsset,
      mergeOriginalVideoForPreview,
      segmentWindow?.startSec,
      originalPreviewIsSegmentClip,
      runTopazUpscaleMutation.mutate,
      runTopazUpscaleMutation.isPending,
      topazUpscalePendingExportId,
      task,
      selectedSegmentChunkedGenerationRuns,
    ],
  );

  const { assetsTabCtx, assetLibraryTabCtx } = useAssetsTabContexts({
    selectedTaskId,
    task,
    assetsLoading: assetsTabLoading,
    assetLibraryLoading: assetLibraryTabLoading,
    mergedVideoAssets,
    mergedAssetsVisible,
    setMergedAssetsVisible,
    generatedVideoAssets,
    generatedAssetsVisible,
    setGeneratedAssetsVisible,
    editedFrameAssets,
    editedFrameAssetsVisible,
    setEditedFrameAssetsVisible,
    libraryMergedVideoAssets,
    libraryMergedAssetsVisible,
    setLibraryMergedAssetsVisible,
    libraryGeneratedVideoAssets,
    libraryGeneratedAssetsVisible,
    setLibraryGeneratedAssetsVisible,
    libraryEditedFrameAssets,
    libraryEditedFrameAssetsVisible,
    setLibraryEditedFrameAssetsVisible,
    selectedReportOutputs,
    reportOutputRefKey,
    toggleCustomReportOutput,
    clearCustomReportOutputs,
    handleDeleteAsset,
    createCustomReport: createCustomReportMutation.mutateAsync,
    isCreatingCustomReport: createCustomReportMutation.isPending,
    formatAssetDate,
    goToReport: (taskId: string) => {
      goToReport(taskId, "reports", null);
    },
  });

  if (!isAuthed) {
    return (
      <main className="min-h-screen bg-bg p-8 text-ink">
        <div className="mx-auto max-w-3xl rounded-2xl border border-ink/10 bg-card p-8 shadow-sm">
          <h1 className="text-3xl font-semibold">AI-assisted VFX Micro Pipeline</h1>
          <p className="mt-3 text-ink/70">Authenticate with Cognito to start creating tasks and processing video segments.</p>
          <button type="button" className="mt-6 rounded-lg bg-accent px-5 py-3 text-white" onClick={() => login()}>
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
          onOpenAdmin={() => {
            void handleTabChange("admin");
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
            {tab !== "custom_qc" && tab !== "api_logs" && tab !== "asset_library" && tab !== "admin" ? (
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
                {generationInputMode === "edit_video" ? <EditVideoReferencesTab ctx={editVideoReferencesTabCtx} /> : <EditFrameTab ctx={editFrameTabCtx} />}
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

            {tab === "admin" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading admin...</p>}>
                <AdminPromptWizardPage />
              </Suspense>
            )}
          </div>

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
        onMediaError={handlePreviewModalMediaError}
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

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
import WorkflowTaskPickerModal from "./components/tasks/WorkflowTaskPickerModal";
import ReferenceImagePickerModal from "./components/workflow/ReferenceImagePickerModal";
import { CurrentWorkingReferencePanel } from "./components/workflow/WorkingRangePanel";
import {
  taskRoute,
  workflowRoute,
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
import { useCharacterAnimateConfigState } from "./hooks/useCharacterAnimateConfigState";
import { useGenerationPromptGuidance } from "./hooks/useGenerationPromptGuidance";
import { useGenerationMergeState } from "./hooks/useGenerationMergeState";
import { useSelectedSegmentPreview } from "./hooks/useSelectedSegmentPreview";
import { useTaskDataQueries } from "./hooks/useTaskDataQueries";
import { useReportOutputSelection } from "./hooks/useReportOutputSelection";
import {
  editVideoReferenceLimitForModel,
  prepareReferenceImageUpload,
} from "./lib/referenceImages";
import { getPromptWizardModelConfig, type PromptWizardMode, type PromptWizardResult } from "./lib/promptWizardConfig";
import type {
  PatchEditModelId,
  VideoModeId,
  VideoModelId,
} from "./lib/generated/videoContracts";
import { getGenerationModeConfig, type GenerateInputMode } from "./lib/generationModeRegistry";
import { getGenerationOrigin, isPostProcessDerivedGeneration, matchesGenerateStepGrid } from "./lib/generationOrigin";
import {
  DEFAULT_TASK_WORKFLOW_ID,
  HOME_TASK_WORKFLOW_IDS,
  getFixedCharacterAnimateModeForWorkflow,
  getFixedGenerationInputModeForWorkflow,
  getTaskWorkflowConfig,
  isCharacterAnimateWorkflowId,
  isPrevizWorkflowId,
  isSourceVideoWorkflowId,
  normalizeTaskWorkflowId,
  type TaskWorkflowId,
} from "./lib/taskWorkflows";
import { resolveLatestTaskThumbnailUrl } from "./lib/taskPreview";
import { type PrimaryWorkflowSection } from "./lib/workflowSections";
import { currentUser, login, logout } from "./lib/auth";
import type { EditFrameTabCtx } from "./pages/workflow/EditFrameTab";
import type { EditVideoReferencesTabCtx } from "./pages/workflow/EditVideoReferencesTab";
import type { GenerateTabCtx } from "./pages/workflow/GenerateTab";
import type { MergeTabCtx } from "./pages/workflow/MergeTab";
import type { PickFrameTabCtx } from "./pages/workflow/PickFrameTab";
import type { RefineFramesTabCtx } from "./pages/workflow/RefineFramesTab";
import HomePage from "./pages/HomePage";
import WorkflowLandingPage from "./pages/WorkflowLandingPage";
import CharacterAnimateGenerateTab from "./pages/characterAnimate/CharacterAnimateGenerateTab";
import CharacterAnimatePostProcessTab from "./pages/characterAnimate/CharacterAnimatePostProcessTab";
import CharacterAnimatePlaceholderTab from "./pages/characterAnimate/CharacterAnimatePlaceholderTab";
import PrevizEditTab, { type PrevizEditTabCtx } from "./pages/previz/PrevizEditTab";
import PrevizGenerateTab, { type PrevizGenerateTabCtx } from "./pages/previz/PrevizGenerateTab";
import PrevizSelectTab, { type PrevizSelectTabCtx } from "./pages/previz/PrevizSelectTab";
import { useUiStore } from "./store/uiStore";
import type {
  CurrentUserInfo,
  CustomReportOutputRef,
  EditVideoReference,
  ExportRecord,
  FrameVariant,
  JobStatus,
  SegmentGeneration,
  SegmentRecord,
  TaskDetail,
  TaskSummary,
} from "./types/api";
import type { LibraryAsset, LibraryAssetDeletePayload } from "./types/libraryAsset";
import type { ReferencePickerItem, ReferencePickerVideoItem, WorkingReferencePreviewItem } from "./types/referencePicker";

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
const AdminWorkspacePage = lazy(() => import("./pages/AdminWorkspacePage"));
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
    generation.posterUrl ??
    generation.sourceFirstFrameCaptureUrl ??
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

function aspectRatioHintFromDimensions(width: number | undefined, height: number | undefined): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return `${width}:${height}`;
}

function keyBasenameFromS3Key(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function mergeEditVideoReferences(
  existing: EditVideoReference[] | undefined,
  incoming: EditVideoReference[],
): EditVideoReference[] {
  const output = [...(existing ?? [])];
  const byId = new Map(output.map((item, index) => [item.referenceId, index]));
  for (const reference of incoming) {
    const existingIndex = byId.get(reference.referenceId);
    if (existingIndex == null) {
      byId.set(reference.referenceId, output.length);
      output.push(reference);
      continue;
    }
    output[existingIndex] = { ...output[existingIndex], ...reference };
  }
  return output;
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
  return task?.video?.editSource?.frameCount ?? task?.sourceMedia?.editSource?.frameCount ?? 0;
}

function fpsValue(task: TaskDetail | undefined): number {
  const fps = task?.video?.editSource?.fps ?? task?.sourceMedia?.editSource?.fps;
  if (!fps || !fps.den) return 30;
  return fps.num / fps.den;
}

const MODEL_FRAME_BUDGET_FPS = 24;

function videoModelLabel(model: VideoModel): string {
  if (model === "ray-3.2-720p") return "Luma Ray 3.2 720p";
  if (model === "ray-3.2-1080p") return "Luma Ray 3.2 1080p";
  if (model === "runway-gen4.5") return "Runway Gen-4.5";
  if (model === "sora-2-image-to-video") return "Sora 2 Image to Video";
  if (model === "happy-horse-video-edit") return "Happy Horse 1.0 Video Edit";
  if (model === "happy-horse-image-to-video") return "Happy Horse 1.0 Image to Video";
  if (model === "runway-gen4-aleph") return "Runway Aleph 2.0";
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

function videoModelDurationConstraints(model: VideoModel): {
  minSeconds?: number;
  maxSeconds: number;
  frameBudgetFps?: number | null;
} {
  if (model === "ray-3.2-720p" || model === "ray-3.2-1080p") return { minSeconds: 1, maxSeconds: 18 };
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
  { id: "ray-3.2-720p:start_video:flex_1", label: "Luma Ray 3.2 720p (Source video edit)", inputMode: "start_video", lumaModel: "ray-3.2-720p", mode: "flex_1" },
  { id: "ray-3.2-1080p:start_video:flex_1", label: "Luma Ray 3.2 1080p (Source video edit)", inputMode: "start_video", lumaModel: "ray-3.2-1080p", mode: "flex_1" },
  { id: "happy-horse-video-edit:start_video:happy_horse_video_edit", label: "Happy Horse 1.0 Video Edit (Start frame + video)", inputMode: "start_video", lumaModel: "happy-horse-video-edit", mode: "happy_horse_video_edit" },
  { id: "runway-gen4-aleph:start_video:runway_aleph_v2v", label: "Runway Aleph 2.0 (Start frame + video)", inputMode: "start_video", lumaModel: "runway-gen4-aleph", mode: "runway_aleph_v2v" },
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
  selectionKind = "frame",
}: {
  title: string;
  frame: { frameId: string; frameIndex: number; timecode: string; imageUrl?: string } | null;
  selectLabel: string;
  onSelect: () => void;
  onClear: () => void;
  selectionKind?: "frame" | "point";
}) {
  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <p className="mb-2 text-sm font-semibold">{title}</p>
      {frame?.imageUrl ? (
        <div>
          <img src={frame.imageUrl} alt={`${title} preview`} className="max-h-28 w-full rounded-md bg-bg object-contain" loading="lazy" decoding="async" />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-ink/70">
              {selectionKind === "point" ? `point ${frame.timecode}` : `frame ${frame.frameIndex} (${frame.timecode})`}
            </p>
            <button
              type="button"
              onClick={onClear}
              className="rounded border border-ink/20 bg-white px-2 py-1 text-xs"
              title={selectionKind === "point" ? "Clear selected point" : "Clear selected frame"}
            >
              {selectionKind === "point" ? "Clear point selection" : "Clear Frame selection"}
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
  const [assetLibraryScope, setAssetLibraryScope] = useState<"mine" | "project" | "all">("mine");
  const [apiLogsScope, setApiLogsScope] = useState<"mine" | "all">("mine");
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
  const [referenceImageAssetsVisible, setReferenceImageAssetsVisible] = useState(6);
  const [generatedAssetsVisible, setGeneratedAssetsVisible] = useState(6);
  const [postProcessAssetsVisible, setPostProcessAssetsVisible] = useState(6);
  const [orphanedAssetsVisible, setOrphanedAssetsVisible] = useState(6);
  const [audioAssetsVisible, setAudioAssetsVisible] = useState(6);
  const [libraryMergedAssetsVisible, setLibraryMergedAssetsVisible] = useState(6);
  const [libraryEditedFrameAssetsVisible, setLibraryEditedFrameAssetsVisible] = useState(6);
  const [libraryReferenceImageAssetsVisible, setLibraryReferenceImageAssetsVisible] = useState(6);
  const [libraryGeneratedAssetsVisible, setLibraryGeneratedAssetsVisible] = useState(6);
  const [libraryPostProcessAssetsVisible, setLibraryPostProcessAssetsVisible] = useState(6);
  const [libraryOrphanedAssetsVisible, setLibraryOrphanedAssetsVisible] = useState(6);
  const [libraryAudioAssetsVisible, setLibraryAudioAssetsVisible] = useState(6);
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
  const {
    characterAnimateMode,
    setCharacterAnimateMode,
    setCharacterAnimateModelByMode,
    characterAnimateModelOptions,
    selectedCharacterAnimateModel,
  } = useCharacterAnimateConfigState();
  const [characterAnimatePrompt, setCharacterAnimatePrompt] = useState("");
  const [characterAnimateOutputAspectRatio, setCharacterAnimateOutputAspectRatio] = useState("1280:720");
  const [characterAnimateBodyControl, setCharacterAnimateBodyControl] = useState(true);
  const [characterAnimateExpressionIntensity, setCharacterAnimateExpressionIntensity] = useState(3);
  const [characterAnimateKlingMode, setCharacterAnimateKlingMode] = useState<"std" | "pro">("pro");
  const [characterAnimateKlingCharacterOrientation, setCharacterAnimateKlingCharacterOrientation] = useState<"image" | "video">("image");
  const [characterAnimateOmnihumanResolution, setCharacterAnimateOmnihumanResolution] = useState<"720p" | "1080p">("720p");
  const [characterAnimateSeedanceResolution, setCharacterAnimateSeedanceResolution] = useState<"480p" | "720p" | "1080p">("720p");
  const [characterAnimateSeedanceAspectRatio, setCharacterAnimateSeedanceAspectRatio] = useState<"auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16">("auto");
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
  const [audioPreviewModal, setAudioPreviewModal] = useState<{ url: string; label: string; waveformUrl?: string | null } | null>(null);
  const [videoPreviewNeedsRefresh, setVideoPreviewNeedsRefresh] = useState(false);
  const [imageCompareModal, setImageCompareModal] = useState<{ originalUrl: string; compareUrl: string; label: string } | null>(null);
  const [videoCompareModal, setVideoCompareModal] = useState<{
    originalUrl: string;
    compareUrl: string;
    label: string;
    posterUrl?: string | null;
    originalPosterUrl?: string | null;
    originalMediaType?: "video" | "audio";
    originalAudioUrl?: string | null;
    originalWaveformUrl?: string | null;
    segmentStartSec?: number;
    originalIsSegmentClip?: boolean;
    originalSegmentId?: string;
    compareGenerationId?: string;
    preferGenerationInputMediaAsOriginal?: boolean;
  } | null>(null);
  const [, setReportGraphModal] = useState<{ url: string; label: string } | null>(null);
  const [motionSyncModalExportId, setMotionSyncModalExportId] = useState<string | null>(null);
  const [topazUpscalePendingExportId, setTopazUpscalePendingExportId] = useState<string | null>(null);
  const [topazUpscalePendingGenerationId, setTopazUpscalePendingGenerationId] = useState<string | null>(null);
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
  const [lengthenPendingGenId, setLengthenPendingGenId] = useState<string | null>(null);
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
  const [editVideoToolSelectedReferenceIds, setEditVideoToolSelectedReferenceIds] = useState<string[]>([]);
  const [editVideoReferencePromptDraft, setEditVideoReferencePromptDraft] = useState("");
  const [isReferenceImagePickerOpen, setIsReferenceImagePickerOpen] = useState(false);
  const [taskPickerWorkflowId, setTaskPickerWorkflowId] = useState<TaskWorkflowId | null>(null);
  const [isReferenceImagePickerSaving, setIsReferenceImagePickerSaving] = useState(false);
  const [isToolReferenceImagePickerOpen, setIsToolReferenceImagePickerOpen] = useState(false);
  const [isToolReferenceImagePickerSaving, setIsToolReferenceImagePickerSaving] = useState(false);
  const [isPrevizReferenceImagePickerOpen, setIsPrevizReferenceImagePickerOpen] = useState(false);
  const [isPrevizReferenceImagePickerSaving, setIsPrevizReferenceImagePickerSaving] = useState(false);
  const [isPrevizEditReferenceImagePickerOpen, setIsPrevizEditReferenceImagePickerOpen] = useState(false);
  const [isPrevizEditReferenceImagePickerSaving, setIsPrevizEditReferenceImagePickerSaving] = useState(false);
  const [isPrevizGenerateReferenceImagePickerOpen, setIsPrevizGenerateReferenceImagePickerOpen] = useState(false);
  const [isPrevizGenerateReferenceImagePickerSaving, setIsPrevizGenerateReferenceImagePickerSaving] = useState(false);
  const [isPrevizToolReferenceImagePickerOpen, setIsPrevizToolReferenceImagePickerOpen] = useState(false);
  const [isPrevizToolReferenceImagePickerSaving, setIsPrevizToolReferenceImagePickerSaving] = useState(false);
  const [isEditFrameReferenceImagePickerOpen, setIsEditFrameReferenceImagePickerOpen] = useState(false);
  const [isEditFrameReferenceImagePickerSaving, setIsEditFrameReferenceImagePickerSaving] = useState(false);
  const [previzReferencePromptDraft, setPrevizReferencePromptDraft] = useState("");
  const [previzFramePromptDraft, setPrevizFramePromptDraft] = useState("");
  const [previzGenerateModel, setPrevizGenerateModel] = useState<"veo_3_1" | "happy_horse_1_0" | "seedance_2_0">("veo_3_1");
  const [previzGeneratePrompt, setPrevizGeneratePrompt] = useState("");
  const [previzGenerateDurationSec, setPrevizGenerateDurationSec] = useState(8);
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
  const meQuery = useQuery<CurrentUserInfo>({
    queryKey: ["me"],
    queryFn: () => apiClient.me(),
    enabled: isAuthed,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const isAdmin = Boolean(meQuery.data?.isAdmin);
  const availableProjects = useMemo(() => meQuery.data?.projects ?? [], [meQuery.data?.projects]);
  const adminAllTasksQuery = useQuery({
    queryKey: ["tasks", "all"],
    queryFn: async () => (await apiClient.listTasks({ scope: "all" })).tasks,
    enabled: isAuthed && isAdmin && assetLibraryScope === "all",
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const effectiveRouteState = routeOverride ?? routeState;
  const isHomeRoute = effectiveRouteState.kind === "home";
  const isWorkflowLandingRoute = effectiveRouteState.kind === "workflow";
  const tab: TabId = effectiveRouteState.tab ?? "timeline";
  const activeWorkflowSection = workflowSectionForTab(tab);
  const activePostTab: TabId = tab === "merge" ? tab : "merge";
  const isReportTab = tab === "report";
  const selectedTaskId =
    isHomeRoute || isWorkflowLandingRoute ? null : effectiveRouteState.taskId ?? storeSelectedTaskId;
  const reportTaskId = selectedTaskId;
  const selectedTaskSummary = useMemo(
    () => (tasksQuery.data ?? []).find((taskItem) => taskItem.taskId === selectedTaskId) ?? null,
    [selectedTaskId, tasksQuery.data],
  );
  const currentProjectId = useMemo(
    () => {
      const resolved = String((selectedTaskSummary?.projectId ?? "") || "").trim();
      return resolved || null;
    },
    [selectedTaskSummary?.projectId],
  );
  const currentProject = useMemo(
    () => availableProjects.find((project) => project.projectId === currentProjectId) ?? null,
    [availableProjects, currentProjectId],
  );
  const isProjectScopeAvailable = Boolean(currentProjectId && currentProject);
  useEffect(() => {
    if (assetLibraryScope === "project" && !isProjectScopeAvailable) {
      setAssetLibraryScope("mine");
    }
  }, [assetLibraryScope, isProjectScopeAvailable]);
  const enableReferenceAssetTaskQueries =
    isReferenceImagePickerOpen ||
    isToolReferenceImagePickerOpen ||
    isEditFrameReferenceImagePickerOpen ||
    isPrevizReferenceImagePickerOpen ||
    isPrevizEditReferenceImagePickerOpen ||
    isPrevizGenerateReferenceImagePickerOpen ||
    isPrevizToolReferenceImagePickerOpen;
  const projectTasksQuery = useQuery({
    queryKey: ["tasks", "project", currentProjectId ?? "none"],
    queryFn: async () => (await apiClient.listTasks({ scope: "project", projectId: currentProjectId })).tasks,
    enabled: isAuthed && Boolean(currentProjectId) && (assetLibraryScope === "project" || enableReferenceAssetTaskQueries),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (!routeOverride) return;
    const routeSettled =
      routeState.kind === routeOverride.kind &&
      routeState.taskId === routeOverride.taskId &&
      routeState.tab === routeOverride.tab &&
      routeState.workflowId === routeOverride.workflowId;
    if (routeSettled) {
      setRouteOverride(null);
    }
  }, [routeOverride, routeState.kind, routeState.tab, routeState.taskId, routeState.workflowId]);

  const setTab = useCallback(
    (nextTab: TabId, taskIdOverride?: string | null, replace = false) => {
      const targetTaskId = taskIdOverride ?? selectedTaskId ?? tasksQuery.data?.[0]?.taskId ?? null;
      if (!targetTaskId) {
        if (nextTab === "admin") {
          setRouteOverride({ kind: "direct", taskId: null, tab: "admin", workflowId: null });
          navigate("/admin", { replace });
        }
        return;
      }
      setRouteOverride({ kind: "task", taskId: targetTaskId, tab: nextTab, workflowId: null });
      navigate(taskRoute(targetTaskId, nextTab), { replace });
    },
    [navigate, selectedTaskId, tasksQuery.data],
  );

  const goHome = useCallback(
    (replace = false) => {
      setRouteOverride({ kind: "home", taskId: null, tab: null, workflowId: null });
      navigate("/", { replace });
    },
    [navigate],
  );

  const openWorkflowLanding = useCallback(
    (workflowId: TaskWorkflowId, replace = false) => {
      setRouteOverride({ kind: "workflow", taskId: null, tab: null, workflowId });
      navigate(workflowRoute(workflowId), { replace });
    },
    [navigate],
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
      setRouteOverride({ kind: "task", taskId, tab: "report", workflowId: null });
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
    newTaskScenePrompt,
    newTaskWorkflowId,
    setNewTaskScenePrompt,
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
  const assetTaskRequests = useMemo(() => {
    if (tab === "asset_library" && assetLibraryScope === "all" && isAdmin) {
      return (adminAllTasksQuery.data ?? []).map((taskSummary) => ({
        taskSummary,
        scope: "all" as const,
        projectId: null,
      }));
    }

    if (tab === "asset_library" && assetLibraryScope === "project" && isProjectScopeAvailable) {
      return (projectTasksQuery.data ?? []).map((taskSummary) => ({
        taskSummary,
        scope: "project" as const,
        projectId: currentProjectId,
      }));
    }

    const requests = new Map<
      string,
      {
        taskSummary: TaskSummary;
        scope: "mine" | "all" | "project";
        projectId?: string | null;
      }
    >();

    for (const taskSummary of tasksQuery.data ?? []) {
      requests.set(taskSummary.taskId, {
        taskSummary,
        scope: "mine",
        projectId: null,
      });
    }

    if (enableReferenceAssetTaskQueries && isProjectScopeAvailable) {
      for (const taskSummary of projectTasksQuery.data ?? []) {
        if (requests.has(taskSummary.taskId)) continue;
        requests.set(taskSummary.taskId, {
          taskSummary,
          scope: "project",
          projectId: currentProjectId,
        });
      }
    }

    return Array.from(requests.values());
  }, [
    adminAllTasksQuery.data,
    assetLibraryScope,
    currentProjectId,
    enableReferenceAssetTaskQueries,
    isAdmin,
    isProjectScopeAvailable,
    projectTasksQuery.data,
    tab,
    tasksQuery.data,
  ]);

  const { taskQuery, reportTaskQuery, task, reportTask, assetTasks, assetsLoading, assetLibraryLoading } =
    useTaskDataQueries({
      isAuthed,
      selectedTaskId,
      reportTaskId,
      isReportTab,
      isAssetLibraryTab: tab === "asset_library",
      enableAssetTaskQueries: enableReferenceAssetTaskQueries,
      isPageVisible,
      assetTaskRequests,
    });
  const resolvedTaskWorkflowId =
    effectiveRouteState.workflowId ?? task?.workflowId ?? selectedTaskSummary?.workflowId ?? null;
  const currentTaskWorkflowId = normalizeTaskWorkflowId(
    resolvedTaskWorkflowId ?? DEFAULT_TASK_WORKFLOW_ID,
  );
  const effectiveCurrentProjectId = useMemo(
    () => String((task?.projectId ?? currentProjectId ?? "") || "").trim() || null,
    [currentProjectId, task?.projectId],
  );
  const effectiveCurrentProject = useMemo(
    () => availableProjects.find((project) => project.projectId === effectiveCurrentProjectId) ?? null,
    [availableProjects, effectiveCurrentProjectId],
  );
  const hasEffectiveProjectScope = Boolean(effectiveCurrentProjectId && effectiveCurrentProject);
  const currentTaskWorkflow = useMemo(() => getTaskWorkflowConfig(currentTaskWorkflowId), [currentTaskWorkflowId]);
  const updateTaskProjectMutation = useMutation({
    mutationFn: async (projectId: string | null) => {
      if (!selectedTaskId) throw new Error("No task selected");
      return apiClient.setTaskProject(selectedTaskId, { projectId });
    },
    onSuccess: async () => {
      if (selectedTaskId) {
        await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      }
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks", "project"] });
    },
  });
  const isCurrentWorkflowImplemented = currentTaskWorkflow.implemented;
  const isSourceVideoWorkflow = isSourceVideoWorkflowId(currentTaskWorkflowId);
  const isCharacterAnimateWorkflow = isCharacterAnimateWorkflowId(currentTaskWorkflowId);
  const isPrevizWorkflow = isPrevizWorkflowId(currentTaskWorkflowId);
  const fixedGenerationInputMode = getFixedGenerationInputModeForWorkflow(currentTaskWorkflowId);
  const fixedCharacterAnimateMode = getFixedCharacterAnimateModeForWorkflow(currentTaskWorkflowId);
  const isGlobalUtilityTab = tab === "asset_library" || tab === "custom_qc" || tab === "api_logs" || tab === "admin";
  const isResolvingWorkflowShell = Boolean(
    selectedTaskId &&
      !resolvedTaskWorkflowId &&
      !isGlobalUtilityTab &&
      (taskQuery.isLoading || tasksQuery.isLoading),
  );
  const showPrevizSelectTab = isPrevizWorkflow && tab === "timeline";
  const showPrevizEditTab = isPrevizWorkflow && tab === "frames";
  const showPrevizGenerateTab = isPrevizWorkflow && (tab === "generate" || tab === "outputs");
  const showPrevizPostTab = isPrevizWorkflow && tab === "merge";
  const showSourceVideoSelectTab = isSourceVideoWorkflow && tab === "timeline";
  const showSourceVideoEditTab = isSourceVideoWorkflow && tab === "frames";
  const showSourceVideoRefineTab = isSourceVideoWorkflow && tab === "refine";
  const showSourceVideoGenerateTab = isSourceVideoWorkflow && (tab === "generate" || tab === "outputs");
  const showSourceVideoPostTab = isSourceVideoWorkflow && tab === "merge";
  const showCharacterSelectTab = isCharacterAnimateWorkflow && tab === "timeline";
  const showCharacterEditTab = isCharacterAnimateWorkflow && tab === "frames";
  const showCharacterRefineTab = isCharacterAnimateWorkflow && tab === "refine";
  const showCharacterGenerateTab = isCharacterAnimateWorkflow && (tab === "generate" || tab === "outputs");
  const showCharacterPostTab = isCharacterAnimateWorkflow && tab === "merge";
  const showWorkflowCurrentReferences = !isResolvingWorkflowShell && (
    ((isSourceVideoWorkflow || isCharacterAnimateWorkflow) &&
      isCurrentWorkflowImplemented &&
      (activeWorkflowSection === "create" || activeWorkflowSection === "outputs" || activeWorkflowSection === "post")) ||
    showPrevizEditTab ||
    showPrevizGenerateTab
  );
  const workflowContentTopGapClass =
    !isGlobalUtilityTab && !isResolvingWorkflowShell && !showWorkflowCurrentReferences ? "mt-4" : "";

  useEffect(() => {
    if (!fixedGenerationInputMode) return;
    if (generationInputMode === fixedGenerationInputMode) return;
    setGenerationInputMode(fixedGenerationInputMode);
  }, [fixedGenerationInputMode, generationInputMode, setGenerationInputMode]);

  useEffect(() => {
    if (!fixedCharacterAnimateMode) return;
    if (characterAnimateMode === fixedCharacterAnimateMode) return;
    setCharacterAnimateMode(fixedCharacterAnimateMode);
  }, [characterAnimateMode, fixedCharacterAnimateMode, setCharacterAnimateMode]);

  useEffect(() => {
    if (currentTaskWorkflowId !== "simple_generation_workflow") return;
    setPrevizGenerateModel("veo_3_1");
    setPrevizGenerateDurationSec(8);
    setPrevizGeneratePrompt(typeof task?.previz?.scenePrompt === "string" ? task.previz.scenePrompt : "");
  }, [currentTaskWorkflowId, selectedTaskId]);
  const latestTaskByWorkflow = useMemo(() => {
    const latest = new Map<TaskWorkflowId, { taskId: string; name: string; projectName: string | null; updatedAtMs: number }>();
    for (const taskItem of tasksQuery.data ?? []) {
      const workflowId = normalizeTaskWorkflowId(taskItem.workflowId);
      const updatedAtMs = new Date(taskItem.updatedAt).getTime();
      const existing = latest.get(workflowId);
      if (!existing || updatedAtMs > existing.updatedAtMs) {
        latest.set(workflowId, {
          taskId: taskItem.taskId,
          name: taskItem.name,
          projectName: taskItem.projectName ?? null,
          updatedAtMs,
        });
      }
    }
    return latest;
  }, [tasksQuery.data]);
  const workflowHomeCards = useMemo(
    () =>
      HOME_TASK_WORKFLOW_IDS.map((workflowId) => {
        const latestTask = latestTaskByWorkflow.get(workflowId) ?? null;
        return {
          workflowId,
          latestTaskId: latestTask?.taskId ?? null,
          latestTaskName: latestTask?.name ?? null,
          latestTaskProjectName: latestTask?.projectName ?? null,
          latestTaskThumbnailUrl: null,
        };
      }),
    [latestTaskByWorkflow],
  );
  const workflowLandingLatestTask = useMemo(
    () => latestTaskByWorkflow.get(currentTaskWorkflowId) ?? null,
    [currentTaskWorkflowId, latestTaskByWorkflow],
  );
  const workflowPreviewTaskIds = useMemo(
    () => workflowHomeCards.map((card) => card.latestTaskId).filter((taskId): taskId is string => Boolean(taskId)),
    [workflowHomeCards],
  );
  const workflowPreviewQueries = useQueries({
    queries: workflowPreviewTaskIds.map((taskId) => ({
      queryKey: ["workflow-preview-task", taskId],
      queryFn: () => apiClient.getTask(taskId),
      enabled: isAuthed && (isHomeRoute || isWorkflowLandingRoute),
      staleTime: 60_000,
      refetchOnWindowFocus: false as const,
      refetchOnReconnect: false as const,
    })),
  });
  const workflowPreviewTasksById = useMemo(() => {
    const result = new Map<string, TaskDetail>();
    for (const query of workflowPreviewQueries) {
      if (query.data?.taskId) result.set(query.data.taskId, query.data);
    }
    return result;
  }, [workflowPreviewQueries]);
  const workflowHomeCardsWithPreview = useMemo(
    () =>
      workflowHomeCards.map((card) => ({
        ...card,
        latestTaskThumbnailUrl: card.latestTaskId ? resolveLatestTaskThumbnailUrl(workflowPreviewTasksById.get(card.latestTaskId)) : null,
      })),
    [workflowHomeCards, workflowPreviewTasksById],
  );
  const workflowLandingLatestTaskThumbnailUrl = useMemo(
    () =>
      workflowLandingLatestTask?.taskId
        ? resolveLatestTaskThumbnailUrl(workflowPreviewTasksById.get(workflowLandingLatestTask.taskId))
        : null,
    [workflowLandingLatestTask, workflowPreviewTasksById],
  );
  const workflowTasksById = useMemo(() => {
    const groups = new Map<TaskWorkflowId, TaskSummary[]>();
    for (const taskItem of tasksQuery.data ?? []) {
      const workflowId = normalizeTaskWorkflowId(taskItem.workflowId);
      const existing = groups.get(workflowId) ?? [];
      existing.push(taskItem);
      groups.set(workflowId, existing);
    }
    for (const tasks of groups.values()) {
      tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return groups;
  }, [tasksQuery.data]);
  const taskPickerPreviewTaskIds = useMemo(
    () => (taskPickerWorkflowId ? (workflowTasksById.get(taskPickerWorkflowId) ?? []).map((taskItem) => taskItem.taskId) : []),
    [taskPickerWorkflowId, workflowTasksById],
  );
  const taskPickerPreviewQueries = useQueries({
    queries: taskPickerPreviewTaskIds.map((taskId) => ({
      queryKey: ["task-picker-preview", taskId],
      queryFn: () => apiClient.getTask(taskId),
      enabled: isAuthed && Boolean(taskPickerWorkflowId),
      staleTime: 60_000,
      refetchOnWindowFocus: false as const,
      refetchOnReconnect: false as const,
    })),
  });
  const taskPickerPreviewUrlsById = useMemo(() => {
    const result = new Map<string, string | null>();
    for (const query of taskPickerPreviewQueries) {
      if (!query.data?.taskId) continue;
      result.set(query.data.taskId, resolveLatestTaskThumbnailUrl(query.data));
    }
    return result;
  }, [taskPickerPreviewQueries]);
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
    workflowId: currentTaskWorkflowId,
    activeInputMode: generationInputMode,
    activeCharacterMode: characterAnimateMode,
  });
  const characterAnimateVisibleGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {})
        .filter((generation) => {
          return matchesGenerateStepGrid(generation, {
            task,
            workflowId: "character_animate_workflow",
            activeInputMode: generationInputMode,
            activeCharacterMode: characterAnimateMode,
            selectedSegmentId,
            filterBySelectedSegment: true,
          });
        })
        .sort(
          (a, b) =>
            new Date(b.finishedAt ?? b.updatedAt ?? b.createdAt).getTime() -
            new Date(a.finishedAt ?? a.updatedAt ?? a.createdAt).getTime(),
        ),
    [characterAnimateMode, generationInputMode, selectedSegmentId, task],
  );
  const characterAnimatePostProcessGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {})
        .filter((generation) => {
          if (generation.isChunkInternal) return false;
          const origin = getGenerationOrigin(generation, task);
          if (origin?.workflowId !== "character_animate_workflow") return false;
          const isLengthenDerived = isPostProcessDerivedGeneration(generation, task);
          if (isLengthenDerived) return true;
          return generation.status === "complete" && Boolean(generation.downloadUrl);
        })
        .sort(
          (a, b) =>
            new Date(b.finishedAt ?? b.updatedAt ?? b.createdAt).getTime() -
            new Date(a.finishedAt ?? a.updatedAt ?? a.createdAt).getTime(),
        ),
    [task],
  );
  const characterTopazStateByGenerationId = useMemo(() => {
    const mapping: Record<string, ExportRecord["topazUpscale"] | undefined> = {};
    for (const exportItem of task?.exports ?? []) {
      if (!exportItem.internalOnlySource || !exportItem.sourceGenerationId) continue;
      mapping[exportItem.sourceGenerationId] = exportItem.topazUpscale;
    }
    return mapping;
  }, [task?.exports]);
  const characterAnimatePostProcessTopazItems = useMemo(
    () =>
      (task?.exports ?? [])
        .flatMap((exportItem) => {
          if (!exportItem.internalOnlySource || !exportItem.sourceGenerationId) return [];
          const sourceGeneration = task?.segmentGenerations?.[exportItem.sourceGenerationId];
          if (!sourceGeneration || sourceGeneration.isChunkInternal) return [];
          const origin = getGenerationOrigin(sourceGeneration, task);
          if (origin?.workflowId !== "character_animate_workflow") return [];
          const topazState = exportItem.topazUpscale;
          if (!topazState?.status) return [];
          const resultExport =
            topazState.resultExportId != null
              ? (task?.exports ?? []).find(
                  (candidate) => !candidate.internalOnlySource && candidate.exportId === topazState.resultExportId,
                ) ?? null
              : null;
          if (topazState.status === "complete" && !resultExport) return [];
          return [
            {
              sourceGeneration,
              sourceExport: exportItem,
              topazState,
              resultExport,
            },
          ];
        })
        .sort(
          (left, right) =>
            new Date(
              right.resultExport?.createdAt ??
                right.topazState.updatedAt ??
                right.sourceGeneration.finishedAt ??
                right.sourceGeneration.updatedAt ??
                right.sourceGeneration.createdAt,
            ).getTime() -
            new Date(
              left.resultExport?.createdAt ??
                left.topazState.updatedAt ??
                left.sourceGeneration.finishedAt ??
                left.sourceGeneration.updatedAt ??
                left.sourceGeneration.createdAt,
            ).getTime(),
        ),
    [task],
  );
  const previzPostProcessGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {})
        .filter((generation) => {
          if (generation.isChunkInternal) return false;
          const origin = getGenerationOrigin(generation, task);
          if (origin?.workflowId !== "simple_generation_workflow") return false;
          const isLengthenDerived = isPostProcessDerivedGeneration(generation, task);
          if (isLengthenDerived) return true;
          return generation.status === "complete" && Boolean(generation.downloadUrl);
        })
        .sort(
          (a, b) =>
            new Date(b.finishedAt ?? b.updatedAt ?? b.createdAt).getTime() -
            new Date(a.finishedAt ?? a.updatedAt ?? a.createdAt).getTime(),
        ),
    [task],
  );
  const previzPostProcessTopazItems = useMemo(
    () =>
      (task?.exports ?? [])
        .flatMap((exportItem) => {
          if (!exportItem.internalOnlySource || !exportItem.sourceGenerationId) return [];
          const sourceGeneration = task?.segmentGenerations?.[exportItem.sourceGenerationId];
          if (!sourceGeneration || sourceGeneration.isChunkInternal) return [];
          const origin = getGenerationOrigin(sourceGeneration, task);
          if (origin?.workflowId !== "simple_generation_workflow") return [];
          const topazState = exportItem.topazUpscale;
          if (!topazState?.status) return [];
          const resultExport =
            topazState.resultExportId != null
              ? (task?.exports ?? []).find(
                  (candidate) => !candidate.internalOnlySource && candidate.exportId === topazState.resultExportId,
                ) ?? null
              : null;
          if (topazState.status === "complete" && !resultExport) return [];
          return [
            {
              sourceGeneration,
              sourceExport: exportItem,
              topazState,
              resultExport,
            },
          ];
        })
        .sort(
          (left, right) =>
            new Date(
              right.resultExport?.createdAt ??
                right.topazState.updatedAt ??
                right.sourceGeneration.finishedAt ??
                right.sourceGeneration.updatedAt ??
                right.sourceGeneration.createdAt,
            ).getTime() -
            new Date(
              left.resultExport?.createdAt ??
                left.topazState.updatedAt ??
                left.sourceGeneration.finishedAt ??
                left.sourceGeneration.updatedAt ??
                left.sourceGeneration.createdAt,
            ).getTime(),
        ),
    [task],
  );

  const assetsTabLoading = tab === "assets" && assetsLoading;
  const assetLibraryTabLoading = tab === "asset_library" && assetLibraryLoading;
  const sourceMediaKind = (task?.sourceMedia?.kind ?? task?.video?.editSource?.mediaType ?? "video") as "video" | "audio";
  const isCharacterAudioSource = isCharacterAnimateWorkflow && sourceMediaKind === "audio";
  const sourceWaveformUrl = task?.sourceMedia?.waveform?.downloadUrl ?? task?.video?.editSource?.waveformUrl ?? null;
  const generationAudioReference = task?.generationAudioReference ?? null;
  const selectedSegment = task?.segments.find((s) => s.segmentId === selectedSegmentId) ?? null;
  const editVideoReferences = useMemo(() => task?.editVideoReferences ?? [], [task?.editVideoReferences]);
  const sortedEditVideoReferences = useMemo(
    () =>
      [...editVideoReferences].sort(
        (left, right) => new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime(),
      ),
    [editVideoReferences],
  );
  const editVideoReferenceLimitByModel = useMemo(() => editVideoReferenceLimitForModel(lumaModel), [lumaModel]);
  const editVideoReferenceWarning = useMemo(() => {
    if (isCharacterAnimateWorkflow) return null;
    if (generationInputMode !== "edit_video") return null;
    if (!editVideoReferenceLimitByModel) return null;
    if (editVideoSelectedReferenceIds.length > editVideoReferenceLimitByModel) {
      return `This model will use only the first ${editVideoReferenceLimitByModel} selected reference image${editVideoReferenceLimitByModel > 1 ? "s" : ""}.`;
    }
    return null;
  }, [editVideoReferenceLimitByModel, editVideoSelectedReferenceIds.length, generationInputMode, isCharacterAnimateWorkflow]);
  const generationModelOptionsForInput = useMemo(() => generationModelOptions, [generationModelOptions]);
  const editVideoReferencePreview = useMemo<WorkingReferencePreviewItem[]>(() => {
    const useReferencePreview =
      generationInputMode === "edit_video" || isCharacterAnimateWorkflow;
    if (!useReferencePreview) return [];
    const output: WorkingReferencePreviewItem[] = [];
    for (let index = 0; index < editVideoSelectedReferenceIds.length; index += 1) {
      const id = editVideoSelectedReferenceIds[index];
      const reference = editVideoReferences.find((item) => item.referenceId === id);
      if (!reference) continue;
      const title = humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId));
      output.push({
        referenceId: id,
        imageUrl: reference.imageUrl,
        token: isCharacterAnimateWorkflow ? `Character ${index + 1}` : `Ref Img ${index + 1}`,
        title,
        subtitle: reference.type === "generated" ? "generated reference" : "uploaded reference",
      });
    }
    return output;
  }, [editVideoReferences, editVideoSelectedReferenceIds, generationInputMode, isCharacterAnimateWorkflow]);
  const editVideoToolReferencePreview = useMemo<WorkingReferencePreviewItem[]>(
    () =>
      editVideoToolSelectedReferenceIds.flatMap((id, index) => {
        const reference = editVideoReferences.find((item) => item.referenceId === id);
        if (!reference) return [];
        const title = humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId));
        return [
          {
            referenceId: id,
            imageUrl: reference.imageUrl,
            token: `Reference ${index + 1}`,
            title,
            subtitle: reference.type === "generated" ? "generated reference" : "uploaded reference",
          },
        ];
      }),
    [editVideoReferences, editVideoToolSelectedReferenceIds],
  );
  const selectedCharacterReferenceId = editVideoSelectedReferenceIds[0] ?? null;
  const [characterReferenceDimensionsById, setCharacterReferenceDimensionsById] = useState<Record<string, { width: number; height: number }>>({});
  const selectedCharacterReference = useMemo(
    () => editVideoReferences.find((reference) => reference.referenceId === selectedCharacterReferenceId) ?? null,
    [editVideoReferences, selectedCharacterReferenceId],
  );
  useEffect(() => {
    if (!selectedCharacterReferenceId || !selectedCharacterReference?.imageUrl) return;
    if (characterReferenceDimensionsById[selectedCharacterReferenceId]) return;
    if (
      typeof selectedCharacterReference.width === "number" &&
      selectedCharacterReference.width > 0 &&
      typeof selectedCharacterReference.height === "number" &&
      selectedCharacterReference.height > 0
    ) {
      const width = selectedCharacterReference.width;
      const height = selectedCharacterReference.height;
      setCharacterReferenceDimensionsById((previous) => ({
        ...previous,
        [selectedCharacterReferenceId]: {
          width,
          height,
        },
      }));
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) return;
      setCharacterReferenceDimensionsById((previous) => ({
        ...previous,
        [selectedCharacterReferenceId]: { width, height },
      }));
    };
    image.src = selectedCharacterReference.imageUrl;
    return () => {
      cancelled = true;
    };
  }, [characterReferenceDimensionsById, selectedCharacterReference, selectedCharacterReferenceId]);
  const selectedCharacterReferenceDimensions = selectedCharacterReferenceId
    ? characterReferenceDimensionsById[selectedCharacterReferenceId] ?? null
    : null;
  const runwayCharacterImageValidationError = useMemo(() => {
    if (!isCharacterAnimateWorkflow || selectedCharacterAnimateModel !== "runway_act_two") return null;
    if (!selectedCharacterReferenceDimensions?.width || !selectedCharacterReferenceDimensions?.height) return null;
    const ratio = selectedCharacterReferenceDimensions.width / selectedCharacterReferenceDimensions.height;
    if (ratio >= 0.5) return null;
    return `Runway Act-Two does not support this character image shape. The selected image is ${selectedCharacterReferenceDimensions.width}×${selectedCharacterReferenceDimensions.height} (${ratio.toFixed(3)} width/height), but Runway requires at least 0.5. Choose a wider character image.`;
  }, [isCharacterAnimateWorkflow, selectedCharacterAnimateModel, selectedCharacterReferenceDimensions]);
  const characterImagePreferredAspectRatio = useMemo(
    () => aspectRatioHintFromDimensions(task?.video?.editSource?.width, task?.video?.editSource?.height),
    [task?.video?.editSource?.height, task?.video?.editSource?.width],
  );
  const editVideoReferenceLibraryItems = useMemo(
    () =>
      sortedEditVideoReferences.map((reference) => ({
        referenceId: reference.referenceId,
        imageUrl: reference.imageUrl,
        title: humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId)),
        subtitle:
          reference.type === "generated"
            ? `${reference.model ?? "generated"}${reference.status && reference.status !== "complete" ? ` • ${reference.status}` : ""}`
            : "uploaded",
        selectedForVideo: editVideoSelectedReferenceIds.includes(reference.referenceId),
        status: reference.status,
        error: reference.error ?? null,
        prompt: reference.prompt ?? null,
      })),
    [editVideoSelectedReferenceIds, sortedEditVideoReferences],
  );
  const previzState = task?.previz;
  const previzSceneAspectRatio = typeof previzState?.sceneAspectRatio === "string" && previzState.sceneAspectRatio.trim()
    ? previzState.sceneAspectRatio
    : null;
  const previzSyntheticSegmentId =
    typeof previzState?.syntheticSegmentId === "string" && previzState.syntheticSegmentId.trim()
      ? previzState.syntheticSegmentId
      : task?.segments?.find((segment) => segment.kind === "scene")?.segmentId ?? null;
  const previzSelectedReferenceIds = useMemo(
    () =>
      Array.isArray(previzState?.selectedReferenceIds)
        ? previzState.selectedReferenceIds
            .map((value) => String(value || "").trim())
            .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index)
        : [],
    [previzState?.selectedReferenceIds],
  );
  const previzFrameReferenceIds = useMemo(
    () =>
      Array.isArray(previzState?.frameReferenceIds)
        ? previzState.frameReferenceIds
            .map((value) => String(value || "").trim())
            .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index)
        : [],
    [previzState?.frameReferenceIds],
  );
  const previzSelectedFrameIds = useMemo(
    () =>
      Array.isArray(previzState?.selectedFrameIds)
        ? previzState.selectedFrameIds
            .map((value) => String(value || "").trim())
            .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index)
        : [],
    [previzState?.selectedFrameIds],
  );
  const previzToolReferencePreview = useMemo<WorkingReferencePreviewItem[]>(
    () =>
      previzSelectedReferenceIds.flatMap((id, index) => {
        const reference = editVideoReferences.find((item) => item.referenceId === id);
        if (!reference) return [];
        const title = humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId));
        return [
          {
            referenceId: id,
            imageUrl: reference.imageUrl,
            token: `@Image${index + 1}`,
            title,
            subtitle: reference.type === "generated" ? "generated reference" : "uploaded reference",
          },
        ];
      }),
    [editVideoReferences, previzSelectedReferenceIds],
  );
  const previzReferencePreview = useMemo<WorkingReferencePreviewItem[]>(
    () =>
      previzSelectedReferenceIds.flatMap((id, index) => {
        const reference = editVideoReferences.find((item) => item.referenceId === id);
        if (!reference) return [];
        const title = humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId));
        return [
          {
            referenceId: id,
            imageUrl: reference.imageUrl,
            token: `Image ${index + 1}`,
            title,
            subtitle: reference.type === "generated" ? "generated reference" : "uploaded reference",
          },
        ];
      }),
    [editVideoReferences, previzSelectedReferenceIds],
  );
  const previzSelectedFramePreview = useMemo<WorkingReferencePreviewItem[]>(
    () =>
      previzSelectedFrameIds.flatMap((id, index) => {
        const reference = editVideoReferences.find((item) => item.referenceId === id);
        if (!reference) return [];
        const title = humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId));
        return [
          {
            referenceId: id,
            imageUrl: reference.imageUrl,
            token: `Image ${index + 1}`,
            title,
            subtitle: reference.type === "generated" ? "generated frame" : "selected frame",
          },
        ];
      }),
    [editVideoReferences, previzSelectedFrameIds],
  );
  const previzSceneReferenceLibraryItems = useMemo(
    () =>
      sortedEditVideoReferences
        .filter((reference) => !previzFrameReferenceIds.includes(reference.referenceId))
        .map((reference) => {
          const isCreatedReference = Boolean((reference.model && String(reference.model).trim()) || (reference.prompt && String(reference.prompt).trim()));
          return {
            referenceId: reference.referenceId,
            imageUrl: reference.imageUrl,
            title: humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId)),
            subtitle:
              reference.type === "generated"
                ? `${reference.model ?? "generated"}${reference.status && reference.status !== "complete" ? ` • ${reference.status}` : ""}`
                : "uploaded",
            selected: previzSelectedReferenceIds.includes(reference.referenceId),
            status: reference.status,
            error: reference.error ?? null,
            prompt: reference.prompt ?? null,
            isCreatedReference,
          };
        }),
    [previzFrameReferenceIds, previzSelectedReferenceIds, sortedEditVideoReferences],
  );
  const previzUploadReferenceLibraryItems = useMemo(
    () => previzSceneReferenceLibraryItems.filter((reference) => !reference.isCreatedReference),
    [previzSceneReferenceLibraryItems],
  );
  const previzCreatedReferenceLibraryItems = useMemo(
    () => previzSceneReferenceLibraryItems.filter((reference) => reference.isCreatedReference),
    [previzSceneReferenceLibraryItems],
  );
  const previzFrameLibraryItems = useMemo(
    () =>
      previzFrameReferenceIds.flatMap((referenceId) => {
        const reference = sortedEditVideoReferences.find((item) => item.referenceId === referenceId);
        if (!reference) return [];
        return [
          {
            referenceId: reference.referenceId,
            imageUrl: reference.imageUrl,
            title: humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId)),
            subtitle:
              reference.type === "generated"
                ? `${reference.model ?? "generated"}${reference.status && reference.status !== "complete" ? ` • ${reference.status}` : ""}`
                : "uploaded",
            selected: previzSelectedFrameIds.includes(reference.referenceId),
            status: reference.status,
            prompt: reference.prompt ?? null,
          },
        ];
      }),
    [previzFrameReferenceIds, previzSelectedFrameIds, sortedEditVideoReferences],
  );
  const previzVisibleGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {})
        .filter((generation) => {
          return matchesGenerateStepGrid(generation, {
            task,
            workflowId: "simple_generation_workflow",
            activeInputMode: generationInputMode,
            selectedSegmentId: previzSyntheticSegmentId,
            filterBySelectedSegment: Boolean(previzSyntheticSegmentId),
          });
        })
        .sort(
          (a, b) =>
            new Date(b.finishedAt ?? b.updatedAt ?? b.createdAt).getTime() -
            new Date(a.finishedAt ?? a.updatedAt ?? a.createdAt).getTime(),
        ),
    [generationInputMode, previzSyntheticSegmentId, task],
  );
  const referencePickerItems = useMemo<ReferencePickerItem[]>(() => {
    if (!selectedTaskId) return [];
    const output: ReferencePickerItem[] = [];
    const seenSourceKeys = new Set<string>();
    const currentTaskId = task?.taskId ?? selectedTaskId;
    const addItem = (item: ReferencePickerItem) => {
      if (!item.imageUrl || seenSourceKeys.has(item.sourceKey)) return;
      seenSourceKeys.add(item.sourceKey);
      output.push(item);
    };

    for (const reference of editVideoReferences) {
      if (!reference.imageUrl) continue;
      addItem({
        id: `reference:${reference.referenceId}`,
        taskId: currentTaskId,
        imageUrl: reference.imageUrl,
        createdAt: reference.createdAt,
        title: humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId)),
        subtitle: reference.type === "generated" ? "Current task generated reference" : "Current task upload",
        sourceGroup: reference.type === "generated" ? "generated" : "upload",
        sourceType: "task_reference",
        sourceKey: reference.key,
        referenceId: reference.referenceId,
        referenceType: reference.type,
        isCurrentTaskAsset: true,
        isProjectAsset: Boolean(effectiveCurrentProjectId),
        matchesCurrentContext: true,
        assetKind: reference.type === "generated" ? "generated_image" : "uploaded",
      });
      if (reference.originSourceKey) {
        seenSourceKeys.add(reference.originSourceKey);
      }
    }

    for (const assetTask of assetTasks) {
      const isCurrentTask = assetTask.taskId === currentTaskId;
      const isProjectAsset = Boolean(effectiveCurrentProjectId) && assetTask.projectId === effectiveCurrentProjectId;
      for (const reference of assetTask.editVideoReferences ?? []) {
        if (!reference.imageUrl) continue;
        if (isCurrentTask) continue;
        addItem({
          id: `library-reference:${assetTask.taskId}:${reference.referenceId}`,
          taskId: assetTask.taskId,
          imageUrl: reference.imageUrl,
          createdAt: reference.createdAt,
          title: humanizeFilename(reference.filename || keyBasenameFromS3Key(reference.key || reference.referenceId)),
          subtitle: `${assetTask.name} · ${reference.type === "generated" ? "generated reference" : "uploaded reference"}`,
          sourceGroup: reference.type === "generated" ? "generated" : "upload",
          sourceType: "task_reference",
          sourceKey: reference.key,
          referenceId: reference.referenceId,
          referenceType: reference.type,
          isCurrentTaskAsset: false,
          isProjectAsset,
          matchesCurrentContext: false,
          assetKind: reference.type === "generated" ? "generated_image" : "uploaded",
        });
      }
      for (const frame of Object.values(assetTask.frames ?? {})) {
        for (const variant of frame.variants ?? []) {
          if (!variant.imageUrl) continue;
          addItem({
            id: `frame-variant:${assetTask.taskId}:${frame.frameId}:${variant.variantId}`,
            taskId: assetTask.taskId,
            imageUrl: variant.imageUrl,
            createdAt: variant.createdAt,
            title: humanizeFilename(keyBasenameFromS3Key(variant.outputKey)),
            subtitle: `${assetTask.name} · frame ${frame.frameIndex} · ${variant.model}`,
            sourceGroup: "generated",
            sourceType: "frame_variant",
            sourceKey: variant.outputKey,
            isCurrentTaskAsset: isCurrentTask,
            isProjectAsset,
            matchesCurrentContext: isCurrentTask,
            assetKind: "generated_image",
          });
        }
      }
    }

    for (const frame of Object.values(task?.frames ?? {})) {
      if (!frame.imageUrl) continue;
      addItem({
        id: `frame-capture:${currentTaskId}:${frame.frameId}`,
        taskId: currentTaskId,
        imageUrl: frame.imageUrl,
        createdAt: task?.updatedAt ?? new Date(0).toISOString(),
        title: `Frame ${frame.frameIndex}`,
        subtitle: `${task?.name ?? "Current task"} · captured frame`,
        sourceGroup: "generated",
        sourceType: "frame_capture",
        sourceKey: frame.captureKey,
        isCurrentTaskAsset: true,
        isProjectAsset: Boolean(effectiveCurrentProjectId),
        matchesCurrentContext: true,
        assetKind: "captured_frame",
      });
    }

    return output.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks, editVideoReferences, effectiveCurrentProjectId, selectedTaskId, task]);
  const referencePickerVideoItems = useMemo<ReferencePickerVideoItem[]>(() => {
    if (!selectedTaskId) return [];
    const output: ReferencePickerVideoItem[] = [];
    const seenIds = new Set<string>();
    const currentTaskId = task?.taskId ?? selectedTaskId;

    const matchesCurrentVideoContext = (assetTask: TaskDetail, generation?: SegmentGeneration | null): boolean => {
      if (assetTask.taskId !== currentTaskId) return false;
      if (!generation) return true;
      const origin = getGenerationOrigin(generation, assetTask);
      if (!origin || origin.workflowId !== currentTaskWorkflowId) return false;
      if (isCharacterAnimateWorkflow) {
        return origin.creationMode === characterAnimateMode;
      }
      if (isPrevizWorkflow) {
        return true;
      }
      return origin.creationMode === generationInputMode;
    };

    const firstFrameThumbnailUrl = (assetTask: TaskDetail): string | undefined => {
      const firstFrame = Object.values(assetTask.frames ?? {})
        .sort((left, right) => left.frameIndex - right.frameIndex)[0];
      return firstFrame?.imageUrl ?? undefined;
    };

    const addVideoItem = (item: ReferencePickerVideoItem) => {
      if (!item.previewUrl || seenIds.has(item.id)) return;
      seenIds.add(item.id);
      output.push(item);
    };

    const addTaskSourceVideo = (assetTask: TaskDetail) => {
      const isProjectAsset = Boolean(effectiveCurrentProjectId) && assetTask.projectId === effectiveCurrentProjectId;
      const sourceKind = assetTask.sourceMedia?.kind ?? assetTask.video?.editSource?.mediaType ?? "video";
      if (sourceKind !== "video") return;
      const previewUrl =
        assetTask.sourceMedia?.previewSource?.downloadUrl ??
        assetTask.sourceMedia?.editSource?.downloadUrl ??
        assetTask.video?.previewSource?.downloadUrl ??
        assetTask.video?.editSource?.downloadUrl ??
        null;
      if (!previewUrl) return;
      const sourceKey =
        assetTask.sourceMedia?.previewSource?.s3Key ??
        assetTask.sourceMedia?.editSource?.s3Key ??
        assetTask.video?.previewSource?.s3Key ??
        assetTask.video?.editSource?.s3Key ??
        assetTask.sourceMedia?.original?.s3Key ??
        assetTask.video?.original?.s3Key ??
        `${assetTask.taskId}:source-video`;
      const filename =
        assetTask.sourceMedia?.original?.filename ??
        assetTask.video?.original?.filename ??
        keyBasenameFromS3Key(sourceKey);
      addVideoItem({
        id: `source-video:${assetTask.taskId}:${sourceKey}`,
        taskId: assetTask.taskId,
        title: humanizeFilename(filename),
        subtitle: `${assetTask.name} · uploaded source video`,
        previewUrl,
        thumbnailUrl: firstFrameThumbnailUrl(assetTask),
        createdAt: assetTask.updatedAt,
        sourceKind: "uploaded",
        isCurrentTaskAsset: assetTask.taskId === currentTaskId,
        isProjectAsset,
        matchesCurrentContext: assetTask.taskId === currentTaskId,
        canCaptureFrame: true,
        frameCount: assetTask.sourceMedia?.editSource?.frameCount ?? assetTask.video?.editSource?.frameCount ?? null,
        durationSec: assetTask.sourceMedia?.editSource?.durationSec ?? assetTask.video?.editSource?.durationSec ?? null,
        width: assetTask.sourceMedia?.editSource?.width ?? assetTask.video?.editSource?.width ?? null,
        height: assetTask.sourceMedia?.editSource?.height ?? assetTask.video?.editSource?.height ?? null,
      });
    };

    const addGeneratedVideos = (assetTask: TaskDetail) => {
      const isProjectAsset = Boolean(effectiveCurrentProjectId) && assetTask.projectId === effectiveCurrentProjectId;
      for (const generation of Object.values(assetTask.segmentGenerations ?? {})) {
        if (generation.isChunkInternal || generation.status !== "complete" || !generation.downloadUrl) continue;
        const origin = getGenerationOrigin(generation, assetTask);
        const toolLabel =
          origin?.stepOrigin === "post_process"
            ? origin?.toolOrigin === "clip_lengthen"
              ? "extended video"
              : "post-process video"
            : "generated video";
        addVideoItem({
          id: `generation-video:${assetTask.taskId}:${generation.genId}`,
          taskId: assetTask.taskId,
          title: describeGeneration(generation),
          subtitle: `${assetTask.name} · ${toolLabel} · ${generation.luma.model}`,
          previewUrl: generation.downloadUrl,
          thumbnailUrl: generationThumbnailUrl(generation) ?? undefined,
          createdAt: generation.createdAt,
          sourceKind: "generated",
          isCurrentTaskAsset: assetTask.taskId === currentTaskId,
          isProjectAsset,
          matchesCurrentContext: matchesCurrentVideoContext(assetTask, generation),
          canCaptureFrame: false,
          durationSec: generation.providerDurationSec ?? generation.requestedDurationSec ?? null,
        });
      }
      for (const exportItem of assetTask.exports ?? []) {
        if (exportItem.internalOnlySource || !exportItem.downloadUrl) continue;
        addVideoItem({
          id: `export-video:${assetTask.taskId}:${exportItem.exportId}`,
          taskId: assetTask.taskId,
          title: humanizeFilename(keyBasenameFromS3Key(exportItem.outputKey || `${exportItem.exportId}.mp4`)),
          subtitle: `${assetTask.name} · merged export`,
          previewUrl: exportItem.downloadUrl,
          createdAt: exportItem.createdAt,
          sourceKind: "generated",
          isCurrentTaskAsset: assetTask.taskId === currentTaskId,
          isProjectAsset,
          matchesCurrentContext: assetTask.taskId === currentTaskId,
          canCaptureFrame: false,
        });
      }
    };

    if (task) {
      addTaskSourceVideo(task);
      addGeneratedVideos(task);
    }
    for (const assetTask of assetTasks) {
      if (assetTask.taskId === currentTaskId) continue;
      addTaskSourceVideo(assetTask);
      addGeneratedVideos(assetTask);
    }

    return output.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [
    assetTasks,
    characterAnimateMode,
    effectiveCurrentProjectId,
    currentTaskWorkflowId,
    describeGeneration,
    generationInputMode,
    selectedTaskId,
    task,
  ]);
  const referencePickerItemById = useMemo(() => new Map(referencePickerItems.map((item) => [item.id, item])), [referencePickerItems]);
  const selectedReferencePickerItemIds = useMemo(
    () =>
      editVideoSelectedReferenceIds
        .map((referenceId) => `reference:${referenceId}`)
        .filter((itemId) => referencePickerItemById.has(itemId)),
    [editVideoSelectedReferenceIds, referencePickerItemById],
  );
  const selectedToolReferencePickerItemIds = useMemo(
    () =>
      editVideoToolSelectedReferenceIds
        .map((referenceId) => `reference:${referenceId}`)
        .filter((itemId) => referencePickerItemById.has(itemId)),
    [editVideoToolSelectedReferenceIds, referencePickerItemById],
  );
  const selectedPrevizReferencePickerItemIds = useMemo(
    () =>
      previzSelectedReferenceIds
        .map((referenceId) => `reference:${referenceId}`)
        .filter((itemId) => referencePickerItemById.has(itemId)),
    [previzSelectedReferenceIds, referencePickerItemById],
  );
  const selectedPrevizToolReferencePickerItemIds = selectedPrevizReferencePickerItemIds;
  const selectedPrevizFramePickerItemIds = useMemo(
    () =>
      previzSelectedFrameIds
        .map((referenceId) => `reference:${referenceId}`)
        .filter((itemId) => referencePickerItemById.has(itemId)),
    [previzSelectedFrameIds, referencePickerItemById],
  );
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
    setEditVideoToolSelectedReferenceIds((previous) => previous.filter((id) => availableIds.has(id)));
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
      setReferenceImageAssetsVisible(6);
      setGeneratedAssetsVisible(6);
    }
    if (tab === "asset_library") {
      setLibraryMergedAssetsVisible(6);
      setLibraryEditedFrameAssetsVisible(6);
      setLibraryReferenceImageAssetsVisible(6);
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
      payload: LibraryAssetDeletePayload;
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
      const firstFrameVariantId =
        generationInputMode === "edit_video" ? null : refineSourceVariantIds.first || compareVariantIds.first || null;
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
        luma_mode: lumaModel === "ray-3.2-720p" || lumaModel === "ray-3.2-1080p" ? lumaModeBucket(advancedMode) : null,
        user_visible_model_name: config.dropdownName,
        first_frame_variant_id: firstFrameVariantId,
        selected_reference_ids:
          generationInputMode === "edit_video" ? editVideoSelectedReferenceIds.slice(0, editVideoReferenceLimitByModel || 3) : [],
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
        inputMode: generationInputMode,
        prompt: lumaModel === "wan2.2-animate" ? undefined : trimmedPrompt || undefined,
        negativePrompt: lumaModel === "wan2.7-i2v" ? wan27NegativePrompt.trim() || undefined : undefined,
        firstFrameVariantId:
          generationInputMode === "edit_video" ? undefined : refineSourceVariantIds.first || compareVariantIds.first || undefined,
        lastFrameVariantId: generationInputMode === "start_end" ? refineSourceVariantIds.last || compareVariantIds.last || undefined : undefined,
        selectedReferenceIds:
          generationInputMode === "edit_video"
            ? editVideoSelectedReferenceIds.slice(0, editVideoReferenceLimitByModel || 3)
            : undefined,
        audioReferenceId:
          generationInputMode === "edit_video" && lumaModel === "seedance-2.0-reference-to-video" ? generationAudioReference?.referenceId ?? undefined : undefined,
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

  const generateCharacterAnimationMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !selectedSegmentId) throw new Error("Select a segment");
      if (!selectedCharacterReferenceId) throw new Error("Select a character image");
      if (runwayCharacterImageValidationError) throw new Error(runwayCharacterImageValidationError);
      const trimmedPrompt = characterAnimatePrompt.trim();
      return apiClient.generateCharacterAnimation(selectedTaskId, selectedSegmentId, {
        mode: characterAnimateMode,
        model: selectedCharacterAnimateModel as "runway_act_two" | "kling_v3_motion_control" | "seedance_2_0_reference_to_video" | "omnihuman_v1_5",
        characterReferenceId: selectedCharacterReferenceId,
        prompt: selectedCharacterAnimateModel !== "runway_act_two" ? trimmedPrompt || undefined : undefined,
        outputAspectRatio: characterAnimateMode === "pose_video" ? (characterAnimateOutputAspectRatio as "1280:720" | "720:1280" | "960:960" | "1104:832" | "832:1104" | "1584:672") : undefined,
        bodyControl: characterAnimateMode === "pose_video" ? characterAnimateBodyControl : undefined,
        expressionIntensity: characterAnimateMode === "pose_video" ? characterAnimateExpressionIntensity : undefined,
        omnihumanResolution: characterAnimateMode === "audio_driven" ? characterAnimateOmnihumanResolution : undefined,
        klingMode: selectedCharacterAnimateModel === "kling_v3_motion_control" ? characterAnimateKlingMode : undefined,
        klingCharacterOrientation:
          selectedCharacterAnimateModel === "kling_v3_motion_control" ? characterAnimateKlingCharacterOrientation : undefined,
        seedanceResolution:
          selectedCharacterAnimateModel === "seedance_2_0_reference_to_video" ? characterAnimateSeedanceResolution : undefined,
        seedanceAspectRatio:
          selectedCharacterAnimateModel === "seedance_2_0_reference_to_video" ? characterAnimateSeedanceAspectRatio : undefined,
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

  const generatePrevizVideoMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !previzSyntheticSegmentId) throw new Error("Previz scene container is not ready yet");
      const trimmedPrompt = previzGeneratePrompt.trim();
      if (!trimmedPrompt) throw new Error("Write a prompt before generating");
      if (!previzSelectedFrameIds.length) throw new Error("Select one or more frames in the Edit step");
      return apiClient.generatePrevizVideo(selectedTaskId, previzSyntheticSegmentId, {
        model: previzGenerateModel,
        prompt: trimmedPrompt,
        durationSec: previzGenerateDurationSec,
        sceneAspectRatio: previzSceneAspectRatio ?? "16:9",
        selectedFrameIds: previzSelectedFrameIds.slice(0, 9),
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
        firstFrameVariantId:
          generationInputMode === "edit_video" ? undefined : refineSourceVariantIds.first || compareVariantIds.first || undefined,
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

  const lengthenSegmentGenerationMutation = useMutation({
    mutationFn: async ({
      generationId,
      model,
      direction,
      durationSeconds,
      prompt,
      inputMode,
      selectedReferenceIds,
    }: {
      generationId: string;
      model: string;
      direction: "start" | "end";
      durationSeconds: number;
      prompt: string;
      inputMode: "start_end" | "edit_video";
      selectedReferenceIds?: string[];
    }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.lengthenSegmentGeneration(selectedTaskId, generationId, {
        model,
        direction,
        durationSeconds,
        prompt,
        inputMode,
        selectedReferenceIds: selectedReferenceIds ?? [],
      });
    },
    onSuccess: async (result) => {
      setJobIds((prev) => appendTrackedJobId(prev, result.jobId));
      setLengthenPendingGenId(result.genId);
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

  const runTopazUpscaleForGenerationMutation = useMutation({
    mutationFn: async ({
      generationId,
      payload,
    }: {
      generationId: string;
      payload: {
        preset: "balanced" | "recover_detail" | "fast_sharpen";
        model: string;
        upscaleFactor: number;
        h264Output: boolean;
        force?: boolean;
      };
    }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.runTopazUpscaleForGeneration(selectedTaskId, generationId, payload);
    },
    onMutate: async ({ generationId }) => {
      setTopazUpscalePendingGenerationId(generationId);
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
      setTopazUpscalePendingGenerationId(null);
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
      reportType: "qc_frame" | "qc_video" | "video_compare" | "previz_review";
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
    for (const reference of task?.editVideoReferences ?? []) {
      if (reference.jobId && isActiveStatus(reference.status)) ids.push(reference.jobId);
    }
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
  }, [task?.chunkedGenerationRuns, task?.customReports, task?.editVideoReferences, task?.exports, task?.segmentGenerations]);

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
    setEditVideoReferencePromptDraft("");
    setPrevizReferencePromptDraft("");
    setPrevizFramePromptDraft("");
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
    const showTaskWideEditVideoGenerations = isSourceVideoWorkflow && generationInputMode === "edit_video";
    if (!selectedSegmentId && !showTaskWideEditVideoGenerations) return [];
    const cards: PendingGenerationCard[] = [];
    for (const job of sortedJobs) {
      if (dismissedPendingGenerationJobIds[job.jobId]) continue;
      if (job.type !== "segment_generate") continue;
      if (job.status !== "queued" && job.status !== "running" && job.status !== "failed") continue;
      const segmentId = jobPayloadString(job, "segmentId");
      if (!segmentId) continue;
      if (!showTaskWideEditVideoGenerations && segmentId !== selectedSegmentId) continue;
      if (showTaskWideEditVideoGenerations) {
        const inputMode = jobPayloadString(job, "inputMode");
        if (inputMode !== "edit_video") continue;
      }
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
  }, [currentTaskWorkflowId, dismissedPendingGenerationJobIds, generationInputMode, selectedSegmentId, sortedJobs]);

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
    referenceImageAssets,
    generatedVideoAssets,
    postProcessVideoAssets,
    mergedVideoAssets,
    orphanedAssets,
    audioAssets,
    libraryEditedFrameAssets,
    libraryReferenceImageAssets,
    libraryGeneratedVideoAssets,
    libraryPostProcessVideoAssets,
    libraryMergedVideoAssets,
    libraryOrphanedAssets,
    libraryAudioAssets,
  } = useAssetLibraryState({
    selectedTaskId,
    selectedTask: task,
    assetTasks,
  });

  const { segmentWindow, originalPreviewIsSegmentClip, stableOriginalSegmentPreviewUrl, stableOriginalSegmentCompareUrl } = useSelectedSegmentPreview({
    selectedSegment,
    task,
  });
  const timelinePlaybackUrl =
    task?.sourceMedia?.previewSource?.downloadUrl ??
    task?.sourceMedia?.editSource?.downloadUrl ??
    task?.video?.previewSource?.downloadUrl ??
    task?.video?.editSource?.downloadUrl ??
    "";

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

  useEffect(() => {
    if (!lengthenPendingGenId) return;
    const pendingGeneration = task?.segmentGenerations?.[lengthenPendingGenId];
    if (!pendingGeneration) return;
    if (pendingGeneration.status === "complete" && pendingGeneration.outputKey) {
      selectSegmentGeneration(lengthenPendingGenId);
      setLengthenPendingGenId(null);
      return;
    }
    if (pendingGeneration.status === "failed") {
      setLengthenPendingGenId(null);
    }
  }, [lengthenPendingGenId, selectSegmentGeneration, task?.segmentGenerations]);

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
    if (segment.kind === "scene") {
      return segment.label?.trim() ? segment.label : "Scene";
    }
    const endFrameInclusive = Math.max(segment.endFrameExclusive - 1, segment.startFrame);
    if (isCharacterAudioSource) {
      return `${segment.startTimecode}→${segment.endTimecode} · ${segment.durationSec.toFixed(2)}s`;
    }
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
      if (!nearExpiry) return;
      const now = Date.now();
      const throttleKey = `${selectedTaskId}:${url}`;
      const previous = mediaErrorRefreshRef.current.get(throttleKey) ?? 0;
      if (now - previous < MEDIA_ERROR_FORCE_REFRESH_COOLDOWN_MS) {
        return;
      }
      mediaErrorRefreshRef.current.set(throttleKey, now);
      refreshSignedUrlsForTask(selectedTaskId, { force: true, includeReport: isReportTab });
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
      if (shouldRefreshOriginal && videoCompareModal.originalMediaType === "audio") {
        return task.sourceMedia?.previewSource?.downloadUrl ?? task.sourceMedia?.editSource?.downloadUrl ?? videoCompareModal.originalUrl;
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

  const openNewTaskWithAutomationDefaults = useCallback((workflowId: TaskWorkflowId = "source_video_flow") => {
    setAutomationEnabled(false);
    setAutomationStartPrompt("");
    setAutomationEndPrompt("");
    setAutomationVideoPrompt("");
    setAutomationSelectedVideoOptionIds(AUTOMATION_VIDEO_OPTIONS.map((option) => option.id));
    setAutomationUiError(null);
    if (workflowId !== "canvas_workflow") {
      goHome();
      setTaskPickerWorkflowId(null);
      openNewTaskModal(workflowId);
      return;
    }
    setTaskPickerWorkflowId(null);
    openWorkflowLanding(workflowId);
  }, [goHome, openNewTaskModal, openWorkflowLanding]);

  const openTaskPickerForWorkflow = useCallback((workflowId: TaskWorkflowId) => {
    setTaskPickerWorkflowId(workflowId);
  }, []);

  const openTaskFromPicker = useCallback(
    (taskId: string) => {
      setTaskPickerWorkflowId(null);
      setTab("timeline", taskId);
    },
    [setTab],
  );

  const openTaskAtSelectStep = useCallback(
    (taskId: string) => {
      setTaskPickerWorkflowId(null);
      setTab("timeline", taskId);
    },
    [setTab],
  );

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
      inputMode: generationInputMode,
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

  async function uploadGenerationAudioReference(file: File): Promise<void> {
    if (!selectedTaskId) throw new Error("No task selected");
    const init = await apiClient.initGenerationAudioReferenceUpload(selectedTaskId, {
      filename: file.name,
      contentType: file.type || "audio/mpeg",
      sizeBytes: file.size,
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
    await apiClient.completeGenerationAudioReferenceUpload(selectedTaskId, {
      referenceId: init.referenceId,
      uploadKey: init.key,
      filename: file.name,
    });
    await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "report", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
  }

  const appendEditVideoReferencesToTaskCache = useCallback((taskId: string, references: EditVideoReference[]): void => {
    queryClient.setQueryData<TaskDetail | undefined>(["task", taskId], (previous) =>
      previous ? { ...previous, editVideoReferences: mergeEditVideoReferences(previous.editVideoReferences, references) } : previous,
    );
    queryClient.setQueryData<TaskDetail | undefined>(["task", "assets", taskId], (previous) =>
      previous ? { ...previous, editVideoReferences: mergeEditVideoReferences(previous.editVideoReferences, references) } : previous,
    );
  }, [queryClient]);

  const setPrevizStateInTaskCache = useCallback((taskId: string, nextPreviz: NonNullable<TaskDetail["previz"]>): void => {
    queryClient.setQueryData<TaskDetail | undefined>(["task", taskId], (previous) =>
      previous ? { ...previous, previz: nextPreviz } : previous,
    );
    queryClient.setQueryData<TaskDetail | undefined>(["task", "assets", taskId], (previous) =>
      previous ? { ...previous, previz: nextPreviz } : previous,
    );
  }, [queryClient]);

  const updatePrevizTask = useCallback(
    async (patch: {
      scenePrompt?: string | null;
      sceneAspectRatio?: string | null;
      selectedReferenceIds?: string[];
      frameReferenceIds?: string[];
      selectedFrameIds?: string[];
    }): Promise<void> => {
      if (!selectedTaskId) throw new Error("No task selected");
      const previousPreviz: NonNullable<TaskDetail["previz"]> = {
        scenePrompt: previzState?.scenePrompt ?? "",
        sceneAspectRatio: previzState?.sceneAspectRatio ?? null,
        selectedReferenceIds: Array.isArray(previzState?.selectedReferenceIds) ? [...previzState.selectedReferenceIds] : [],
        frameReferenceIds: Array.isArray(previzState?.frameReferenceIds) ? [...previzState.frameReferenceIds] : [],
        selectedFrameIds: Array.isArray(previzState?.selectedFrameIds) ? [...previzState.selectedFrameIds] : [],
        syntheticSegmentId: previzState?.syntheticSegmentId ?? null,
      };
      const optimisticPreviz: NonNullable<TaskDetail["previz"]> = {
        ...previousPreviz,
        ...patch,
        selectedReferenceIds: patch.selectedReferenceIds ?? previousPreviz.selectedReferenceIds ?? [],
        frameReferenceIds: patch.frameReferenceIds ?? previousPreviz.frameReferenceIds ?? [],
        selectedFrameIds: patch.selectedFrameIds ?? previousPreviz.selectedFrameIds ?? [],
      };
      setPrevizStateInTaskCache(selectedTaskId, optimisticPreviz);
      try {
        const result = await apiClient.updatePrevizTask(selectedTaskId, patch);
        setPrevizStateInTaskCache(selectedTaskId, result.previz);
      } catch (error) {
        setPrevizStateInTaskCache(selectedTaskId, previousPreviz);
        throw error;
      }
    },
    [previzState, selectedTaskId, setPrevizStateInTaskCache],
  );

  const toggleSelectedEditVideoReferenceId = useCallback((referenceId: string): void => {
    setEditVideoSelectedReferenceIds((previous) => {
      if (isCharacterAnimateWorkflow) {
        return previous.includes(referenceId) ? [] : [referenceId];
      }
      if (previous.includes(referenceId)) {
        return previous.filter((id) => id !== referenceId);
      }
      if (!editVideoReferenceLimitByModel) {
        return [...previous, referenceId];
      }
      if (previous.length >= editVideoReferenceLimitByModel) {
        return [...previous.slice(1), referenceId];
      }
      return [...previous, referenceId];
    });
  }, [editVideoReferenceLimitByModel, isCharacterAnimateWorkflow]);

  const moveToolSelectedPrevizReference = useCallback((referenceId: string, direction: -1 | 1): void => {
    const index = previzSelectedReferenceIds.indexOf(referenceId);
    if (index < 0) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= previzSelectedReferenceIds.length) return;
    const updated = [...previzSelectedReferenceIds];
    const [moved] = updated.splice(index, 1);
    updated.splice(nextIndex, 0, moved);
    void updatePrevizTask({ selectedReferenceIds: updated });
  }, [previzSelectedReferenceIds, updatePrevizTask]);

  const removeToolSelectedPrevizReference = useCallback((referenceId: string): void => {
    void updatePrevizTask({
      selectedReferenceIds: previzSelectedReferenceIds.filter((id) => id !== referenceId),
    });
  }, [previzSelectedReferenceIds, updatePrevizTask]);

  const moveToolSelectedEditVideoReference = useCallback((referenceId: string, direction: -1 | 1): void => {
    setEditVideoToolSelectedReferenceIds((previous) => {
      const index = previous.indexOf(referenceId);
      if (index < 0) return previous;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= previous.length) return previous;
      const updated = [...previous];
      const [moved] = updated.splice(index, 1);
      updated.splice(nextIndex, 0, moved);
      return updated;
    });
  }, []);

  const removeToolSelectedEditVideoReference = useCallback((referenceId: string): void => {
    setEditVideoToolSelectedReferenceIds((previous) => previous.filter((id) => id !== referenceId));
  }, []);

  async function uploadEditVideoReferenceImages(files: File[]): Promise<string[]> {
    if (!selectedTaskId) throw new Error("No task selected");
    const uploadedReferences: EditVideoReference[] = [];
    for (const originalFile of files) {
      const preparedFile = await prepareReferenceImageUpload(originalFile);
      const init = await apiClient.initEditVideoReferenceUpload(selectedTaskId, {
        filename: preparedFile.name,
        contentType: preparedFile.type || "image/png",
      });
      const uploadResponse = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": preparedFile.type || "application/octet-stream",
        },
        body: preparedFile,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.status}`);
      }
      const completed = await apiClient.completeEditVideoReferenceUpload(selectedTaskId, {
        referenceId: init.referenceId,
        uploadKey: init.key,
        filename: preparedFile.name,
      });
      uploadedReferences.push(completed.reference);
    }
    appendEditVideoReferencesToTaskCache(selectedTaskId, uploadedReferences);
    await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    return uploadedReferences.map((reference) => `reference:${reference.referenceId}`);
  }

  const generateEditVideoReferenceImage = useCallback(
    async (payload: {
      model: "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro" | "luma_uni_1" | "luma_uni_1_max";
      prompt: string;
      aspectRatio?: string | null;
    }): Promise<void> => {
      if (!selectedTaskId) throw new Error("No task selected");
      const created = await apiClient.generateEditVideoReference(selectedTaskId, {
        ...payload,
        selectedReferenceIds: editVideoToolSelectedReferenceIds.slice(0, 9),
      });
      if (created.jobId) {
        setJobIds((previous) => (previous.includes(created.jobId as string) ? previous : [...previous, created.jobId as string]));
      }
      appendEditVideoReferencesToTaskCache(selectedTaskId, [created.reference]);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    },
    [appendEditVideoReferencesToTaskCache, editVideoToolSelectedReferenceIds, queryClient, selectedTaskId],
  );

  const generatePrevizReferenceImage = useCallback(
    async (payload: {
      model: "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro" | "luma_uni_1" | "luma_uni_1_max";
      prompt: string;
      aspectRatio?: string | null;
    }): Promise<void> => {
      if (!selectedTaskId) throw new Error("No task selected");
      const created = await apiClient.generateEditVideoReference(selectedTaskId, {
        ...payload,
        selectedReferenceIds: previzSelectedReferenceIds.slice(0, 9),
      });
      if (created.jobId) {
        setJobIds((previous) => (previous.includes(created.jobId as string) ? previous : [...previous, created.jobId as string]));
      }
      appendEditVideoReferencesToTaskCache(selectedTaskId, [created.reference]);
      const nextSelectedReferenceIds = previzSelectedReferenceIds.includes(created.reference.referenceId)
        ? previzSelectedReferenceIds
        : [...previzSelectedReferenceIds, created.reference.referenceId];
      await updatePrevizTask({
        selectedReferenceIds: nextSelectedReferenceIds,
      });
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    },
    [
      appendEditVideoReferencesToTaskCache,
      previzSelectedReferenceIds,
      queryClient,
      selectedTaskId,
      updatePrevizTask,
    ],
  );

  const generatePrevizFrameImage = useCallback(
    async (payload: {
      model: "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro" | "luma_uni_1" | "luma_uni_1_max";
      prompt: string;
      aspectRatio?: string | null;
    }): Promise<void> => {
      if (!selectedTaskId) throw new Error("No task selected");
      const created = await apiClient.generateEditVideoReference(selectedTaskId, {
        ...payload,
        selectedReferenceIds: previzSelectedReferenceIds.slice(0, 9),
      });
      if (created.jobId) {
        setJobIds((previous) => (previous.includes(created.jobId as string) ? previous : [...previous, created.jobId as string]));
      }
      appendEditVideoReferencesToTaskCache(selectedTaskId, [created.reference]);
      await updatePrevizTask({
        frameReferenceIds: [...previzFrameReferenceIds, created.reference.referenceId],
      });
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
    },
    [
      appendEditVideoReferencesToTaskCache,
      previzFrameReferenceIds,
      previzSelectedReferenceIds,
      queryClient,
      selectedTaskId,
      updatePrevizTask,
    ],
  );

  const removeEditVideoReference = useCallback(
    async (referenceId: string): Promise<void> => {
      if (!selectedTaskId) throw new Error("No task selected");
      await deleteAssetMutation.mutateAsync({
        taskId: selectedTaskId,
        payload: { assetType: "edit_video_reference", referenceId },
      });
      setEditVideoSelectedReferenceIds((previous) => previous.filter((id) => id !== referenceId));
    },
    [deleteAssetMutation, selectedTaskId],
  );

  const removePrevizReference = useCallback(
    async (referenceId: string): Promise<void> => {
      if (!selectedTaskId) throw new Error("No task selected");
      await deleteAssetMutation.mutateAsync({
        taskId: selectedTaskId,
        payload: { assetType: "edit_video_reference", referenceId },
      });
      if (previzSelectedReferenceIds.includes(referenceId)) {
        await updatePrevizTask({
          selectedReferenceIds: previzSelectedReferenceIds.filter((id) => id !== referenceId),
        });
      }
    },
    [deleteAssetMutation, previzSelectedReferenceIds, selectedTaskId, updatePrevizTask],
  );

  const removePrevizFrameReference = useCallback(
    async (referenceId: string): Promise<void> => {
      if (!selectedTaskId) throw new Error("No task selected");
      await deleteAssetMutation.mutateAsync({
        taskId: selectedTaskId,
        payload: { assetType: "edit_video_reference", referenceId },
      });
      await updatePrevizTask({
        frameReferenceIds: previzFrameReferenceIds.filter((id) => id !== referenceId),
        selectedFrameIds: previzSelectedFrameIds.filter((id) => id !== referenceId),
      });
    },
    [deleteAssetMutation, previzFrameReferenceIds, previzSelectedFrameIds, selectedTaskId, updatePrevizTask],
  );

  async function resolveReferencePickerSelection(selectedItemIds: string[]): Promise<string[]> {
    if (!selectedTaskId) throw new Error("No task selected");
    const resolvedSelection: Array<{ referenceId?: string; sourceKey?: string }> = [];
    const importPayload: Array<{
      sourceKey: string;
      filename?: string | null;
      sourceType: "uploaded" | "generated" | "frame_capture" | "frame_variant";
      originTaskId?: string | null;
    }> = [];

    for (const itemId of selectedItemIds) {
      const item = referencePickerItemById.get(itemId);
      if (!item) continue;
      if (item.referenceId && item.taskId === selectedTaskId) {
        resolvedSelection.push({ referenceId: item.referenceId });
        continue;
      }
      const existingImportedReference = editVideoReferences.find(
        (reference) => reference.originSourceKey === item.sourceKey || reference.key === item.sourceKey,
      );
      if (existingImportedReference) {
        resolvedSelection.push({ referenceId: existingImportedReference.referenceId });
        continue;
      }
      resolvedSelection.push({ sourceKey: item.sourceKey });
      importPayload.push({
        sourceKey: item.sourceKey,
        filename: keyBasenameFromS3Key(item.sourceKey),
        sourceType:
          item.sourceType === "frame_capture" || item.sourceType === "frame_variant"
            ? item.sourceType
            : item.sourceGroup === "upload"
              ? "uploaded"
              : "generated",
        originTaskId: item.taskId,
      });
    }

    if (importPayload.length) {
      const imported = await apiClient.importEditVideoReferences(selectedTaskId, { sources: importPayload });
      appendEditVideoReferencesToTaskCache(selectedTaskId, imported.references);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      for (const item of resolvedSelection) {
        if (item.referenceId || !item.sourceKey) continue;
        const matched = imported.references.find((reference) => reference.originSourceKey === item.sourceKey);
        if (matched) {
          item.referenceId = matched.referenceId;
        }
      }
    }

    return resolvedSelection.map((item) => item.referenceId).filter((referenceId): referenceId is string => Boolean(referenceId));
  }

  async function applyReferencePickerSelection(selectedItemIds: string[]): Promise<void> {
    const resolvedReferenceIds = await resolveReferencePickerSelection(selectedItemIds);
    setEditVideoSelectedReferenceIds(
      isCharacterAnimateWorkflow ? resolvedReferenceIds.slice(0, 1) : resolvedReferenceIds,
    );
  }

  async function applyEditFramePickerSelection(selectedItemIds: string[]): Promise<void> {
    if (!selectedTaskId) throw new Error("No task selected");
    const frameRecord = editFrameTab === "first" ? editFirstFrame : editLastFrame;
    if (!frameRecord?.frameId) throw new Error("No source frame selected");
    const selectedItemId = selectedItemIds[0];
    if (!selectedItemId) throw new Error("Choose one image to apply");
    const item = referencePickerItemById.get(selectedItemId);
    if (!item) throw new Error("Selected image is no longer available");
    const sourceType =
      item.sourceType === "frame_capture" || item.sourceType === "frame_variant"
        ? item.sourceType
        : item.sourceGroup === "upload"
          ? "uploaded"
          : "generated";
    const imported = await apiClient.importManualFrameVariant(selectedTaskId, frameRecord.frameId, {
      sources: [
        {
          sourceKey: item.sourceKey,
          filename: keyBasenameFromS3Key(item.sourceKey),
          sourceType,
          originTaskId: item.taskId,
        },
      ],
    });
    const variantId = imported.variant.variantId;
    setCompareVariantIds((previous) => ({ ...previous, [editFrameTab]: variantId || previous[editFrameTab] }));
    setRefineSourceVariantIds((previous) => ({ ...previous, [editFrameTab]: null }));
    setEditSourceVariantIds((previous) => ({ ...previous, [editFrameTab]: variantId || previous[editFrameTab] }));
    await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
  }

  async function applyToolReferencePickerSelection(selectedItemIds: string[]): Promise<void> {
    const resolvedReferenceIds = await resolveReferencePickerSelection(selectedItemIds);
    setEditVideoToolSelectedReferenceIds(resolvedReferenceIds);
  }

  async function applyPrevizReferencePickerSelection(selectedItemIds: string[]): Promise<void> {
    const resolvedReferenceIds = await resolveReferencePickerSelection(selectedItemIds);
    await updatePrevizTask({ selectedReferenceIds: resolvedReferenceIds });
  }

  async function applyPrevizFramePickerSelection(selectedItemIds: string[]): Promise<void> {
    const resolvedReferenceIds = await resolveReferencePickerSelection(selectedItemIds);
    await updatePrevizTask({ selectedFrameIds: resolvedReferenceIds });
  }

  async function applyPrevizToolReferencePickerSelection(selectedItemIds: string[]): Promise<void> {
    const resolvedReferenceIds = await resolveReferencePickerSelection(selectedItemIds);
    await updatePrevizTask({ selectedReferenceIds: resolvedReferenceIds });
  }

  const captureReferenceFrameFromVideo = useCallback(
    async (videoItem: ReferencePickerVideoItem, progressRatio: number): Promise<string[]> => {
      if (!selectedTaskId) throw new Error("No task selected");
      if (!videoItem.canCaptureFrame) {
        throw new Error("Frame capture is currently supported only for uploaded task source videos.");
      }
      const frameCount = Math.max(1, Number(videoItem.frameCount ?? 0) || 0);
      if (!frameCount) {
        throw new Error("Selected video is missing frame metadata.");
      }
      const clampedRatio = Math.min(1, Math.max(0, progressRatio));
      const frameIndex = clampInteger(Math.round(clampedRatio * Math.max(0, frameCount - 1)), 0, Math.max(0, frameCount - 1));
      const captured = await apiClient.captureFrame(videoItem.taskId, frameIndex);
      await queryClient.invalidateQueries({ queryKey: ["task", videoItem.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", videoItem.taskId] });

      const existingImportedReference = editVideoReferences.find(
        (reference) => reference.originSourceKey === captured.captureKey || reference.key === captured.captureKey,
      );
      if (existingImportedReference) {
        return [`reference:${existingImportedReference.referenceId}`];
      }

      const imported = await apiClient.importEditVideoReferences(selectedTaskId, {
        sources: [
          {
            sourceKey: captured.captureKey,
            filename: `frame-${captured.frameIndex}.png`,
            sourceType: "frame_capture",
            originTaskId: videoItem.taskId,
          },
        ],
      });
      appendEditVideoReferencesToTaskCache(selectedTaskId, imported.references);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", selectedTaskId] });
      return imported.references.map((reference) => `reference:${reference.referenceId}`);
    },
    [appendEditVideoReferencesToTaskCache, editVideoReferences, queryClient, selectedTaskId],
  );

  const moveSelectedPrevizReference = useCallback(
    (referenceId: string, direction: -1 | 1): void => {
      const currentIndex = previzSelectedReferenceIds.indexOf(referenceId);
      if (currentIndex < 0) return;
      const targetIndex = currentIndex + direction;
      if (targetIndex < 0 || targetIndex >= previzSelectedReferenceIds.length) return;
      const nextReferenceIds = [...previzSelectedReferenceIds];
      const [movedReferenceId] = nextReferenceIds.splice(currentIndex, 1);
      nextReferenceIds.splice(targetIndex, 0, movedReferenceId);
      void updatePrevizTask({ selectedReferenceIds: nextReferenceIds });
    },
    [previzSelectedReferenceIds, updatePrevizTask],
  );

  const removeSelectedPrevizReference = useCallback(
    async (referenceId: string): Promise<void> => {
      await updatePrevizTask({
        selectedReferenceIds: previzSelectedReferenceIds.filter((id) => id !== referenceId),
      });
    },
    [previzSelectedReferenceIds, updatePrevizTask],
  );

  const toggleSelectedPrevizReferenceId = useCallback(
    async (referenceId: string): Promise<void> => {
      const nextSelectedReferenceIds = previzSelectedReferenceIds.includes(referenceId)
        ? previzSelectedReferenceIds.filter((id) => id !== referenceId)
        : [...previzSelectedReferenceIds, referenceId];
      await updatePrevizTask({ selectedReferenceIds: nextSelectedReferenceIds });
    },
    [previzSelectedReferenceIds, updatePrevizTask],
  );

  const moveSelectedPrevizFrame = useCallback(
    (referenceId: string, direction: -1 | 1): void => {
      const currentIndex = previzSelectedFrameIds.indexOf(referenceId);
      if (currentIndex < 0) return;
      const targetIndex = currentIndex + direction;
      if (targetIndex < 0 || targetIndex >= previzSelectedFrameIds.length) return;
      const nextFrameIds = [...previzSelectedFrameIds];
      const [movedReferenceId] = nextFrameIds.splice(currentIndex, 1);
      nextFrameIds.splice(targetIndex, 0, movedReferenceId);
      void updatePrevizTask({ selectedFrameIds: nextFrameIds });
    },
    [previzSelectedFrameIds, updatePrevizTask],
  );

  const removeSelectedPrevizFrame = useCallback(
    async (referenceId: string): Promise<void> => {
      await updatePrevizTask({
        selectedFrameIds: previzSelectedFrameIds.filter((id) => id !== referenceId),
      });
    },
    [previzSelectedFrameIds, updatePrevizTask],
  );

  const toggleSelectedPrevizFrameId = useCallback(
    async (referenceId: string): Promise<void> => {
      const nextSelectedFrameIds = previzSelectedFrameIds.includes(referenceId)
        ? previzSelectedFrameIds.filter((id) => id !== referenceId)
        : [...previzSelectedFrameIds, referenceId];
      await updatePrevizTask({ selectedFrameIds: nextSelectedFrameIds });
    },
    [previzSelectedFrameIds, updatePrevizTask],
  );

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
    if (!item.deletePayload) return;
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
  const primaryTabs = useMemo(() => currentTaskWorkflow.primaryTabs, [currentTaskWorkflow]);
  const {
    currentReferenceSegment,
    currentReferenceStartImageUrl,
    currentReferenceEndImageUrl,
    currentReferenceAssets,
    currentReferenceWarning,
  } = useCurrentWorkingReferenceState({
    workflowId: currentTaskWorkflowId,
    activeWorkflowSection,
    selectedSegment,
    defaultVideoSegment,
    task,
    selectedPreviewGeneration,
    mergeTargetGeneration,
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
    editVideoReferencePreview,
    previzReferencePreview,
    previzFramePreview: previzSelectedFramePreview,
    sourceMediaKind,
    sourceWaveformUrl,
  });

  const pickFrameTabCtx = useMemo<PickFrameTabCtx>(
    () => ({
      timelinePlaybackUrl,
      timelineVideoRef,
      availableProjects,
      currentProjectId: effectiveCurrentProjectId,
      isUpdatingProject: updateTaskProjectMutation.isPending,
      assignProjectToTask: async (projectId) => {
        await updateTaskProjectMutation.mutateAsync(projectId).catch((error) => {
          throw error instanceof Error ? error : new Error("Failed to update task project");
        });
      },
      sourceMediaKind,
      sourceWaveformUrl,
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
      availableProjects,
      effectiveCurrentProjectId,
      sourceMediaKind,
      sourceWaveformUrl,
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
      updateTaskProjectMutation,
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
      openEditFrameReferencePicker: () => setIsEditFrameReferenceImagePickerOpen(true),
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
      setIsEditFrameReferenceImagePickerOpen,
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
      taskId: selectedTaskId,
      references: editVideoReferenceLibraryItems,
      warning: editVideoReferenceWarning,
      openVideoReferencePicker: () => setIsReferenceImagePickerOpen(true),
      openToolReferencePicker: () => setIsToolReferenceImagePickerOpen(true),
      toolSelectedReferences: editVideoToolReferencePreview.map((item) => ({
        referenceId: item.referenceId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: item.subtitle ?? "",
      })),
      generatePrompt: editVideoReferencePromptDraft,
      onGeneratePromptChange: setEditVideoReferencePromptDraft,
      moveToolSelectedReference: moveToolSelectedEditVideoReference,
      removeToolSelectedReference: removeToolSelectedEditVideoReference,
      toggleVideoReference: toggleSelectedEditVideoReferenceId,
      removeReference: removeEditVideoReference,
      previewReference: ({ url, label }) => setImagePreviewModal({ url, label }),
      generateReferenceImage: generateEditVideoReferenceImage,
      labels:
        isCharacterAnimateWorkflow
          ? {
              selectTitle: "Select character image",
              selectDescription:
                "Upload or choose a previously generated image of the character you want to animate.",
              selectButtonLabel: "Upload / choose character image",
              createTitle: "Create character image",
              toolPickerButtonLabel: "Use character references",
              promptPlaceholder: "Describe the character image you want to create.",
              promptHelper:
                "If using reference images, describe their purpose in the prompt in the order they appear above.",
              createButtonIdle: "Create character",
              createButtonPending: "Creating...",
              selectedTokenPrefix: "Character",
              useAssetButtonLabel: "Use as Character",
              removeAssetButtonLabel: "Remove Character",
              queuedHint: "Waiting for generated character image...",
              failedHint: "Character image generation failed.",
            }
          : undefined,
      preferredAspectRatio: isCharacterAnimateWorkflow ? characterImagePreferredAspectRatio : null,
      addTopSpacing: isCharacterAnimateWorkflow,
    }),
    [
      editVideoReferencePromptDraft,
      selectedTaskId,
      characterImagePreferredAspectRatio,
      isCharacterAnimateWorkflow,
      editVideoReferenceLibraryItems,
      editVideoReferenceWarning,
      editVideoToolReferencePreview,
      generateEditVideoReferenceImage,
      moveToolSelectedEditVideoReference,
      removeEditVideoReference,
      removeToolSelectedEditVideoReference,
      setImagePreviewModal,
      toggleSelectedEditVideoReferenceId,
    ],
  );

  const previzSelectTabCtx = useMemo<PrevizSelectTabCtx>(
    () => ({
      taskId: selectedTaskId,
      availableProjects,
      currentProjectId: effectiveCurrentProjectId,
      isUpdatingProject: updateTaskProjectMutation.isPending,
      assignProjectToTask: async (projectId) => {
        await updateTaskProjectMutation.mutateAsync(projectId).catch((error) => {
          throw error instanceof Error ? error : new Error("Failed to update task project");
        });
      },
      sceneAspectRatio: previzSceneAspectRatio,
      onSceneAspectRatioChange: async (aspectRatio) => {
        await updatePrevizTask({ sceneAspectRatio: aspectRatio });
      },
      uploadReferences: previzUploadReferenceLibraryItems,
      createdReferences: previzCreatedReferenceLibraryItems,
      warning: null,
      openSceneReferencePicker: () => setIsPrevizReferenceImagePickerOpen(true),
      openToolReferencePicker: () => setIsPrevizToolReferenceImagePickerOpen(true),
      toolSelectedReferences: previzToolReferencePreview.map((item) => ({
        referenceId: item.referenceId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: item.subtitle ?? "",
      })),
      generatePrompt: previzReferencePromptDraft,
      onGeneratePromptChange: setPrevizReferencePromptDraft,
      moveToolSelectedReference: moveToolSelectedPrevizReference,
      removeToolSelectedReference: removeToolSelectedPrevizReference,
      toggleReferenceSelection: toggleSelectedPrevizReferenceId,
      removeReference: removePrevizReference,
      previewReference: ({ url, label }) => setImagePreviewModal({ url, label }),
      generateReferenceImage: generatePrevizReferenceImage,
    }),
    [
      selectedTaskId,
      availableProjects,
      effectiveCurrentProjectId,
      generatePrevizReferenceImage,
      moveToolSelectedPrevizReference,
      previzCreatedReferenceLibraryItems,
      previzReferencePromptDraft,
      previzSceneAspectRatio,
      previzToolReferencePreview,
      previzUploadReferenceLibraryItems,
      removePrevizReference,
      removeToolSelectedPrevizReference,
      setImagePreviewModal,
      toggleSelectedPrevizReferenceId,
      updatePrevizTask,
      updateTaskProjectMutation,
    ],
  );

  const previzEditTabCtx = useMemo<PrevizEditTabCtx>(
    () => ({
      taskId: selectedTaskId,
      sceneAspectRatio: previzSceneAspectRatio ?? "16:9",
      selectedReferenceCount: previzSelectedReferenceIds.length,
      frames: previzFrameLibraryItems,
      prompt: previzFramePromptDraft,
      onPromptChange: setPrevizFramePromptDraft,
      onCreateFrame: generatePrevizFrameImage,
      onToggleFrameSelection: toggleSelectedPrevizFrameId,
      onRemoveFrame: removePrevizFrameReference,
      onPreviewFrame: ({ url, label }) => setImagePreviewModal({ url, label }),
    }),
    [
      selectedTaskId,
      generatePrevizFrameImage,
      previzFramePromptDraft,
      previzFrameLibraryItems,
      previzSceneAspectRatio,
      previzSelectedReferenceIds.length,
      removePrevizFrameReference,
      setImagePreviewModal,
      toggleSelectedPrevizFrameId,
    ],
  );

  const previzGenerateTabCtx = useMemo<PrevizGenerateTabCtx>(
    () => ({
      sceneAspectRatio: previzSceneAspectRatio ?? "16:9",
      scenePrompt: typeof previzState?.scenePrompt === "string" ? previzState.scenePrompt : "",
      selectedFrames: previzSelectedFramePreview.map((item) => ({
        referenceId: item.referenceId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: item.subtitle ?? "",
      })),
      model: previzGenerateModel,
      onModelChange: setPrevizGenerateModel,
      prompt: previzGeneratePrompt,
      onPromptChange: setPrevizGeneratePrompt,
      durationSec: previzGenerateDurationSec,
      onDurationSecChange: setPrevizGenerateDurationSec,
      generations: previzVisibleGenerations,
      selectedGenerationId: selectedPreviewGeneration?.genId ?? null,
      onGenerate: () => generatePrevizVideoMutation.mutate(),
      isGenerating: generatePrevizVideoMutation.isPending,
      error: generatePrevizVideoMutation.error instanceof Error ? generatePrevizVideoMutation.error.message : null,
      onSelectGeneration: selectSegmentGeneration,
      onPreviewGeneration: (generation) =>
        setVideoPreviewModal({
          url: generation.downloadUrl ?? "",
          label: "Previz video preview",
          taskId: task?.taskId,
          generationId: generation.genId,
        }),
      onDeleteGeneration: (generation) =>
        handleDeleteAsset({
          id: `generation:${task?.taskId ?? ""}:${generation.genId}`,
          taskId: task?.taskId ?? "",
          title: describeGeneration(generation),
          subtitle: `${generation.luma.model}/${generation.luma.mode}`,
          createdAt: generation.createdAt,
          previewUrl: generation.downloadUrl ?? generation.posterUrl ?? "",
          downloadUrl: generation.downloadUrl ?? "",
          thumbnailUrl: generation.posterUrl ?? undefined,
          mediaType: "video",
          deletePayload: { assetType: "segment_generation", genId: generation.genId },
        }),
    }),
    [
      describeGeneration,
      generatePrevizVideoMutation,
      handleDeleteAsset,
      previzGenerateDurationSec,
      previzGenerateModel,
      previzGeneratePrompt,
      previzSceneAspectRatio,
      previzSelectedFramePreview,
      previzState?.scenePrompt,
      previzVisibleGenerations,
      selectSegmentGeneration,
      selectedPreviewGeneration?.genId,
      setVideoPreviewModal,
      task?.taskId,
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
      editVideoReferenceWarning,
      openEditVideoReferencePicker: () => setIsReferenceImagePickerOpen(true),
      supportsGenerationAudioReference: generationInputMode === "edit_video" && lumaModel === "seedance-2.0-reference-to-video",
      generationAudioReference,
      uploadGenerationAudioReference,
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
      extendGeneration: extendSegmentGenerationMutation.mutate,
      isExtendingGeneration: extendSegmentGenerationMutation.isPending,
      extendGenerationError:
        extendSegmentGenerationMutation.error instanceof Error ? extendSegmentGenerationMutation.error.message : null,
      lengthenGeneration: lengthenSegmentGenerationMutation.mutate,
      isLengtheningGeneration: lengthenSegmentGenerationMutation.isPending,
      lengthenGenerationError:
        lengthenSegmentGenerationMutation.error instanceof Error ? lengthenSegmentGenerationMutation.error.message : null,
      editVideoSelectedReferenceIds,
      onAssetError: handleMediaAssetError,
      handleDeleteAsset,
      setGenerationCardsVisible,
    }),
    [
      handleTabChange,
      generationModelByInput,
      generationInputMode,
      editVideoReferenceWarning,
      generationAudioReference,
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
      uploadGenerationAudioReference,
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
      extendSegmentGenerationMutation.mutate,
      extendSegmentGenerationMutation.isPending,
      extendSegmentGenerationMutation.error,
      lengthenSegmentGenerationMutation.mutate,
      lengthenSegmentGenerationMutation.isPending,
      lengthenSegmentGenerationMutation.error,
      editVideoSelectedReferenceIds,
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
      lengthenGeneration: lengthenSegmentGenerationMutation.mutate,
      isLengtheningGeneration: lengthenSegmentGenerationMutation.isPending,
      lengthenGenerationError:
        lengthenSegmentGenerationMutation.error instanceof Error ? lengthenSegmentGenerationMutation.error.message : null,
      editVideoSelectedReferenceIds,
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
        const originalUrl = mergeOriginalVideoForPreview;
        if (!originalUrl || !generation.downloadUrl) return;
        const segmentStartPosterUrl = mergeTargetSegment ? task?.frames?.[mergeTargetSegment.startFrameId]?.imageUrl ?? null : null;
        const originalPosterUrl = segmentStartPosterUrl;
        setVideoCompareModal({
          originalUrl,
          compareUrl: generation.downloadUrl,
          label: describeGeneration(generation),
          posterUrl: generationThumbnailUrl(generation),
          originalPosterUrl,
          segmentStartSec: segmentWindow?.startSec,
          originalIsSegmentClip: originalPreviewIsSegmentClip,
          originalSegmentId: mergeTargetSegment?.segmentId,
          compareGenerationId: generation.genId,
          preferGenerationInputMediaAsOriginal: false,
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
      lengthenSegmentGenerationMutation.mutate,
      lengthenSegmentGenerationMutation.isPending,
      lengthenSegmentGenerationMutation.error,
      editVideoSelectedReferenceIds,
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
    assetLibraryScope,
    assetsLoading: assetsTabLoading,
    assetLibraryLoading: assetLibraryTabLoading,
    mergedVideoAssets,
    mergedAssetsVisible,
    setMergedAssetsVisible,
    generatedVideoAssets,
    generatedAssetsVisible,
    setGeneratedAssetsVisible,
    postProcessVideoAssets,
    postProcessAssetsVisible,
    setPostProcessAssetsVisible,
    editedFrameAssets,
    editedFrameAssetsVisible,
    setEditedFrameAssetsVisible,
    referenceImageAssets,
    referenceImageAssetsVisible,
    setReferenceImageAssetsVisible,
    orphanedAssets,
    orphanedAssetsVisible,
    setOrphanedAssetsVisible,
    audioAssets,
    audioAssetsVisible,
    setAudioAssetsVisible,
    libraryMergedVideoAssets,
    libraryMergedAssetsVisible,
    setLibraryMergedAssetsVisible,
    libraryGeneratedVideoAssets,
    libraryGeneratedAssetsVisible,
    setLibraryGeneratedAssetsVisible,
    libraryPostProcessVideoAssets,
    libraryPostProcessAssetsVisible,
    setLibraryPostProcessAssetsVisible,
    libraryEditedFrameAssets,
    libraryEditedFrameAssetsVisible,
    setLibraryEditedFrameAssetsVisible,
    libraryReferenceImageAssets,
    libraryReferenceImageAssetsVisible,
    setLibraryReferenceImageAssetsVisible,
    libraryOrphanedAssets,
    libraryOrphanedAssetsVisible,
    setLibraryOrphanedAssetsVisible,
    libraryAudioAssets,
    libraryAudioAssetsVisible,
    setLibraryAudioAssetsVisible,
    selectedReportOutputs,
    reportOutputRefKey,
    toggleCustomReportOutput,
    clearCustomReportOutputs,
    handleDeleteAsset,
    createCustomReport: createCustomReportMutation.mutateAsync,
    isCreatingCustomReport: createCustomReportMutation.isPending,
    formatAssetDate,
    previewImage: ({ url, label }) => {
      setImagePreviewModal({ url, label });
    },
    goToReport: (taskId: string) => {
      goToReport(taskId, "reports", null);
    },
  });

  const taskPickerModalNode = (
    <WorkflowTaskPickerModal
      workflowId={taskPickerWorkflowId}
      tasks={taskPickerWorkflowId ? workflowTasksById.get(taskPickerWorkflowId) ?? [] : []}
      taskPreviewUrlsById={taskPickerPreviewUrlsById}
      onClose={() => setTaskPickerWorkflowId(null)}
      onSelectTask={openTaskFromPicker}
      onNewTask={openNewTaskWithAutomationDefaults}
    />
  );

  const newTaskModalNode = (
    <NewTaskModal
      isOpen={isNewTaskModalOpen}
      stage={newTaskStage}
      taskName={newTaskName}
      workflowId={newTaskWorkflowId}
      normalizedTaskName={normalizedNewTaskName}
      showTaskNameExistsWarning={showTaskNameExistsWarning}
      taskNameAlreadyExists={taskNameAlreadyExists}
      scenePrompt={newTaskScenePrompt}
      uploadPercent={newTaskUploadPercent}
      ingestProgress={pendingCreateJobQuery.data?.progress ?? 0}
      ingestStatus={pendingCreateJobQuery.data?.status ?? "queued"}
      error={automationUiError ?? newTaskError}
      canSubmit={
        !newTaskName.trim()
          ? false
          : isPrevizWorkflowId(newTaskWorkflowId)
            ? Boolean(normalizedNewTaskName && newTaskScenePrompt.trim())
            : Boolean(normalizedNewTaskName && newTaskFile)
      }
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
      onScenePromptChange={setNewTaskScenePrompt}
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
  );

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

  if (isHomeRoute) {
    return (
      <>
        <HomePage
          cards={workflowHomeCardsWithPreview}
          onSelectTask={openTaskPickerForWorkflow}
          onOpenLatestTask={openTaskAtSelectStep}
          onNewTask={openNewTaskWithAutomationDefaults}
          onSignOut={() => {
            void logout();
          }}
        />
        <>{taskPickerModalNode}{newTaskModalNode}</>
      </>
    );
  }

  if (isWorkflowLandingRoute) {
    return (
      <>
        <WorkflowLandingPage
          workflowId={currentTaskWorkflowId}
          latestTaskId={workflowLandingLatestTask?.taskId ?? null}
          latestTaskName={workflowLandingLatestTask?.name ?? null}
          latestTaskProjectName={workflowLandingLatestTask?.projectName ?? null}
          latestTaskThumbnailUrl={workflowLandingLatestTaskThumbnailUrl}
          onSelectTask={openTaskPickerForWorkflow}
          onOpenLatestTask={openTaskAtSelectStep}
          onNewTask={openNewTaskWithAutomationDefaults}
          onGoHome={() => goHome()}
          onSignOut={() => {
            void logout();
          }}
        />
        <>{taskPickerModalNode}{newTaskModalNode}</>
      </>
    );
  }

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto grid max-w-[1500px] grid-cols-12 gap-4 p-4 md:p-6">
        <TaskSidebar
          tasks={tasksQuery.data ?? []}
          selectedTaskId={selectedTaskId}
          currentWorkflowId={currentTaskWorkflowId}
          isAdmin={isAdmin}
          onSignOut={() => {
            void logout();
          }}
          onGoHome={() => goHome()}
          onOpenNewTask={() => openNewTaskWithAutomationDefaults(currentTaskWorkflowId)}
          onOpenTaskReport={openTaskReport}
          onSelectTask={openTaskAtSelectStep}
          onDeleteTask={(taskId) => deleteTaskMutation.mutate(taskId)}
          onOpenAssetLibrary={() => {
            setAssetLibraryScope("mine");
            void handleTabChange("asset_library");
          }}
          onOpenAllAssetLibrary={() => {
            setAssetLibraryScope("all");
            void handleTabChange("asset_library");
          }}
          onOpenCustomQc={() => {
            void handleTabChange("custom_qc");
          }}
          onOpenApiLogs={() => {
            setApiLogsScope("mine");
            void handleTabChange("api_logs");
          }}
          onOpenAllApiLogs={() => {
            setApiLogsScope("all");
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
            {!isGlobalUtilityTab ? (
              <div className="space-y-3">
                {isResolvingWorkflowShell ? (
                  <StatusNotice variant="loading" title="Loading task">
                    <p className="text-sm">Resolving workflow and task state…</p>
                  </StatusNotice>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Workflow</p>
                        <p className="text-sm text-ink/70">{currentTaskWorkflow.label}</p>
                      </div>
                      {!isCurrentWorkflowImplemented ? (
                        <span className="rounded-full border border-ink/10 bg-bg px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/55">
                          Scaffolded
                        </span>
                      ) : null}
                    </div>
                    <WorkflowTabs
                      tabs={primaryTabs}
                      activeTab={activeWorkflowSection ?? "source"}
                      onSelect={(sectionId) => {
                        handlePrimaryWorkflowSectionChange(sectionId as PrimaryWorkflowSection);
                      }}
                      variant="primary"
                    />
                    {showWorkflowCurrentReferences ? (
                      <div className={showPrevizEditTab || showPrevizGenerateTab ? "mb-6" : "mb-4"}>
                        <CurrentWorkingReferencePanel
                          segment={currentReferenceSegment}
                          startFrameImageUrl={currentReferenceStartImageUrl}
                          endFrameImageUrl={currentReferenceEndImageUrl}
                          warning={currentReferenceWarning}
                          assets={currentReferenceAssets}
                          sourceMediaKind={showPrevizEditTab || showPrevizGenerateTab || showPrevizPostTab ? "scene" : sourceMediaKind}
                          sourceFrameCount={frameCount(task)}
                          sourceFps={fpsValue(task)}
                          headerAction={
                            showPrevizEditTab || showPrevizGenerateTab ? (
                              <button
                                type="button"
                                className="w-[6.75rem] rounded-md bg-accent px-4 py-2 text-sm font-medium leading-tight text-white"
                                onClick={() => {
                                  if (showPrevizGenerateTab) {
                                    setIsPrevizGenerateReferenceImagePickerOpen(true);
                                    return;
                                  }
                                  setIsPrevizEditReferenceImagePickerOpen(true);
                                }}
                              >
                                <span className="block text-center">
                                  Manage
                                  <br />
                                  references
                                </span>
                              </button>
                            ) : undefined
                          }
                          onPreviewImage={({ url, label }) => setImagePreviewModal({ url, label })}
                          onPreviewVideo={({ url, label }) => setVideoPreviewModal({ url, label })}
                          onPreviewAudio={({ url, label, waveformUrl }) => setAudioPreviewModal({ url, label, waveformUrl })}
                          onAssetAction={(asset) => {
                            if (asset.actionId === "edit-video-reference-picker") {
                              setIsReferenceImagePickerOpen(true);
                              return;
                            }
                            if (asset.actionId?.startsWith("previz-frame-move-left:")) {
                              moveSelectedPrevizFrame(asset.actionId.slice("previz-frame-move-left:".length), -1);
                              return;
                            }
                            if (asset.actionId?.startsWith("previz-frame-move-right:")) {
                              moveSelectedPrevizFrame(asset.actionId.slice("previz-frame-move-right:".length), 1);
                              return;
                            }
                            if (asset.actionId?.startsWith("previz-frame-remove:")) {
                              void removeSelectedPrevizFrame(asset.actionId.slice("previz-frame-remove:".length));
                              return;
                            }
                            if (asset.actionId?.startsWith("previz-reference-move-left:")) {
                              moveSelectedPrevizReference(asset.actionId.slice("previz-reference-move-left:".length), -1);
                              return;
                            }
                            if (asset.actionId?.startsWith("previz-reference-move-right:")) {
                              moveSelectedPrevizReference(asset.actionId.slice("previz-reference-move-right:".length), 1);
                              return;
                            }
                            if (asset.actionId?.startsWith("previz-reference-remove:")) {
                              void removeSelectedPrevizReference(asset.actionId.slice("previz-reference-remove:".length));
                              return;
                            }
                            if (asset.actionId?.startsWith("select-generation:")) {
                              selectSegmentGeneration(asset.actionId.slice("select-generation:".length));
                            }
                          }}
                        />
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            <div className={workflowContentTopGapClass}>
            {!isResolvingWorkflowShell && !isCurrentWorkflowImplemented && !showPrevizSelectTab && !showPrevizEditTab && !showPrevizGenerateTab && !showPrevizPostTab && !isGlobalUtilityTab ? (
              <div className="rounded-xl border border-dashed border-ink/15 bg-bg p-4">
                {currentTaskWorkflowId === "canvas_workflow" ? (
                  <>
                    <p className="text-sm font-medium text-ink">Canvas workflow tasks are recognised but authored in a separate surface.</p>
                    <p className="mt-1 text-sm text-ink/65">
                      This app will preserve the shared task shell, auth, asset library, and report compatibility for canvas tasks
                      without exposing the canvas authoring UI here.
                    </p>
                    <p className="mt-3 text-xs leading-5 text-ink/55">
                      Use the shared Assets and Reports tabs to inspect outputs linked to this task. Workflow-specific creation and
                      editing controls will be added in the dedicated canvas surface.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-ink">{currentTaskWorkflow.label} is scaffolded but not implemented yet.</p>
                    <p className="mt-1 text-sm text-ink/65">
                      The shared task shell, assets library, and reports infrastructure can already recognise this workflow. The
                      workflow-specific step content will be added next.
                    </p>
                  </>
                )}
              </div>
            ) : null}

            {showPrevizSelectTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Select...</p>}>
                <PrevizSelectTab ctx={previzSelectTabCtx} />
              </Suspense>
            )}

            {showPrevizEditTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Edit...</p>}>
                <PrevizEditTab ctx={previzEditTabCtx} />
              </Suspense>
            )}

            {showPrevizGenerateTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Generate...</p>}>
                <PrevizGenerateTab ctx={previzGenerateTabCtx} />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showSourceVideoSelectTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Source...</p>}>
                <PickFrameTab ctx={pickFrameTabCtx} />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showSourceVideoEditTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Edit frames...</p>}>
                {generationInputMode === "edit_video" ? (
                  <EditVideoReferencesTab ctx={editVideoReferencesTabCtx} />
                ) : (
                  <EditFrameTab ctx={editFrameTabCtx} />
                )}
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showCharacterSelectTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Select...</p>}>
                <PickFrameTab ctx={pickFrameTabCtx} />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showCharacterEditTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Edit...</p>}>
                <EditVideoReferencesTab ctx={editVideoReferencesTabCtx} />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showSourceVideoRefineTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Refine Frames...</p>}>
                <RefineFramesTab ctx={refineFramesTabCtx} />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showCharacterRefineTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Refine...</p>}>
                <CharacterAnimatePlaceholderTab
                  title="Refine step will be repurposed for character workflow"
                  body="The shared six-step shell is now in place for character animation. Workflow-specific refine behavior will be defined after the character-image and generation paths are wired."
                />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showSourceVideoGenerateTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Generate Video...</p>}>
                <GenerateTab ctx={generateTabCtx} />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showCharacterGenerateTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Outputs...</p>}>
                <CharacterAnimateGenerateTab
                  mode={characterAnimateMode}
                  sourceMediaKind={sourceMediaKind}
                  sourceAudioUrl={isCharacterAudioSource ? (task?.sourceMedia?.previewSource?.downloadUrl ?? task?.sourceMedia?.editSource?.downloadUrl ?? null) : null}
                  sourceWaveformUrl={isCharacterAudioSource ? sourceWaveformUrl : null}
                  sourceFrameCount={isCharacterAudioSource ? frameCount(task) : null}
                  selectedSegmentStartFrame={isCharacterAudioSource ? (selectedSegment?.startFrame ?? null) : null}
                  selectedSegmentEndFrameExclusive={isCharacterAudioSource ? (selectedSegment?.endFrameExclusive ?? null) : null}
                  selectedSegmentStartTimecode={isCharacterAudioSource ? (selectedSegment?.startTimecode ?? null) : null}
                  selectedSegmentEndTimecode={isCharacterAudioSource ? (selectedSegment?.endTimecode ?? null) : null}
                  selectedModel={selectedCharacterAnimateModel}
                  modelOptions={characterAnimateModelOptions}
                  onSelectModel={(model) =>
                    setCharacterAnimateModelByMode((previous) => ({ ...previous, [characterAnimateMode]: model }))
                  }
                  selectedSegmentLabel={selectedSegment ? describeSegment(selectedSegment) : null}
                  selectedSegmentDurationSec={selectedSegment?.durationSec ?? null}
                  selectedCharacterCount={editVideoSelectedReferenceIds.length}
                  prompt={characterAnimatePrompt}
                  onPromptChange={setCharacterAnimatePrompt}
                  outputAspectRatio={characterAnimateOutputAspectRatio}
                  onOutputAspectRatioChange={setCharacterAnimateOutputAspectRatio}
                  bodyControl={characterAnimateBodyControl}
                  onBodyControlChange={setCharacterAnimateBodyControl}
                  expressionIntensity={characterAnimateExpressionIntensity}
                  onExpressionIntensityChange={setCharacterAnimateExpressionIntensity}
                  klingMode={characterAnimateKlingMode}
                  onKlingModeChange={setCharacterAnimateKlingMode}
                  klingCharacterOrientation={characterAnimateKlingCharacterOrientation}
                  onKlingCharacterOrientationChange={setCharacterAnimateKlingCharacterOrientation}
                  omnihumanResolution={characterAnimateOmnihumanResolution}
                  onOmnihumanResolutionChange={setCharacterAnimateOmnihumanResolution}
                  seedanceResolution={characterAnimateSeedanceResolution}
                  onSeedanceResolutionChange={setCharacterAnimateSeedanceResolution}
                  seedanceAspectRatio={characterAnimateSeedanceAspectRatio}
                  onSeedanceAspectRatioChange={setCharacterAnimateSeedanceAspectRatio}
                  characterImageValidationError={runwayCharacterImageValidationError}
                  onGenerate={() => generateCharacterAnimationMutation.mutate()}
                  isGenerating={generateCharacterAnimationMutation.isPending}
                  generations={characterAnimateVisibleGenerations}
                  selectedGenerationId={selectedPreviewGeneration?.genId ?? null}
                  onSelectGeneration={selectSegmentGeneration}
                  onPreviewGeneration={(generation) =>
                    setVideoPreviewModal({
                      url: generation.downloadUrl ?? "",
                      label: "Character animation preview",
                      taskId: task?.taskId,
                      generationId: generation.genId,
                    })
                  }
                  onDeleteGeneration={(generation) =>
                    handleDeleteAsset({
                      id: `generation:${task?.taskId ?? ""}:${generation.genId}`,
                      taskId: task?.taskId ?? "",
                      title: describeGeneration(generation),
                      subtitle: `${generation.luma.model}/${generation.luma.mode}`,
                      createdAt: generation.createdAt,
                      previewUrl: generation.downloadUrl ?? generation.posterUrl ?? "",
                      downloadUrl: generation.downloadUrl ?? "",
                      thumbnailUrl: generation.posterUrl ?? undefined,
                      mediaType: "video",
                      deletePayload: { assetType: "segment_generation", genId: generation.genId },
                    })
                  }
                />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showSourceVideoPostTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Post Process...</p>}>
                <MergeTab ctx={mergeTabCtx} />
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
                    setAudioPreviewModal,
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

            {!isResolvingWorkflowShell && showCharacterPostTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Post Process...</p>}>
                <CharacterAnimatePostProcessTab
                  generations={characterAnimatePostProcessGenerations}
                  topazItems={characterAnimatePostProcessTopazItems}
                  describeGeneration={describeGeneration}
                  describeSegment={describeSegment}
                  getSegmentForGeneration={getSegmentForGeneration}
                  generationThumbnailUrl={generationThumbnailUrl}
                  formatCompactTimestamp={formatCompactTimestamp}
                  onPreviewGeneration={(generation) =>
                    setVideoPreviewModal({
                      url: generation.downloadUrl ?? "",
                      label: describeGeneration(generation),
                      taskId: task?.taskId,
                      generationId: generation.genId,
                    })
                  }
                  onPreviewTopazExport={(exportItem, sourceGeneration) =>
                    setVideoPreviewModal({
                      url: exportItem.downloadUrl ?? "",
                      label: `Topaz upscale of ${describeGeneration(sourceGeneration)}`,
                      taskId: task?.taskId,
                    })
                  }
                  onDeleteGeneration={(generation) =>
                    handleDeleteAsset({
                      id: `generation:${task?.taskId ?? ""}:${generation.genId}`,
                      taskId: task?.taskId ?? "",
                      title: describeGeneration(generation),
                      subtitle: `${generation.luma.model}/${generation.luma.mode}`,
                      createdAt: generation.createdAt,
                      previewUrl: generation.downloadUrl ?? generation.posterUrl ?? "",
                      downloadUrl: generation.downloadUrl ?? "",
                      thumbnailUrl: generation.posterUrl ?? undefined,
                      mediaType: "video",
                      deletePayload: { assetType: "segment_generation", genId: generation.genId },
                    })
                  }
                  onDeleteTopazExport={(exportItem, sourceGeneration) =>
                    handleDeleteAsset({
                      id: `export:${task?.taskId ?? ""}:${exportItem.exportId}`,
                      taskId: task?.taskId ?? "",
                      title: `Topaz upscale of ${describeGeneration(sourceGeneration)}`,
                      subtitle: exportItem.sourceExportId ? `Derived from export ${exportItem.sourceExportId}` : "Topaz export",
                      createdAt: exportItem.createdAt,
                      previewUrl: exportItem.downloadUrl ?? "",
                      downloadUrl: exportItem.downloadUrl ?? "",
                      mediaType: "video",
                      deletePayload: { assetType: "export", exportId: exportItem.exportId },
                    })
                  }
                  onAssetError={handleMediaAssetError}
                  onLengthenGeneration={(payload) => lengthenSegmentGenerationMutation.mutate(payload)}
                  isLengtheningGeneration={lengthenSegmentGenerationMutation.isPending}
                  lengthenGenerationError={
                    lengthenSegmentGenerationMutation.error instanceof Error ? lengthenSegmentGenerationMutation.error.message : null
                  }
                  onUpscaleGeneration={({ generationId, ...payload }) =>
                    runTopazUpscaleForGenerationMutation.mutate({ generationId, payload })
                  }
                  isUpscalingGeneration={runTopazUpscaleForGenerationMutation.isPending}
                  topazUpscalePendingGenerationId={topazUpscalePendingGenerationId}
                  topazUpscaleError={
                    runTopazUpscaleForGenerationMutation.error instanceof Error
                      ? runTopazUpscaleForGenerationMutation.error.message
                      : null
                  }
                  topazStateByGenerationId={characterTopazStateByGenerationId}
                />
              </Suspense>
            )}

            {!isResolvingWorkflowShell && showPrevizPostTab && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Post Process...</p>}>
                <div className="pt-3">
                  <CharacterAnimatePostProcessTab
                    generations={previzPostProcessGenerations}
                    topazItems={previzPostProcessTopazItems}
                    describeGeneration={describeGeneration}
                    describeSegment={describeSegment}
                    getSegmentForGeneration={getSegmentForGeneration}
                    generationThumbnailUrl={generationThumbnailUrl}
                    formatCompactTimestamp={formatCompactTimestamp}
                    onPreviewGeneration={(generation) =>
                      setVideoPreviewModal({
                        url: generation.downloadUrl ?? "",
                        label: describeGeneration(generation),
                        taskId: task?.taskId,
                        generationId: generation.genId,
                      })
                    }
                    onPreviewTopazExport={(exportItem, sourceGeneration) =>
                      setVideoPreviewModal({
                        url: exportItem.downloadUrl ?? "",
                        label: `Topaz upscale of ${describeGeneration(sourceGeneration)}`,
                        taskId: task?.taskId,
                      })
                    }
                    onDeleteGeneration={(generation) =>
                      handleDeleteAsset({
                        id: `generation:${task?.taskId ?? ""}:${generation.genId}`,
                        taskId: task?.taskId ?? "",
                        title: describeGeneration(generation),
                        subtitle: `${generation.luma.model}/${generation.luma.mode}`,
                        createdAt: generation.createdAt,
                        previewUrl: generation.downloadUrl ?? generation.posterUrl ?? "",
                        downloadUrl: generation.downloadUrl ?? "",
                        thumbnailUrl: generation.posterUrl ?? undefined,
                        mediaType: "video",
                        deletePayload: { assetType: "segment_generation", genId: generation.genId },
                      })
                    }
                    onDeleteTopazExport={(exportItem, sourceGeneration) =>
                      handleDeleteAsset({
                        id: `export:${task?.taskId ?? ""}:${exportItem.exportId}`,
                        taskId: task?.taskId ?? "",
                        title: `Topaz upscale of ${describeGeneration(sourceGeneration)}`,
                        subtitle: exportItem.sourceExportId ? `Derived from export ${exportItem.sourceExportId}` : "Topaz export",
                        createdAt: exportItem.createdAt,
                        previewUrl: exportItem.downloadUrl ?? "",
                        downloadUrl: exportItem.downloadUrl ?? "",
                        mediaType: "video",
                        deletePayload: { assetType: "export", exportId: exportItem.exportId },
                      })
                    }
                    onAssetError={handleMediaAssetError}
                    onLengthenGeneration={(payload) => lengthenSegmentGenerationMutation.mutate(payload)}
                    isLengtheningGeneration={lengthenSegmentGenerationMutation.isPending}
                    lengthenGenerationError={
                      lengthenSegmentGenerationMutation.error instanceof Error ? lengthenSegmentGenerationMutation.error.message : null
                    }
                    onUpscaleGeneration={({ generationId, ...payload }) =>
                      runTopazUpscaleForGenerationMutation.mutate({ generationId, payload })
                    }
                    isUpscalingGeneration={runTopazUpscaleForGenerationMutation.isPending}
                    topazUpscalePendingGenerationId={topazUpscalePendingGenerationId}
                    topazUpscaleError={
                      runTopazUpscaleForGenerationMutation.error instanceof Error
                        ? runTopazUpscaleForGenerationMutation.error.message
                        : null
                    }
                    topazStateByGenerationId={characterTopazStateByGenerationId}
                    labels={{
                      sectionTitle: "Previz post-process",
                      sectionDescription: "Review completed outputs and optionally extend, upscale or edit the video.",
                      emptyState: "No completed previz videos yet.",
                      extendModalTitle: "Extend previz video",
                      upscaleModalTitle: "Upscale previz video",
                      fallbackGenerationLabel: "Previz video",
                    }}
                  />
                </div>
              </Suspense>
            )}

            {tab === "assets" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Download Assets...</p>}>
                <AssetsTab ctx={assetsTabCtx} />
              </Suspense>
            )}

            {tab === "asset_library" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading Asset Library...</p>}>
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 bg-white p-4">
                    <div>
                      <p className="text-sm font-semibold text-ink">Asset scope</p>
                      <p className="text-xs text-ink/60">
                        {assetLibraryScope === "all"
                          ? "Admin view across all users."
                          : assetLibraryScope === "project"
                            ? `Assets from tasks linked to ${effectiveCurrentProject?.name ?? "the current project"}.`
                            : "Your own tasks only."}
                      </p>
                    </div>
                    <select
                      className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm text-ink"
                      value={assetLibraryScope}
                      onChange={(event) => setAssetLibraryScope(event.target.value as "mine" | "project" | "all")}
                    >
                      <option value="mine">My assets</option>
                      {hasEffectiveProjectScope ? <option value="project">Current project</option> : null}
                      {isAdmin ? <option value="all">All assets</option> : null}
                    </select>
                  </div>
                  <AssetsTab ctx={assetLibraryTabCtx} />
                </div>
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
                <ApiLogsPage scope={isAdmin ? apiLogsScope : "mine"} />
              </Suspense>
            )}

            {tab === "admin" && (
              <Suspense fallback={<p className="text-sm text-ink/60">Loading admin...</p>}>
                <AdminWorkspacePage />
              </Suspense>
            )}
            </div>
          </div>

        </section>
      </div>
      <ReferenceImagePickerModal
        isOpen={isEditFrameReferenceImagePickerOpen}
        maxSelected={1}
        selectedIds={[]}
        items={referencePickerItems}
        videoItems={referencePickerVideoItems}
        initialTab="upload"
        generatedScopeDefault="task"
        hasProjectScope={hasEffectiveProjectScope}
        isSaving={isEditFrameReferenceImagePickerSaving}
        onClose={() => setIsEditFrameReferenceImagePickerOpen(false)}
        onUpload={uploadEditVideoReferenceImages}
        onCaptureVideoFrame={captureReferenceFrameFromVideo}
        onConfirm={async (selectedItemIds) => {
          setIsEditFrameReferenceImagePickerSaving(true);
          try {
            await applyEditFramePickerSelection(selectedItemIds);
            setIsEditFrameReferenceImagePickerOpen(false);
          } catch (error) {
            setAppUiError(error instanceof Error ? error.message : "Failed to apply edited frame");
          } finally {
            setIsEditFrameReferenceImagePickerSaving(false);
          }
        }}
      />
      <ReferenceImagePickerModal
        isOpen={isReferenceImagePickerOpen}
        maxSelected={isCharacterAnimateWorkflow ? 1 : editVideoReferenceLimitByModel}
        selectedIds={selectedReferencePickerItemIds}
        items={referencePickerItems}
        videoItems={referencePickerVideoItems}
        initialTab="upload"
        generatedScopeDefault="task"
        hasProjectScope={hasEffectiveProjectScope}
        isSaving={isReferenceImagePickerSaving}
        onClose={() => setIsReferenceImagePickerOpen(false)}
        onUpload={uploadEditVideoReferenceImages}
        onCaptureVideoFrame={captureReferenceFrameFromVideo}
        onConfirm={async (selectedItemIds) => {
          setIsReferenceImagePickerSaving(true);
          try {
            await applyReferencePickerSelection(selectedItemIds);
            setIsReferenceImagePickerOpen(false);
          } catch (error) {
            setAppUiError(error instanceof Error ? error.message : "Failed to update reference images");
          } finally {
            setIsReferenceImagePickerSaving(false);
          }
        }}
      />
      <ReferenceImagePickerModal
        isOpen={isToolReferenceImagePickerOpen}
        maxSelected={9}
        selectedIds={selectedToolReferencePickerItemIds}
        items={referencePickerItems}
        videoItems={referencePickerVideoItems}
        initialTab="generated"
        generatedScopeDefault="current_mode_task"
        hasProjectScope={hasEffectiveProjectScope}
        isSaving={isToolReferenceImagePickerSaving}
        onClose={() => setIsToolReferenceImagePickerOpen(false)}
        onUpload={uploadEditVideoReferenceImages}
        onCaptureVideoFrame={captureReferenceFrameFromVideo}
        onConfirm={async (selectedItemIds) => {
          setIsToolReferenceImagePickerSaving(true);
          try {
            await applyToolReferencePickerSelection(selectedItemIds);
            setIsToolReferenceImagePickerOpen(false);
          } catch (error) {
            setAppUiError(error instanceof Error ? error.message : "Failed to update tool reference images");
          } finally {
            setIsToolReferenceImagePickerSaving(false);
          }
        }}
      />
      <ReferenceImagePickerModal
        isOpen={isPrevizReferenceImagePickerOpen}
        maxSelected={12}
        selectedIds={selectedPrevizReferencePickerItemIds}
        items={referencePickerItems}
        videoItems={referencePickerVideoItems}
        initialTab="upload"
        generatedScopeDefault="task"
        hasProjectScope={hasEffectiveProjectScope}
        isSaving={isPrevizReferenceImagePickerSaving}
        onClose={() => setIsPrevizReferenceImagePickerOpen(false)}
        onUpload={uploadEditVideoReferenceImages}
        onCaptureVideoFrame={captureReferenceFrameFromVideo}
        onConfirm={async (selectedItemIds) => {
          setIsPrevizReferenceImagePickerSaving(true);
          try {
            await applyPrevizReferencePickerSelection(selectedItemIds);
            setIsPrevizReferenceImagePickerOpen(false);
          } catch (error) {
            setAppUiError(error instanceof Error ? error.message : "Failed to update scene references");
          } finally {
            setIsPrevizReferenceImagePickerSaving(false);
          }
        }}
      />
      <ReferenceImagePickerModal
        isOpen={isPrevizToolReferenceImagePickerOpen}
        maxSelected={9}
        selectedIds={selectedPrevizToolReferencePickerItemIds}
        items={referencePickerItems}
        videoItems={referencePickerVideoItems}
        initialTab="generated"
        generatedScopeDefault="current_mode_task"
        hasProjectScope={hasEffectiveProjectScope}
        isSaving={isPrevizToolReferenceImagePickerSaving}
        onClose={() => setIsPrevizToolReferenceImagePickerOpen(false)}
        onUpload={uploadEditVideoReferenceImages}
        onCaptureVideoFrame={captureReferenceFrameFromVideo}
        onConfirm={async (selectedItemIds) => {
          setIsPrevizToolReferenceImagePickerSaving(true);
          try {
            await applyPrevizToolReferencePickerSelection(selectedItemIds);
            setIsPrevizToolReferenceImagePickerOpen(false);
          } catch (error) {
            setAppUiError(error instanceof Error ? error.message : "Failed to update tool reference images");
          } finally {
            setIsPrevizToolReferenceImagePickerSaving(false);
          }
        }}
      />
      <ReferenceImagePickerModal
        isOpen={isPrevizEditReferenceImagePickerOpen}
        maxSelected={12}
        selectedIds={selectedPrevizReferencePickerItemIds}
        items={referencePickerItems}
        videoItems={referencePickerVideoItems}
        initialTab="generated"
        generatedScopeDefault="current_mode_task"
        hasProjectScope={hasEffectiveProjectScope}
        isSaving={isPrevizEditReferenceImagePickerSaving}
        onClose={() => setIsPrevizEditReferenceImagePickerOpen(false)}
        onUpload={uploadEditVideoReferenceImages}
        onCaptureVideoFrame={captureReferenceFrameFromVideo}
        onConfirm={async (selectedItemIds) => {
          setIsPrevizEditReferenceImagePickerSaving(true);
          try {
            await applyPrevizReferencePickerSelection(selectedItemIds);
            setIsPrevizEditReferenceImagePickerOpen(false);
          } catch (error) {
            setAppUiError(error instanceof Error ? error.message : "Failed to update selected references");
          } finally {
            setIsPrevizEditReferenceImagePickerSaving(false);
          }
        }}
      />
      <ReferenceImagePickerModal
        isOpen={isPrevizGenerateReferenceImagePickerOpen}
        maxSelected={12}
        selectedIds={selectedPrevizFramePickerItemIds}
        items={referencePickerItems}
        videoItems={referencePickerVideoItems}
        initialTab="generated"
        generatedScopeDefault="current_mode_task"
        hasProjectScope={hasEffectiveProjectScope}
        isSaving={isPrevizGenerateReferenceImagePickerSaving}
        onClose={() => setIsPrevizGenerateReferenceImagePickerOpen(false)}
        onUpload={uploadEditVideoReferenceImages}
        onCaptureVideoFrame={captureReferenceFrameFromVideo}
        onConfirm={async (selectedItemIds) => {
          setIsPrevizGenerateReferenceImagePickerSaving(true);
          try {
            await applyPrevizFramePickerSelection(selectedItemIds);
            setIsPrevizGenerateReferenceImagePickerOpen(false);
          } catch (error) {
            setAppUiError(error instanceof Error ? error.message : "Failed to update selected images");
          } finally {
            setIsPrevizGenerateReferenceImagePickerSaving(false);
          }
        }}
      />
      <PreviewModals
        imagePreview={imagePreviewModal}
        videoPreview={videoPreviewModal}
        audioPreview={audioPreviewModal}
        imageCompare={imageCompareModal}
        videoCompare={videoCompareModal}
        onCloseImage={() => setImagePreviewModal(null)}
        onCloseVideo={() => setVideoPreviewModal(null)}
        onCloseAudio={() => setAudioPreviewModal(null)}
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
      <>{taskPickerModalNode}{newTaskModalNode}</>
    </main>
  );
}

import { getIdToken } from "../lib/auth";
import { config } from "../lib/config";
import type { JobStatus, SegmentRecord, TaskDetail, TaskSummary } from "../types/api";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getIdToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload as T;
}

export const apiClient = {
  me: () => api<{ userId: string; email?: string; username?: string }>("/me"),
  listTasks: () => api<{ tasks: TaskSummary[] }>("/tasks"),
  createTask: (name: string) => api<{ taskId: string }>("/tasks", { method: "POST", body: JSON.stringify({ name }) }),
  deleteTask: (taskId: string) => api<{ ok: true }>(`/tasks/${taskId}`, { method: "DELETE" }),
  getTask: (taskId: string) => api<TaskDetail>(`/tasks/${taskId}`),
  createVideoUpload: (taskId: string, payload: { filename: string; contentType: string; sizeBytes: number }) =>
    api<{ uploadUrl: string; s3Key: string }>(`/tasks/${taskId}/uploads/video`, { method: "POST", body: JSON.stringify(payload) }),
  ingestTask: (taskId: string) => api<{ jobId: string }>(`/tasks/${taskId}/ingest`, { method: "POST" }),
  thumbnails: (taskId: string) => api<{ manifestUrl: string }>(`/tasks/${taskId}/thumbnails`),
  frameStrip: (taskId: string, startSec: number, endSec: number) =>
    api<{ frames: Array<{ frameIndex: number; timecode: string; thumbUrl: string }> }>(
      `/tasks/${taskId}/frames/strip?startSec=${startSec}&endSec=${endSec}`,
    ),
  createSegment: (taskId: string, payload: { startFrameIndex: number; durationSeconds: number }) =>
    api<{ segmentId: string; resolvedStartFrameIndex: number; resolvedEndFrameIndex: number }>(`/tasks/${taskId}/segments`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchSegment: (
    taskId: string,
    segmentId: string,
    payload: {
      startFrameIndex?: number;
      endFrameExclusive?: number;
      crop?: {
        aspect: "16:9" | "9:16";
        x: number;
        y: number;
        width: number;
        height: number;
        featherPx?: number;
      } | null;
    },
  ) =>
    api<{ ok: true; segment: SegmentRecord }>(`/tasks/${taskId}/segments/${segmentId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteSegment: (taskId: string, segmentId: string) => api<{ ok: true }>(`/tasks/${taskId}/segments/${segmentId}`, { method: "DELETE" }),
  captureFrame: (taskId: string, frameIndex: number) =>
    api<{ frameId: string; imageUrl: string; frameIndex: number; timecode: string }>(`/tasks/${taskId}/frames/capture`, {
      method: "POST",
      body: JSON.stringify({ frameIndex }),
    }),
  createReferenceUploads: (
    taskId: string,
    frameId: string,
    payload: { files: Array<{ filename: string; contentType: string }> },
  ) =>
    api<{ uploads: Array<{ referenceId: string; key: string; uploadUrl: string }> }>(
      `/tasks/${taskId}/frames/${frameId}/references/uploads`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  fullEdit: (
    taskId: string,
    frameId: string,
    payload: { model: "nano_banana" | "nano_banana_pro" | "chatgpt"; prompt: string; sourceVariantId?: string },
  ) =>
    api<{ jobId: string }>(`/tasks/${taskId}/frames/${frameId}/edits/full`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchInit: (
    taskId: string,
    frameId: string,
    payload: {
      patchRect: { x: number; y: number; width: number; height: number };
      featherPx: number;
      bleedPx: number;
      hasMask: boolean;
      sourceVariantId?: string;
    },
  ) =>
    api<{ patchUploadUrl: string; patchKey: string; maskUploadUrl?: string; maskKey?: string; previewUrl?: string }>(
      `/tasks/${taskId}/frames/${frameId}/edits/patch/init`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  patchSubmit: (
    taskId: string,
    frameId: string,
    payload: {
      model: "nano_banana_pro" | "chatgpt" | "runware_flux_fill" | "runware_ace_pp";
      prompt: string;
      patchKey: string;
      maskKey?: string;
      patchRect: { x: number; y: number; width: number; height: number };
      featherPx: number;
      bleedPx: number;
      referenceImageKey?: string;
      runwareRepaintingScale?: number;
      edgeAwareRefine?: boolean;
      edgeAwareStrength?: number;
      edgeAwareRadiusPx?: number;
      maskGrowPx?: number;
      sourceVariantId?: string;
    },
  ) => api<{ jobId: string }>(`/tasks/${taskId}/frames/${frameId}/edits/patch/submit`, { method: "POST", body: JSON.stringify(payload) }),
  initQualityMatchMaskUpload: (
    taskId: string,
    frameId: string,
    payload: { analysisId?: string },
  ) =>
    api<{ analysisId: string; maskKey: string; maskUploadUrl: string }>(
      `/tasks/${taskId}/frames/${frameId}/quality-match/mask-upload`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  analyseQualityMatch: (
    taskId: string,
    frameId: string,
    payload: {
      variantId: string;
      existingAnalysisId?: string;
      maskKey?: string;
      settings?: {
        diffThreshold?: number;
        minRegionAreaPct?: number;
        featherWidthPx?: number;
        boundaryProtectionWidthPx?: number;
        edgeSuppression?: "off" | "low" | "medium" | "high";
        useSeamlessCloneFallback?: boolean;
        autoDetectEditRegion?: boolean;
      };
    },
  ) =>
    api<{
      analysisId: string;
      originalMaskProvided: boolean;
      artifacts: {
        alignedGeneratedUri: string;
        diffHeatmapUri: string;
        binaryChangeMaskUri: string;
        proposedMergeMaskUri: string;
        restorationMapUri: string;
        previewUri: string;
        reportJsonUri: string;
      };
      metrics: {
        changedPctBefore?: number;
        changedPctPreview?: number;
        outsideLeakageBefore?: number;
        outsideLeakagePreview?: number;
        boundarySpillBefore?: number;
        boundarySpillPreview?: number;
        proposedGeneratedCoveragePct?: number;
        proposedOriginalRestorePct?: number;
      };
      warnings: string[];
      settings: {
        diffThreshold: number;
        minRegionAreaPct: number;
        featherWidthPx: number;
        boundaryProtectionWidthPx: number;
        edgeSuppression: "off" | "low" | "medium" | "high";
        useSeamlessCloneFallback: boolean;
        autoDetectEditRegion: boolean;
      };
      alreadyQualityMatched?: boolean;
    }>(`/tasks/${taskId}/frames/${frameId}/quality-match/analyse`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  applyQualityMatch: (
    taskId: string,
    frameId: string,
    payload: {
      analysisId: string;
      finalMaskKey?: string;
      settings?: {
        diffThreshold?: number;
        minRegionAreaPct?: number;
        featherWidthPx?: number;
        boundaryProtectionWidthPx?: number;
        edgeSuppression?: "off" | "low" | "medium" | "high";
        useSeamlessCloneFallback?: boolean;
        autoDetectEditRegion?: boolean;
      };
      overwriteGeneratedFrame?: boolean;
    },
  ) =>
    api<{
      frameId: string;
      replacedFrameUri: string;
      qcReviewed: boolean;
      qualityMatched: boolean;
      reportJsonUri: string;
      metrics: {
        changedPctBefore?: number;
        changedPctAfter?: number;
        outsideLeakageBefore?: number;
        outsideLeakageAfter?: number;
        boundarySpillBefore?: number;
        boundarySpillAfter?: number;
      };
      artifacts?: {
        finalUri?: string;
        previewUri?: string;
        maskUri?: string;
      };
    }>(`/tasks/${taskId}/frames/${frameId}/quality-match/apply`, { method: "POST", body: JSON.stringify(payload) }),
  selectVariant: (taskId: string, frameId: string, variantId: string) =>
    api<{ ok: true }>(`/tasks/${taskId}/frames/${frameId}/variants/${variantId}/select`, { method: "POST", body: "{}" }),
  generateSegment: (
    taskId: string,
    segmentId: string,
    payload: {
      lumaModel:
        | "ray-2"
        | "ray-flash-2"
        | "runway-gen4.5"
        | "kling-2.6"
        | "veo-3.1"
        | "veo-3.1-fast"
        | "wan2.2-a14b"
        | "wan2.2-animate";
      mode: string;
      prompt?: string;
      firstFrameVariantId?: string;
      lastFrameVariantId?: string;
    },
  ) => api<{ jobId: string }>(`/tasks/${taskId}/segments/${segmentId}/generate`, { method: "POST", body: JSON.stringify(payload) }),
  merge: (
    taskId: string,
    payload: {
      selectedSegmentGenerationIds: string[];
      temporalFeatherFrames: number;
      generationAdjustments?: Record<
        string,
        {
          startFrameOverride?: number;
          trimStartFrames?: number;
          trimEndFrames?: number;
        }
      >;
    },
  ) =>
    api<{ jobId: string }>(`/tasks/${taskId}/merge`, { method: "POST", body: JSON.stringify(payload) }),
  runMotionSyncQc: (taskId: string, exportId: string, payload?: { force?: boolean }) =>
    api<{ jobId: string; alreadyRunning?: boolean }>(`/tasks/${taskId}/exports/${exportId}/motion-qc`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  runQc: (taskId: string, payload?: { generationIds?: string[]; mode?: "standard" | "advanced_frame" }) =>
    api<{ jobId: string; generationCount: number }>(`/tasks/${taskId}/qc/run`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  deleteAsset: (
    taskId: string,
    payload: {
      assetType: "upload" | "frame_capture" | "frame_variant" | "segment_generation" | "export";
      frameId?: string;
      variantId?: string;
      genId?: string;
      exportId?: string;
    },
  ) => api<{ ok: true }>(`/tasks/${taskId}/assets`, { method: "DELETE", body: JSON.stringify(payload) }),
  createCustomReport: (
    taskId: string,
    payload: {
      reportType: "qc_frame" | "qc_video";
      tests: string[];
      outputRefs: Array<
        | { assetType: "frame_variant"; frameId: string; variantId: string }
        | { assetType: "segment_generation"; genId: string }
      >;
      name?: string;
    },
  ) => api<{ reportId: string }>(`/tasks/${taskId}/reports`, { method: "POST", body: JSON.stringify(payload) }),
  getCustomReport: (taskId: string, reportId: string) =>
    api<{ report: import("../types/api").CustomReportRecord; result?: import("../types/api").QcReportResult }>(
      `/tasks/${taskId}/reports/${reportId}`,
    ),
  deleteCustomReport: (taskId: string, reportId: string) =>
    api<{ ok: true }>(`/tasks/${taskId}/reports/${reportId}`, { method: "DELETE" }),
  getJob: (jobId: string) => api<JobStatus>(`/jobs/${jobId}`),
};

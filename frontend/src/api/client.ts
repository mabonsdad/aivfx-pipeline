import { getIdToken } from "../lib/auth";
import { config } from "../lib/config";
import { DEFAULT_TASK_WORKFLOW_ID, type TaskWorkflowId } from "../lib/taskWorkflows";
import type {
  PromptWizardAdminConfig,
  PromptWizardRequest,
  PromptWizardResult,
} from "../lib/promptWizardConfig";
import type { PricingAdminConfig } from "../lib/pricingConfig";
import type {
  ApiAssetUploadInitPayload,
  ApiImageEditFullPayload,
  ApiImageEditPatchPayload,
  ApiReferenceVideoGeneratePayload,
  AssetDeletePayload,
  ChunkedSegmentGeneratePayload,
  CustomReportCreatePayload,
  ExportTopazUpscalePayload,
  MergePayload,
  ManualRefineExportFormatId,
  QcEdgeBiasId,
  QcEdgeSuppressionId,
  QcSamPromptTypeId,
  SegmentGenerationLengthenPayload,
  ReconcileTimingPayload,
  SegmentGenerationExtendPayload,
  SegmentGeneratePayload,
} from "../lib/generated/apiContracts";
import type {
  FullEditModelId,
  PatchEditModelId,
  ReplicateKlingModeId,
  ReplicateKlingV3ModeId,
  Sora2ResolutionId,
  VideoModeId,
  VideoModelId,
  Wan27ResolutionId,
  HappyHorseResolutionId,
} from "../lib/generated/videoContracts";
import type {
  AdminUserSummary,
  ApiRequestRecord,
  CurrentUserInfo,
  JobStatus,
  ProjectSummary,
  SegmentRecord,
  TaskDetail,
  TaskSummary,
  VideoCleanupTrack,
  VideoCleanupSettings,
} from "../types/api";

type ApiFullEditPayload = Omit<ApiImageEditFullPayload, "model"> & { model: FullEditModelId };
type ApiPatchEditPayload = Omit<ApiImageEditPatchPayload, "model"> & { model: PatchEditModelId };
type ApiReferenceVideoPayload = Omit<ApiReferenceVideoGeneratePayload, "model" | "mode"> & {
  model: VideoModelId;
  mode: VideoModeId;
  replicateKlingMode?: ReplicateKlingModeId | null;
  replicateKlingV3Mode?: ReplicateKlingV3ModeId | null;
  wan27Resolution?: Wan27ResolutionId | null;
  sora2Resolution?: Sora2ResolutionId | null;
  happyHorseResolution?: HappyHorseResolutionId | null;
};
type SegmentGenerateApiPayload = Omit<SegmentGeneratePayload, "lumaModel" | "mode"> & {
  lumaModel: VideoModelId;
  mode: VideoModeId;
  replicateKlingMode?: ReplicateKlingModeId | null;
  replicateKlingV3Mode?: ReplicateKlingV3ModeId | null;
  wan27Resolution?: Wan27ResolutionId | null;
  sora2Resolution?: Sora2ResolutionId | null;
  happyHorseResolution?: HappyHorseResolutionId | null;
};
type ChunkedSegmentGenerateApiPayload = Omit<ChunkedSegmentGeneratePayload, "lumaModel" | "mode"> & {
  lumaModel: VideoModelId;
  mode: VideoModeId;
  replicateKlingMode?: ReplicateKlingModeId | null;
  replicateKlingV3Mode?: ReplicateKlingV3ModeId | null;
  wan27Resolution?: Wan27ResolutionId | null;
};
type SegmentPromptWizardApiPayload = PromptWizardRequest;
type CharacterAnimateGenerateApiPayload = {
  mode: "pose_video" | "audio_driven";
  model: "runway_act_two" | "kling_v3_motion_control" | "seedance_2_0_reference_to_video" | "omnihuman_v1_5";
  characterReferenceId: string;
  prompt?: string | null;
  outputAspectRatio?: "1280:720" | "720:1280" | "960:960" | "1104:832" | "832:1104" | "1584:672" | null;
  bodyControl?: boolean;
  expressionIntensity?: number;
  omnihumanResolution?: "720p" | "1080p" | null;
  klingMode?: "std" | "pro" | null;
  klingCharacterOrientation?: "image" | "video" | null;
  seedanceResolution?: "480p" | "720p" | "1080p" | null;
  seedanceAspectRatio?: "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | null;
};
type PrevizGenerateApiPayload = {
  model: "veo_3_1" | "happy_horse_1_0" | "seedance_2_0";
  prompt: string;
  durationSec: number;
  sceneAspectRatio?: string | null;
  selectedFrameIds: string[];
};

function extractApiErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const errorValue = (payload as { error?: unknown }).error;
    if (typeof errorValue === "string" && errorValue) {
      return errorValue;
    }
    if (errorValue && typeof errorValue === "object") {
      const message = (errorValue as { message?: unknown }).message;
      if (typeof message === "string" && message) {
        return message;
      }
    }
  }
  return fallback;
}

export class ApiError extends Error {
  status: number;
  path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

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
    throw new ApiError(
      extractApiErrorMessage(payload, `Request failed: ${response.status}`),
      response.status,
      path,
    );
  }
  return payload as T;
}

export const apiClient = {
  me: () => api<CurrentUserInfo>("/me"),
  getPromptWizardAdminConfig: (pin?: string) =>
    api<{
      config: PromptWizardAdminConfig;
      access: { isAdmin: boolean; viaPin: boolean };
    }>("/admin/prompt-wizard-config", {
      method: "GET",
      headers: pin ? { "x-admin-pin": pin } : undefined,
    }),
  updatePromptWizardAdminConfig: (payload: PromptWizardAdminConfig, pin?: string) =>
    api<{
      config: PromptWizardAdminConfig;
      access: { isAdmin: boolean; viaPin: boolean };
    }>("/admin/prompt-wizard-config", {
      method: "PUT",
      headers: pin ? { "x-admin-pin": pin } : undefined,
      body: JSON.stringify(payload),
    }),
  getPricingAdminConfig: (pin?: string) =>
    api<{
      config: PricingAdminConfig;
      access: { isAdmin: boolean; viaPin: boolean };
    }>("/admin/pricing-config", {
      method: "GET",
      headers: pin ? { "x-admin-pin": pin } : undefined,
    }),
  updatePricingAdminConfig: (payload: PricingAdminConfig, pin?: string) =>
    api<{
      config: PricingAdminConfig;
      access: { isAdmin: boolean; viaPin: boolean };
    }>("/admin/pricing-config", {
      method: "PUT",
      headers: pin ? { "x-admin-pin": pin } : undefined,
      body: JSON.stringify(payload),
    }),
  listAdminProjects: () => api<{ projects: ProjectSummary[] }>("/admin/projects"),
  createAdminProject: (payload: { name: string; description?: string | null; memberUserIds: string[] }) =>
    api<{ project: ProjectSummary }>("/admin/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateAdminProject: (projectId: string, payload: { name: string; description?: string | null; memberUserIds: string[] }) =>
    api<{ project: ProjectSummary }>(`/admin/projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  listAdminUsers: () =>
    api<{
      users: AdminUserSummary[];
      projects: ProjectSummary[];
    }>("/admin/users"),
  listTasks: (params?: { scope?: "mine" | "all" | "project"; projectId?: string | null }) => {
    const search = new URLSearchParams();
    if (params?.scope && params.scope !== "mine") search.set("scope", params.scope);
    if (params?.projectId) search.set("projectId", params.projectId);
    const query = search.toString();
    return api<{ tasks: TaskSummary[] }>(`/tasks${query ? `?${query}` : ""}`);
  },
  createTask: (
    name: string,
    workflowId: TaskWorkflowId = DEFAULT_TASK_WORKFLOW_ID,
    options?: { scenePrompt?: string | null },
  ) =>
    api<{ taskId: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ name, workflowId, scenePrompt: options?.scenePrompt ?? null }),
    }),
  setTaskProject: (taskId: string, payload: { projectId?: string | null }) =>
    api<{ taskId: string; projectId?: string | null; projectName?: string | null }>(`/tasks/${taskId}/project`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteTask: (taskId: string) => api<{ ok: true }>(`/tasks/${taskId}`, { method: "DELETE" }),
  getTask: (taskId: string, params?: { scope?: "mine" | "all" | "project"; projectId?: string | null }) => {
    const search = new URLSearchParams();
    if (params?.scope && params.scope !== "mine") search.set("scope", params.scope);
    if (params?.projectId) search.set("projectId", params.projectId);
    const query = search.toString();
    return api<TaskDetail>(`/tasks/${taskId}${query ? `?${query}` : ""}`);
  },
  updatePrevizTask: (
    taskId: string,
    payload: {
      scenePrompt?: string | null;
      sceneAspectRatio?: string | null;
      selectedReferenceIds?: string[];
      frameReferenceIds?: string[];
      selectedFrameIds?: string[];
    },
  ) =>
    api<{
      previz: NonNullable<TaskDetail["previz"]>;
    }>(`/tasks/${taskId}/previz`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  generatePrevizVideo: (taskId: string, segmentId: string, payload: PrevizGenerateApiPayload) =>
    api<{ jobId: string; genId: string }>(`/tasks/${taskId}/segments/${segmentId}/previz-generate`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createVideoUpload: (taskId: string, payload: { filename: string; contentType: string; sizeBytes: number }) =>
    api<{ uploadUrl: string; s3Key: string }>(`/tasks/${taskId}/uploads/video`, { method: "POST", body: JSON.stringify(payload) }),
  initGenerationAudioReferenceUpload: (taskId: string, payload: { filename: string; contentType: string; sizeBytes?: number }) =>
    api<{ referenceId: string; key: string; uploadUrl: string }>(`/tasks/${taskId}/generation-audio-reference/upload/init`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  completeGenerationAudioReferenceUpload: (
    taskId: string,
    payload: { referenceId: string; uploadKey: string; filename: string },
  ) =>
    api<{
      reference: {
        referenceId: string;
        filename: string;
        originalKey: string;
        editSourceKey: string;
        previewKey: string;
        waveformKey: string;
        waveformWidth?: number;
        waveformHeight?: number;
        durationSec?: number;
        sampleRate?: number;
        channels?: number;
        codec?: string;
        bitRate?: number;
        createdAt: string;
        updatedAt?: string;
        originalUrl?: string;
        editSourceUrl?: string;
        previewUrl?: string;
        waveformUrl?: string;
      };
    }>(`/tasks/${taskId}/generation-audio-reference/upload/complete`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createExternalQcPairUpload: (
    taskId: string,
    payload: {
      originalFilename: string;
      originalContentType: string;
      editedFilename: string;
      editedContentType: string;
    },
  ) =>
    api<{
      pairId: string;
      originalUploadUrl: string;
      editedUploadUrl: string;
      pair: {
        pairId: string;
        originalKey: string;
        editedKey: string;
        originalFilename?: string;
        editedFilename?: string;
        originalUrl?: string;
        editedUrl?: string;
        createdAt: string;
        updatedAt: string;
      };
    }>(`/tasks/${taskId}/external-qc/pairs/uploads`, { method: "POST", body: JSON.stringify(payload) }),
  ingestTask: (taskId: string) => api<{ jobId: string }>(`/tasks/${taskId}/ingest`, { method: "POST" }),
  thumbnails: (taskId: string) => api<{ manifestUrl: string }>(`/tasks/${taskId}/thumbnails`),
  frameStrip: (taskId: string, startSec: number, endSec: number) =>
    api<{ frames: Array<{ frameIndex: number; timecode: string; thumbUrl: string }> }>(
      `/tasks/${taskId}/frames/strip?startSec=${startSec}&endSec=${endSec}`,
    ),
  createSegment: (taskId: string, payload: { startFrameIndex: number; durationSeconds?: number; endFrameExclusive?: number }) =>
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
    api<{ frameId: string; captureKey: string; imageUrl: string; frameIndex: number; timecode: string }>(`/tasks/${taskId}/frames/capture`, {
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
    payload: {
      model: FullEditModelId;
      prompt: string;
      sourceVariantId?: string;
    },
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
      model: PatchEditModelId;
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
  initApiAssetUpload: (payload: ApiAssetUploadInitPayload) =>
    api<{ assetId: string; assetKey: string; uploadUrl: string }>(`/api/v1/assets/uploads/init`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listApiRequests: (params?: { status?: string; workflow?: string; model?: string; limit?: number; scope?: "mine" | "all" }) => {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.workflow) search.set("workflow", params.workflow);
    if (params?.model) search.set("model", params.model);
    if (typeof params?.limit === "number") search.set("limit", String(params.limit));
    if (params?.scope && params.scope !== "mine") search.set("scope", params.scope);
    const query = search.toString();
    return api<{ requests: ApiRequestRecord[] }>(`/api/v1/requests${query ? `?${query}` : ""}`);
  },
  getApiRequest: (requestId: string, params?: { scope?: "mine" | "all" }) => {
    const search = new URLSearchParams();
    if (params?.scope && params.scope !== "mine") search.set("scope", params.scope);
    const query = search.toString();
    return api<ApiRequestRecord>(`/api/v1/requests/${requestId}${query ? `?${query}` : ""}`);
  },
  apiFullEdit: (payload: ApiFullEditPayload) =>
    api<{ requestId: string; jobId: string }>(`/api/v1/image-edits/full`, { method: "POST", body: JSON.stringify(payload) }),
  apiPatchEdit: (payload: ApiPatchEditPayload) =>
    api<{ requestId: string; jobId: string }>(`/api/v1/image-edits/patch`, { method: "POST", body: JSON.stringify(payload) }),
  apiReferenceVideoGenerate: (payload: ApiReferenceVideoPayload) =>
    api<{ requestId: string; jobId: string }>(`/api/v1/video-generations/reference-video`, { method: "POST", body: JSON.stringify(payload) }),
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
        edgeSuppression?: QcEdgeSuppressionId;
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
        originalMaskUri?: string | null;
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
        edgeSuppression: QcEdgeSuppressionId;
        useSeamlessCloneFallback: boolean;
        autoDetectEditRegion: boolean;
      };
      alreadyQualityMatched?: boolean;
    }>(`/tasks/${taskId}/frames/${frameId}/quality-match/analyse`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  previewQualityMatch: (
    taskId: string,
    frameId: string,
    payload: {
      analysisId: string;
      maskKey: string;
      settings?: {
        diffThreshold?: number;
        minRegionAreaPct?: number;
        featherWidthPx?: number;
        boundaryProtectionWidthPx?: number;
        edgeSuppression?: QcEdgeSuppressionId;
        useSeamlessCloneFallback?: boolean;
        autoDetectEditRegion?: boolean;
      };
    },
  ) =>
    api<{
      analysisId: string;
      artifacts: {
        previewUri: string;
      };
      metrics: {
        changedPctPreview?: number;
        outsideLeakagePreview?: number;
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
        edgeSuppression: QcEdgeSuppressionId;
        useSeamlessCloneFallback: boolean;
        autoDetectEditRegion: boolean;
      };
    }>(`/tasks/${taskId}/frames/${frameId}/quality-match/preview`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  exportManualRefinePsd: (
    taskId: string,
    frameId: string,
    payload: { sourceVariantId: string; format?: ManualRefineExportFormatId },
  ) =>
    api<{
      downloadUrl: string;
      filename: string;
      exportMeta: {
        width: number;
        height: number;
        changedPixelPct: number;
        includedLayers: string[];
      };
    }>(`/tasks/${taskId}/frames/${frameId}/manual-refine/export`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  initManualRefineUpload: (
    taskId: string,
    frameId: string,
    payload: { sourceVariantId: string; filename: string; contentType: string },
  ) =>
    api<{ uploadKey: string; uploadUrl: string }>(`/tasks/${taskId}/frames/${frameId}/manual-refine/upload/init`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  completeManualRefineUpload: (
    taskId: string,
    frameId: string,
    payload: { sourceVariantId: string; uploadKey: string; filename: string },
  ) =>
    api<{ variant: { variantId: string; imageUrl?: string } }>(`/tasks/${taskId}/frames/${frameId}/manual-refine/upload/complete`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  initManualFrameUpload: (
    taskId: string,
    frameId: string,
    payload: { filename: string; contentType: string },
  ) =>
    api<{ uploadKey: string; uploadUrl: string }>(`/tasks/${taskId}/frames/${frameId}/manual-upload/upload/init`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  completeManualFrameUpload: (
    taskId: string,
    frameId: string,
    payload: { uploadKey: string; filename: string },
  ) =>
    api<{ variant: { variantId: string; imageUrl?: string } }>(`/tasks/${taskId}/frames/${frameId}/manual-upload/upload/complete`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  importManualFrameVariant: (
    taskId: string,
    frameId: string,
    payload: {
      sources: Array<{
        sourceKey: string;
        filename?: string | null;
        sourceType: "uploaded" | "generated" | "frame_capture" | "frame_variant";
        originTaskId?: string | null;
      }>;
    },
  ) =>
    api<{ variant: { variantId: string; imageUrl?: string } }>(`/tasks/${taskId}/frames/${frameId}/manual-upload/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  initManualSegmentGenerationUpload: (
    taskId: string,
    segmentId: string,
    payload: { filename: string; contentType: string },
  ) =>
    api<{ uploadKey: string; uploadUrl: string }>(`/tasks/${taskId}/segments/${segmentId}/manual-generation/upload/init`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  completeManualSegmentGenerationUpload: (
    taskId: string,
    segmentId: string,
    payload: {
      uploadKey: string;
      filename: string;
      model: string;
      mode: string;
      inputMode?: "start_video" | "start_end" | "start_only" | "edit_video" | null;
      prompt?: string | null;
      negativePrompt?: string | null;
      firstFrameVariantId?: string | null;
      lastFrameVariantId?: string | null;
    },
  ) =>
    api<{ generation: { genId: string } }>(`/tasks/${taskId}/segments/${segmentId}/manual-generation/upload/complete`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  initEditVideoReferenceUpload: (
    taskId: string,
    payload: { filename: string; contentType: string },
  ) =>
    api<{ referenceId: string; key: string; uploadUrl: string }>(`/tasks/${taskId}/edit-video/references/upload/init`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  completeEditVideoReferenceUpload: (
    taskId: string,
    payload: { referenceId: string; uploadKey: string; filename: string },
  ) =>
    api<{ reference: import("../types/api").EditVideoReference }>(`/tasks/${taskId}/edit-video/references/upload/complete`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  importEditVideoReferences: (
    taskId: string,
    payload: {
      sources: Array<{
        sourceKey: string;
        filename?: string | null;
        sourceType: "uploaded" | "generated" | "frame_capture" | "frame_variant";
        originTaskId?: string | null;
      }>;
    },
  ) =>
    api<{ references: import("../types/api").EditVideoReference[] }>(`/tasks/${taskId}/edit-video/references/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  generateEditVideoReference: (
    taskId: string,
    payload: {
      model: "chatgpt" | "chatgpt_latest" | "nano_banana" | "nano_banana_pro" | "luma_uni_1" | "luma_uni_1_max";
      prompt: string;
      aspectRatio?: string | null;
      selectedReferenceIds?: string[];
    },
  ) =>
    api<{ reference: import("../types/api").EditVideoReference; jobId?: string }>(`/tasks/${taskId}/edit-video/references/generate`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  improveSegmentPrompt: (
    taskId: string,
    segmentId: string,
    payload: SegmentPromptWizardApiPayload,
  ) =>
    api<{ result: PromptWizardResult }>(`/tasks/${taskId}/segments/${segmentId}/prompt-wizard`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  segmentQualityMatchSam: (
    taskId: string,
    frameId: string,
    payload: {
      variantId: string;
      analysisId?: string;
      promptType: QcSamPromptTypeId;
      positivePoints?: Array<{ x: number; y: number }>;
      negativePoints?: Array<{ x: number; y: number }>;
      box?: { x: number; y: number; w: number; h: number };
      restrictToMaskBounds?: boolean;
      existingMaskKey?: string;
      edgeBias?: QcEdgeBiasId;
    },
  ) =>
    api<{ jobId: string; analysisId: string }>(`/tasks/${taskId}/frames/${frameId}/quality-match/sam`, {
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
        edgeSuppression?: QcEdgeSuppressionId;
        useSeamlessCloneFallback?: boolean;
        autoDetectEditRegion?: boolean;
      };
      overwriteGeneratedFrame?: boolean;
    },
  ) =>
    api<{ jobId: string }>(`/tasks/${taskId}/frames/${frameId}/quality-match/apply`, { method: "POST", body: JSON.stringify(payload) }),
  createVideoCleanupTrack: (
    taskId: string,
    segmentId: string,
    generationId: string,
    payload: {
      firstMaskSource: {
        type: "quality_match_analysis";
        analysisId: string;
      };
      settings?: Partial<VideoCleanupSettings>;
    },
  ) =>
    api<{ trackId: string; jobId: string }>(`/tasks/${taskId}/segments/${segmentId}/generations/${generationId}/cleanup-tracks`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getVideoCleanupTrack: (taskId: string, trackId: string) =>
    api<{ track: VideoCleanupTrack }>(`/tasks/${taskId}/cleanup-tracks/${trackId}`),
  deleteVideoCleanupTrack: (taskId: string, trackId: string) =>
    api<{ ok: true }>(`/tasks/${taskId}/cleanup-tracks/${trackId}`, { method: "DELETE" }),
  initVideoCleanupKeyframeUpload: (
    taskId: string,
    trackId: string,
    payload: { frameIndexLocal: number; filename: string; contentType: string },
  ) =>
    api<{ uploadKey: string; uploadUrl: string }>(`/tasks/${taskId}/cleanup-tracks/${trackId}/keyframes/upload-init`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  completeVideoCleanupKeyframeUpload: (
    taskId: string,
    trackId: string,
    payload: {
      frameIndexLocal: number;
      uploadKey: string;
      propagationMode?: "windowed" | "forward" | "backward" | "bidirectional";
    },
  ) =>
    api<{ jobId: string; keyframeId: string }>(`/tasks/${taskId}/cleanup-tracks/${trackId}/keyframes/complete`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  samAssistVideoCleanupTrack: (
    taskId: string,
    trackId: string,
    payload: {
      frameIndexLocal: number;
      positivePoints?: Array<{ x: number; y: number }>;
      negativePoints?: Array<{ x: number; y: number }>;
      box?: { x: number; y: number; width: number; height: number };
      existingMaskKey?: string;
      restrictToMaskBounds?: boolean;
      edgeBias?: QcEdgeBiasId;
      propagationMode?: "windowed" | "forward" | "backward" | "bidirectional";
    },
  ) =>
    api<{ jobId: string }>(`/tasks/${taskId}/cleanup-tracks/${trackId}/sam-assist`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  previewVideoCleanupTrack: (
    taskId: string,
    trackId: string,
    payload: { settings?: Partial<VideoCleanupSettings> },
  ) =>
    api<{ jobId: string }>(`/tasks/${taskId}/cleanup-tracks/${trackId}/preview`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  applyVideoCleanupTrack: (
    taskId: string,
    trackId: string,
    payload: { settings?: Partial<VideoCleanupSettings>; createSegmentGenerationVariant?: boolean },
  ) =>
    api<{ jobId: string }>(`/tasks/${taskId}/cleanup-tracks/${trackId}/apply`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  selectVariant: (taskId: string, frameId: string, variantId: string) =>
    api<{ ok: true }>(`/tasks/${taskId}/frames/${frameId}/variants/${variantId}/select`, { method: "POST", body: "{}" }),
  generateSegment: (taskId: string, segmentId: string, payload: SegmentGenerateApiPayload) =>
    api<{ jobId: string; genId: string }>(`/tasks/${taskId}/segments/${segmentId}/generate`, { method: "POST", body: JSON.stringify(payload) }),
  generateCharacterAnimation: (taskId: string, segmentId: string, payload: CharacterAnimateGenerateApiPayload) =>
    api<{ jobId: string; genId: string }>(`/tasks/${taskId}/segments/${segmentId}/character-generate`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  generateSegmentChunked: (taskId: string, segmentId: string, payload: ChunkedSegmentGenerateApiPayload) =>
    api<{ runId: string; jobId?: string; genId?: string; chunkCount: number; chunkDurationSec: number; minimumOverlapFrames: number }>(
      `/tasks/${taskId}/segments/${segmentId}/chunked-generate`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  pauseChunkedGeneration: (taskId: string, runId: string, payload?: { reason?: string }) =>
    api<{ ok: true }>(`/tasks/${taskId}/chunked-generations/${runId}/pause`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  resumeChunkedGeneration: (taskId: string, runId: string) =>
    api<{ ok: true; jobId?: string | null }>(`/tasks/${taskId}/chunked-generations/${runId}/resume`, {
      method: "POST",
      body: "{}",
    }),
  restartChunkedGeneration: (taskId: string, runId: string, payload: { fromChunkIndex: number; prompt?: string }) =>
    api<{ ok: true; jobId?: string | null; genId?: string | null }>(`/tasks/${taskId}/chunked-generations/${runId}/restart`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  saveChunkedGenerationDraft: (taskId: string, runId: string) =>
    api<{ ok: true; jobId?: string | null }>(`/tasks/${taskId}/chunked-generations/${runId}/save-draft`, {
      method: "POST",
      body: "{}",
    }),
  cancelChunkedGeneration: (taskId: string, runId: string, payload?: { reason?: string }) =>
    api<{ ok: true }>(`/tasks/${taskId}/chunked-generations/${runId}/cancel`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  extendSegmentGeneration: (
    taskId: string,
    genId: string,
    payload: SegmentGenerationExtendPayload,
  ) =>
    api<{
      jobId: string;
      genId: string;
      segmentId: string;
      anchorVariantId: string;
      alignmentFrameIndex: number;
      sourceGeneratedFrameIndex: number;
    }>(`/tasks/${taskId}/segment-generations/${genId}/extend`, { method: "POST", body: JSON.stringify(payload) }),
  lengthenSegmentGeneration: (
    taskId: string,
    genId: string,
    payload: SegmentGenerationLengthenPayload,
  ) =>
    api<{
      jobId: string;
      genId: string;
      segmentId: string;
      model: string;
      direction: "start" | "end";
    }>(`/tasks/${taskId}/segment-generations/${genId}/lengthen`, { method: "POST", body: JSON.stringify(payload) }),
  merge: (
    taskId: string,
    payload: MergePayload,
  ) =>
    api<{ jobId: string }>(`/tasks/${taskId}/merge`, { method: "POST", body: JSON.stringify(payload) }),
  suggestMergeAlignment: (taskId: string, genId: string) =>
    api<{ jobId: string; alreadyRunning?: boolean }>(`/tasks/${taskId}/segment-generations/${genId}/merge-alignment-suggestion`, {
      method: "POST",
      body: "{}",
    }),
  reconcileSegmentGenerationTiming: (
    taskId: string,
    genId: string,
    payload: ReconcileTimingPayload,
  ) =>
    api<{ jobId: string; genId: string; alreadyRunning?: boolean }>(`/tasks/${taskId}/segment-generations/${genId}/reconcile-timing`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  runMotionSyncQc: (taskId: string, exportId: string, payload?: { force?: boolean }) =>
    api<{ jobId: string; alreadyRunning?: boolean }>(`/tasks/${taskId}/exports/${exportId}/motion-qc`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  runTopazUpscale: (taskId: string, exportId: string, payload?: ExportTopazUpscalePayload) =>
    api<{ jobId: string; exportId?: string; alreadyRunning?: boolean }>(`/tasks/${taskId}/exports/${exportId}/topaz-upscale`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  runTopazUpscaleForGeneration: (taskId: string, genId: string, payload?: ExportTopazUpscalePayload) =>
    api<{ jobId: string; exportId?: string; sourceExportId?: string; generationId?: string; alreadyRunning?: boolean }>(
      `/tasks/${taskId}/segment-generations/${genId}/topaz-upscale`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      },
    ),
  deleteAsset: (
    taskId: string,
    payload: AssetDeletePayload,
  ) => api<{ ok: true }>(`/tasks/${taskId}/assets`, { method: "DELETE", body: JSON.stringify(payload) }),
  createCustomReport: (
    taskId: string,
    payload: CustomReportCreatePayload,
  ) => api<{ reportId: string }>(`/tasks/${taskId}/reports`, { method: "POST", body: JSON.stringify(payload) }),
  getCustomReport: (taskId: string, reportId: string) =>
    api<{ report: import("../types/api").CustomReportRecord; result?: import("../types/api").QcReportResult }>(
      `/tasks/${taskId}/reports/${reportId}`,
    ),
  deleteCustomReport: (taskId: string, reportId: string) =>
    api<{ ok: true }>(`/tasks/${taskId}/reports/${reportId}`, { method: "DELETE" }),
  getJob: (jobId: string) => api<JobStatus>(`/jobs/${jobId}`),
  cancelJob: (jobId: string, payload?: { reason?: string }) =>
    api<{ ok: true; jobId: string; status?: string; cancelRequestedAt?: string; alreadyRequested?: boolean; alreadyTerminal?: boolean }>(
      `/jobs/${jobId}/cancel`,
      { method: "POST", body: JSON.stringify(payload ?? {}) },
    ),
};

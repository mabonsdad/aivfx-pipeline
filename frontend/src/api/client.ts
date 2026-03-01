import { getIdToken } from "../lib/auth";
import { config } from "../lib/config";
import type { JobStatus, TaskDetail, TaskSummary } from "../types/api";

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
  patchSegment: (taskId: string, segmentId: string, payload: { startFrameIndex?: number; endFrameExclusive?: number }) =>
    api<{ ok: true }>(`/tasks/${taskId}/segments/${segmentId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteSegment: (taskId: string, segmentId: string) => api<{ ok: true }>(`/tasks/${taskId}/segments/${segmentId}`, { method: "DELETE" }),
  captureFrame: (taskId: string, frameIndex: number) =>
    api<{ frameId: string; imageUrl: string; frameIndex: number; timecode: string }>(`/tasks/${taskId}/frames/capture`, {
      method: "POST",
      body: JSON.stringify({ frameIndex }),
    }),
  fullEdit: (taskId: string, frameId: string, payload: { model: "nano_banana" | "nano_banana_pro"; prompt: string }) =>
    api<{ jobId: string }>(`/tasks/${taskId}/frames/${frameId}/edits/full`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchInit: (
    taskId: string,
    frameId: string,
    payload: { patchRect: { x: number; y: number; width: number; height: number }; featherPx: number; bleedPx: number; hasMask: boolean },
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
      model: "nano_banana" | "nano_banana_pro";
      prompt: string;
      patchKey: string;
      maskKey?: string;
      patchRect: { x: number; y: number; width: number; height: number };
      featherPx: number;
      bleedPx: number;
    },
  ) => api<{ jobId: string }>(`/tasks/${taskId}/frames/${frameId}/edits/patch/submit`, { method: "POST", body: JSON.stringify(payload) }),
  selectVariant: (taskId: string, frameId: string, variantId: string) =>
    api<{ ok: true }>(`/tasks/${taskId}/frames/${frameId}/variants/${variantId}/select`, { method: "POST", body: "{}" }),
  generateSegment: (
    taskId: string,
    segmentId: string,
    payload: { lumaModel: "ray-2" | "ray-flash-2"; mode: string; prompt?: string; firstFrameVariantId?: string },
  ) => api<{ jobId: string }>(`/tasks/${taskId}/segments/${segmentId}/generate`, { method: "POST", body: JSON.stringify(payload) }),
  merge: (taskId: string, payload: { selectedSegmentGenerationIds: string[]; temporalFeatherFrames: number }) =>
    api<{ jobId: string }>(`/tasks/${taskId}/merge`, { method: "POST", body: JSON.stringify(payload) }),
  getJob: (jobId: string) => api<JobStatus>(`/jobs/${jobId}`),
};

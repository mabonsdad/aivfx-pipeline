import { getFixedCharacterAnimateModeForWorkflow, isCharacterAnimateWorkflowId, isPrevizWorkflowId, type TaskWorkflowId } from "./taskWorkflows";

export const MAX_SOURCE_VIDEO_DURATION_SECONDS = 120;
export const MAX_CHARACTER_AUDIO_DURATION_SECONDS = 600;

export function normalizeTaskNameInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 15);
}

export function uploadFileWithProgress(
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

export function readLocalVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      URL.revokeObjectURL(objectUrl);
    };
    const handleLoaded = () => {
      const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : NaN;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("Could not read video duration"));
        return;
      }
      resolve(duration);
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not read video metadata"));
    };
    video.preload = "metadata";
    video.src = objectUrl;
    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
  });
}

export function readLocalAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", handleLoaded);
      audio.removeEventListener("error", handleError);
      URL.revokeObjectURL(objectUrl);
    };
    const handleLoaded = () => {
      const duration = Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : NaN;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("Could not read audio duration"));
        return;
      }
      resolve(duration);
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not read audio metadata"));
    };
    audio.preload = "metadata";
    audio.src = objectUrl;
    audio.addEventListener("loadedmetadata", handleLoaded);
    audio.addEventListener("error", handleError);
  });
}

export function sourceMediaLabelForWorkflow(workflowId: TaskWorkflowId): "audio" | "video" | null {
  if (isPrevizWorkflowId(workflowId)) return null;
  return getFixedCharacterAnimateModeForWorkflow(workflowId) === "audio_driven" ? "audio" : "video";
}

export async function validateSourceMediaFile(workflowId: TaskWorkflowId, file: File): Promise<void> {
  const sourceKind = sourceMediaLabelForWorkflow(workflowId);
  if (!sourceKind) {
    throw new Error("This workflow does not require source media.");
  }

  const isAudioFile = (file.type || "").startsWith("audio/");
  const isVideoFile = (file.type || "").startsWith("video/");
  const fixedCharacterMode = getFixedCharacterAnimateModeForWorkflow(workflowId);

  if (fixedCharacterMode === "audio_driven") {
    if (!isAudioFile) {
      throw new Error("Choose an audio file for this workflow.");
    }
    const durationSec = await readLocalAudioDuration(file);
    if (durationSec > MAX_CHARACTER_AUDIO_DURATION_SECONDS + 1e-3) {
      throw new Error(
        `Source audio is ${durationSec.toFixed(2)}s. Uploaded source audio must be ${MAX_CHARACTER_AUDIO_DURATION_SECONDS.toFixed(2)}s or shorter.`,
      );
    }
    return;
  }

  if (isCharacterAnimateWorkflowId(workflowId) || sourceKind === "video") {
    if (!isVideoFile) {
      throw new Error("Choose a video file for this workflow.");
    }
    const durationSec = await readLocalVideoDuration(file);
    if (durationSec > MAX_SOURCE_VIDEO_DURATION_SECONDS + 1e-3) {
      throw new Error(`Source video is ${durationSec.toFixed(2)}s. Uploaded source videos must be 120.00s or shorter.`);
    }
  }
}

import { useEffect, useMemo, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import {
  DEFAULT_TASK_WORKFLOW_ID,
  getFixedCharacterAnimateModeForWorkflow,
  isCharacterAnimateWorkflowId,
  isPrevizWorkflowId,
  type TaskWorkflowId,
} from "../lib/taskWorkflows";
import type { TabId } from "./useWorkflowRouting";

export type NewTaskStage = "idle" | "creating" | "uploading" | "ingesting" | "error";
type IngestCompleteHook = (taskId: string) => void | Promise<void>;
const MAX_SOURCE_VIDEO_DURATION_SECONDS = 120;
const MAX_CHARACTER_AUDIO_DURATION_SECONDS = 600;

type UseTaskLifecycleParams = {
  isAuthed: boolean;
  isPageVisible: boolean;
  selectedTaskId: string | null;
  existingTaskNames: string[];
  queryClient: QueryClient;
  setSelectedTaskId: (taskId: string | null) => void;
  setTab: (nextTab: TabId, taskIdOverride?: string | null, replace?: boolean) => void;
  onTrackJobId: (jobId: string) => void;
};

function normalizeTaskNameInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 15);
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

function readLocalVideoDuration(file: File): Promise<number> {
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

function readLocalAudioDuration(file: File): Promise<number> {
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

export function useTaskLifecycle({
  isAuthed,
  isPageVisible,
  selectedTaskId,
  existingTaskNames,
  queryClient,
  setSelectedTaskId,
  setTab,
  onTrackJobId,
}: UseTaskLifecycleParams) {
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("New Video");
  const [newTaskFile, setNewTaskFile] = useState<File | null>(null);
  const [newTaskScenePrompt, setNewTaskScenePrompt] = useState("");
  const [newTaskWorkflowId, setNewTaskWorkflowId] = useState<TaskWorkflowId>(DEFAULT_TASK_WORKFLOW_ID);
  const [newTaskStage, setNewTaskStage] = useState<NewTaskStage>("idle");
  const [newTaskError, setNewTaskError] = useState<string | null>(null);
  const [newTaskUploadPercent, setNewTaskUploadPercent] = useState(0);
  const [pendingCreateJobId, setPendingCreateJobId] = useState<string | null>(null);
  const [pendingCreatedTaskId, setPendingCreatedTaskId] = useState<string | null>(null);
  const [pendingIngestCompleteHook, setPendingIngestCompleteHook] = useState<IngestCompleteHook | null>(null);

  const pendingCreateJobQuery = useQuery({
    queryKey: ["job", pendingCreateJobId],
    queryFn: () => apiClient.getJob(pendingCreateJobId as string),
    enabled: isAuthed && !!pendingCreateJobId,
    refetchInterval: (q: { state: { data?: { status?: string } } }) => {
      if (!isPageVisible) return false;
      const status = q?.state?.data?.status;
      return status === "queued" || status === "running" ? 2000 : false;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const normalizedNewTaskName = useMemo(() => normalizeTaskNameInput(newTaskName), [newTaskName]);
  const taskNameAlreadyExists = useMemo(() => {
    const target = normalizedNewTaskName.toLowerCase();
    if (!target) return false;
    return existingTaskNames.some((name) => name.toLowerCase() === target);
  }, [existingTaskNames, normalizedNewTaskName]);

  const showTaskNameExistsWarning =
    taskNameAlreadyExists && newTaskStage !== "creating" && newTaskStage !== "uploading" && newTaskStage !== "ingesting";

  useEffect(() => {
    const status = pendingCreateJobQuery.data?.status;
    if (newTaskStage !== "ingesting" || !status) return;
    if (status === "complete") {
      const completedTaskId = pendingCreatedTaskId ?? selectedTaskId ?? null;
      const ingestCompleteHook = pendingIngestCompleteHook;
      setNewTaskStage("idle");
      setPendingCreateJobId(null);
      setPendingCreatedTaskId(null);
      setPendingIngestCompleteHook(null);
      setNewTaskError(null);
      setIsNewTaskModalOpen(false);
      setTab("timeline");
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (selectedTaskId) {
        void queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      }
      if (completedTaskId && ingestCompleteHook) {
        void ingestCompleteHook(completedTaskId);
      }
      return;
    }
    if (status === "failed") {
      setNewTaskStage("error");
      setNewTaskError(pendingCreateJobQuery.data?.error || "Ingest failed");
      setPendingCreateJobId(null);
      setPendingCreatedTaskId(null);
      setPendingIngestCompleteHook(null);
    }
  }, [newTaskStage, pendingCreateJobQuery.data, pendingCreatedTaskId, pendingIngestCompleteHook, queryClient, selectedTaskId, setTab]);

  function openNewTaskModal(workflowId: TaskWorkflowId = DEFAULT_TASK_WORKFLOW_ID) {
    setNewTaskName(isPrevizWorkflowId(workflowId) ? "New Scene" : "New Video");
    setNewTaskFile(null);
    setNewTaskScenePrompt("");
    setNewTaskWorkflowId(workflowId);
    setNewTaskStage("idle");
    setNewTaskError(null);
    setNewTaskUploadPercent(0);
    setPendingCreateJobId(null);
    setPendingCreatedTaskId(null);
    setPendingIngestCompleteHook(null);
    setIsNewTaskModalOpen(true);
  }

  async function handleCreateTaskWithUpload(options?: { onIngestComplete?: IngestCompleteHook }) {
    if (!newTaskName.trim()) return;
    if (!isPrevizWorkflowId(newTaskWorkflowId) && !newTaskFile) return;
    try {
      setNewTaskError(null);
      setNewTaskUploadPercent(0);
      const normalizedTaskName = normalizeTaskNameInput(newTaskName);
      if (!normalizedTaskName) {
        setNewTaskStage("error");
        setNewTaskError("Video name must include letters or numbers");
        return;
      }
      if (taskNameAlreadyExists) {
        setNewTaskStage("error");
        setNewTaskError("Video name already exists. Choose a unique name.");
        return;
      }
      setNewTaskStage("creating");
      setNewTaskName(normalizedTaskName);
      const created = await apiClient.createTask(normalizedTaskName, newTaskWorkflowId, {
        scenePrompt: isPrevizWorkflowId(newTaskWorkflowId) ? newTaskScenePrompt.trim() : null,
      });
      setPendingCreatedTaskId(created.taskId);
      setPendingIngestCompleteHook(() => options?.onIngestComplete ?? null);
      setSelectedTaskId(created.taskId);
      setTab("timeline", created.taskId, true);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });

      if (isPrevizWorkflowId(newTaskWorkflowId)) {
        setNewTaskStage("idle");
        setPendingCreatedTaskId(null);
        setPendingIngestCompleteHook(null);
        setNewTaskError(null);
        setIsNewTaskModalOpen(false);
        await queryClient.invalidateQueries({ queryKey: ["task", created.taskId] });
        return;
      }

      setNewTaskStage("uploading");
      const uploadFile = newTaskFile;
      if (!uploadFile) {
        throw new Error("Choose a source file before creating this task.");
      }
      const contentType = uploadFile.type || "video/mp4";
      const upload = await apiClient.createVideoUpload(created.taskId, {
        filename: uploadFile.name,
        contentType,
        sizeBytes: uploadFile.size,
      });
      await uploadFileWithProgress(upload.uploadUrl, uploadFile, contentType, setNewTaskUploadPercent);

      setNewTaskStage("ingesting");
      const ingest = await apiClient.ingestTask(created.taskId);
      setPendingCreateJobId(ingest.jobId);
      onTrackJobId(ingest.jobId);
    } catch (error) {
      setNewTaskStage("error");
      setNewTaskError(error instanceof Error ? error.message : "Video setup failed");
      setPendingCreatedTaskId(null);
      setPendingIngestCompleteHook(null);
    }
  }

  async function handleNewTaskFileSelect(file: File | null) {
    setNewTaskError(null);
    if (!file) {
      setNewTaskFile(null);
      setNewTaskStage("idle");
      return;
    }
    try {
      const isAudioFile = (file.type || "").startsWith("audio/");
      const isVideoFile = (file.type || "").startsWith("video/");
      const fixedCharacterMode = getFixedCharacterAnimateModeForWorkflow(newTaskWorkflowId);
      if (fixedCharacterMode === "audio_driven") {
        if (!isAudioFile) {
          setNewTaskFile(null);
          setNewTaskStage("idle");
          setNewTaskError("Choose an audio file for this workflow.");
          return;
        }
        const durationSec = await readLocalAudioDuration(file);
        if (durationSec > MAX_CHARACTER_AUDIO_DURATION_SECONDS + 1e-3) {
          setNewTaskFile(null);
          setNewTaskStage("idle");
          setNewTaskError(
            `Source audio is ${durationSec.toFixed(2)}s. Uploaded source audio must be ${MAX_CHARACTER_AUDIO_DURATION_SECONDS.toFixed(2)}s or shorter.`,
          );
          return;
        }
      } else if (isCharacterAnimateWorkflowId(newTaskWorkflowId) && fixedCharacterMode === "pose_video") {
        if (!isVideoFile) {
          setNewTaskFile(null);
          setNewTaskStage("idle");
          setNewTaskError("Choose a video file for this workflow.");
          return;
        }
        const durationSec = await readLocalVideoDuration(file);
        if (durationSec > MAX_SOURCE_VIDEO_DURATION_SECONDS + 1e-3) {
          setNewTaskFile(null);
          setNewTaskStage("idle");
          setNewTaskError(`Source video is ${durationSec.toFixed(2)}s. Uploaded source videos must be 120.00s or shorter.`);
          return;
        }
      } else {
        if (!isVideoFile) {
          setNewTaskFile(null);
          setNewTaskStage("idle");
          setNewTaskError("Choose a video file.");
          return;
        }
        const durationSec = await readLocalVideoDuration(file);
        if (durationSec > MAX_SOURCE_VIDEO_DURATION_SECONDS + 1e-3) {
          setNewTaskFile(null);
          setNewTaskStage("idle");
          setNewTaskError(`Source video is ${durationSec.toFixed(2)}s. Uploaded source videos must be 120.00s or shorter.`);
          return;
        }
      }
      setNewTaskFile(file);
      setNewTaskStage("idle");
    } catch (error) {
      setNewTaskFile(null);
      setNewTaskStage("idle");
      setNewTaskError(error instanceof Error ? error.message : "Could not validate the selected video file");
    }
  }

  return {
    isNewTaskModalOpen,
    setIsNewTaskModalOpen,
    newTaskName,
    setNewTaskName,
    newTaskFile,
    newTaskScenePrompt,
    newTaskWorkflowId,
    setNewTaskFile,
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
  };
}

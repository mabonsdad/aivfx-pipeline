import { useEffect, useMemo, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import type { TabId } from "./useWorkflowRouting";

export type NewTaskStage = "idle" | "creating" | "uploading" | "ingesting" | "error";
type IngestCompleteHook = (taskId: string) => void | Promise<void>;

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
  const [newTaskName, setNewTaskName] = useState("New VFX Task");
  const [newTaskFile, setNewTaskFile] = useState<File | null>(null);
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

  function openNewTaskModal() {
    setNewTaskName("New VFX Task");
    setNewTaskFile(null);
    setNewTaskStage("idle");
    setNewTaskError(null);
    setNewTaskUploadPercent(0);
    setPendingCreateJobId(null);
    setPendingCreatedTaskId(null);
    setPendingIngestCompleteHook(null);
    setIsNewTaskModalOpen(true);
  }

  async function handleCreateTaskWithUpload(options?: { onIngestComplete?: IngestCompleteHook }) {
    if (!newTaskName.trim() || !newTaskFile) return;
    try {
      setNewTaskError(null);
      setNewTaskUploadPercent(0);
      const normalizedTaskName = normalizeTaskNameInput(newTaskName);
      if (!normalizedTaskName) {
        setNewTaskStage("error");
        setNewTaskError("Task name must include letters or numbers");
        return;
      }
      if (taskNameAlreadyExists) {
        setNewTaskStage("error");
        setNewTaskError("Task name already exists. Choose a unique name.");
        return;
      }
      setNewTaskStage("creating");
      setNewTaskName(normalizedTaskName);
      const created = await apiClient.createTask(normalizedTaskName);
      setPendingCreatedTaskId(created.taskId);
      setPendingIngestCompleteHook(() => options?.onIngestComplete ?? null);
      setSelectedTaskId(created.taskId);
      setTab("timeline", created.taskId, true);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });

      setNewTaskStage("uploading");
      const contentType = newTaskFile.type || "video/mp4";
      const upload = await apiClient.createVideoUpload(created.taskId, {
        filename: newTaskFile.name,
        contentType,
        sizeBytes: newTaskFile.size,
      });
      await uploadFileWithProgress(upload.uploadUrl, newTaskFile, contentType, setNewTaskUploadPercent);

      setNewTaskStage("ingesting");
      const ingest = await apiClient.ingestTask(created.taskId);
      setPendingCreateJobId(ingest.jobId);
      onTrackJobId(ingest.jobId);
    } catch (error) {
      setNewTaskStage("error");
      setNewTaskError(error instanceof Error ? error.message : "Task setup failed");
      setPendingCreatedTaskId(null);
      setPendingIngestCompleteHook(null);
    }
  }

  return {
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
  };
}

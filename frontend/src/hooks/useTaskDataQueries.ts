import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import type { TaskDetail, TaskSummary } from "../types/api";

const TASK_URL_REFRESH_MS = 15 * 60 * 1000;
const ACTIVE_TASK_POLL_MS = 3000;

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

type UseTaskDataQueriesArgs = {
  isAuthed: boolean;
  selectedTaskId: string | null;
  reportTaskId: string | null;
  isReportTab: boolean;
  isAssetLibraryTab: boolean;
  isPageVisible: boolean;
  tasks: TaskSummary[];
};

export function useTaskDataQueries({
  isAuthed,
  selectedTaskId,
  reportTaskId,
  isReportTab,
  isAssetLibraryTab,
  isPageVisible,
  tasks,
}: UseTaskDataQueriesArgs) {
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
    queries: tasks.map((taskItem) => ({
      queryKey: ["task", "assets", taskItem.taskId],
      queryFn: () => apiClient.getTask(taskItem.taskId),
      enabled: isAuthed && isAssetLibraryTab && isPageVisible,
      refetchOnWindowFocus: false as const,
    })),
  });

  const task = taskQuery.data;
  const reportTask = reportTaskQuery.data;
  const assetTasks = useMemo(
    () => assetTaskQueries.map((query) => query.data).filter((item): item is TaskDetail => Boolean(item)),
    [assetTaskQueries],
  );

  const assetsLoading = (taskQuery.isPending || taskQuery.isFetching) && !task;
  const assetLibraryLoading = assetTaskQueries.some((query) => query.isPending || query.isFetching) && assetTasks.length === 0;

  return {
    taskQuery,
    reportTaskQuery,
    assetTaskQueries,
    task,
    reportTask,
    assetTasks,
    assetsLoading,
    assetLibraryLoading,
  };
}

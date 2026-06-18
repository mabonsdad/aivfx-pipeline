import { useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import type { TaskDetail, TaskSummary } from "../types/api";

const TASK_URL_REFRESH_MS = 15 * 60 * 1000;
const ACTIVE_TASK_POLL_MS = 3000;
const TASK_STALE_MS = 30_000;
const ASSET_TASK_STALE_MS = 60_000;

function parsePresignedExpiryMs(url: string | undefined | null): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const expires = parsed.searchParams.get("X-Amz-Expires");
    const signedAt = parsed.searchParams.get("X-Amz-Date");
    if (!expires || !signedAt) return null;
    const match = signedAt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    const signedAtMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    const expiresMs = signedAtMs + Number(expires) * 1000;
    return Number.isFinite(expiresMs) ? expiresMs : null;
  } catch {
    return null;
  }
}

function isNearExpiry(url: string | undefined | null, thresholdMs = 60_000): boolean {
  const expiryMs = parsePresignedExpiryMs(url);
  if (typeof expiryMs !== "number") return false;
  return expiryMs - Date.now() <= thresholdMs;
}

function preferStableUrl(previousUrl: string | undefined, nextUrl: string | undefined): string | undefined {
  if (!previousUrl) return nextUrl;
  if (!nextUrl) return nextUrl;
  return isNearExpiry(previousUrl) ? nextUrl : previousUrl;
}

function stabilizeTaskMediaUrls(previous: TaskDetail | undefined, next: TaskDetail): TaskDetail {
  if (!previous) return next;

  const previousSegmentsById = new Map((previous.segments ?? []).map((segment) => [segment.segmentId, segment]));
  const previousReferencesById = new Map((previous.editVideoReferences ?? []).map((reference) => [reference.referenceId, reference]));
  const previousExportsById = new Map((previous.exports ?? []).map((item) => [item.exportId, item]));

  const stabilizedFrames = Object.fromEntries(
    Object.entries(next.frames ?? {}).map(([frameId, frame]) => {
      const previousFrame = previous.frames?.[frameId];
      const previousVariantsById = new Map((previousFrame?.variants ?? []).map((variant) => [variant.variantId, variant]));
      return [
        frameId,
        {
          ...frame,
          imageUrl:
            previousFrame?.captureKey && previousFrame.captureKey === frame.captureKey
              ? preferStableUrl(previousFrame.imageUrl, frame.imageUrl)
              : frame.imageUrl,
          variants: (frame.variants ?? []).map((variant) => {
            const previousVariant = previousVariantsById.get(variant.variantId);
            return {
              ...variant,
              imageUrl:
                previousVariant?.outputKey && previousVariant.outputKey === variant.outputKey
                  ? preferStableUrl(previousVariant.imageUrl, variant.imageUrl)
                  : variant.imageUrl,
            };
          }),
        },
      ];
    }),
  );

  const stabilizedSegmentGenerations = Object.fromEntries(
    Object.entries(next.segmentGenerations ?? {}).map(([generationId, generation]) => {
      const previousGeneration = previous.segmentGenerations?.[generationId];
      return [
        generationId,
        {
          ...generation,
          downloadUrl:
            previousGeneration?.outputKey && previousGeneration.outputKey === generation.outputKey
              ? preferStableUrl(previousGeneration.downloadUrl, generation.downloadUrl)
              : generation.downloadUrl,
          posterUrl:
            previousGeneration?.posterKey && previousGeneration.posterKey === generation.posterKey
              ? preferStableUrl(previousGeneration.posterUrl, generation.posterUrl)
              : generation.posterUrl,
          inputMediaUrl:
            previousGeneration?.inputMediaKey && previousGeneration.inputMediaKey === generation.inputMediaKey
              ? preferStableUrl(previousGeneration.inputMediaUrl, generation.inputMediaUrl)
              : generation.inputMediaUrl,
          inputFirstFrameUrl:
            previousGeneration?.inputFirstFrameKey && previousGeneration.inputFirstFrameKey === generation.inputFirstFrameKey
              ? preferStableUrl(previousGeneration.inputFirstFrameUrl, generation.inputFirstFrameUrl)
              : generation.inputFirstFrameUrl,
          inputLastFrameUrl:
            previousGeneration?.inputLastFrameKey && previousGeneration.inputLastFrameKey === generation.inputLastFrameKey
              ? preferStableUrl(previousGeneration.inputLastFrameUrl, generation.inputLastFrameUrl)
              : generation.inputLastFrameUrl,
          sourceFirstFrameCaptureUrl:
            previousGeneration?.sourceFirstFrameCaptureKey &&
            previousGeneration.sourceFirstFrameCaptureKey === generation.sourceFirstFrameCaptureKey
              ? preferStableUrl(previousGeneration.sourceFirstFrameCaptureUrl, generation.sourceFirstFrameCaptureUrl)
              : generation.sourceFirstFrameCaptureUrl,
          sourceLastFrameCaptureUrl:
            previousGeneration?.sourceLastFrameCaptureKey &&
            previousGeneration.sourceLastFrameCaptureKey === generation.sourceLastFrameCaptureKey
              ? preferStableUrl(previousGeneration.sourceLastFrameCaptureUrl, generation.sourceLastFrameCaptureUrl)
              : generation.sourceLastFrameCaptureUrl,
        },
      ];
    }),
  );

  return {
    ...next,
    video: {
      ...next.video,
      original:
        next.video.original && previous.video?.original?.s3Key === next.video.original.s3Key
          ? { ...next.video.original, downloadUrl: preferStableUrl(previous.video.original?.downloadUrl, next.video.original.downloadUrl) }
          : next.video.original,
      editSource:
        next.video.editSource && previous.video?.editSource?.s3Key === next.video.editSource.s3Key
          ? { ...next.video.editSource, downloadUrl: preferStableUrl(previous.video.editSource?.downloadUrl, next.video.editSource.downloadUrl) }
          : next.video.editSource,
      previewSource:
        next.video.previewSource && previous.video?.previewSource?.s3Key === next.video.previewSource.s3Key
          ? { ...next.video.previewSource, downloadUrl: preferStableUrl(previous.video.previewSource?.downloadUrl, next.video.previewSource.downloadUrl) }
          : next.video.previewSource,
    },
    segments: (next.segments ?? []).map((segment) => {
      const previousSegment = previousSegmentsById.get(segment.segmentId);
      return {
        ...segment,
        segmentClipUrl:
          previousSegment?.segmentClipKey && previousSegment.segmentClipKey === segment.segmentClipKey
            ? preferStableUrl(previousSegment.segmentClipUrl, segment.segmentClipUrl)
            : segment.segmentClipUrl,
      };
    }),
    frames: stabilizedFrames,
    segmentGenerations: stabilizedSegmentGenerations,
    editVideoReferences: (next.editVideoReferences ?? []).map((reference) => {
      const previousReference = previousReferencesById.get(reference.referenceId);
      return {
        ...reference,
        imageUrl:
          previousReference?.key && previousReference.key === reference.key
            ? preferStableUrl(previousReference.imageUrl, reference.imageUrl)
            : reference.imageUrl,
      };
    }),
    exports: (next.exports ?? []).map((exportItem) => {
      const previousExport = previousExportsById.get(exportItem.exportId);
      return {
        ...exportItem,
        downloadUrl:
          previousExport?.outputKey && previousExport.outputKey === exportItem.outputKey
            ? preferStableUrl(previousExport.downloadUrl, exportItem.downloadUrl)
            : exportItem.downloadUrl,
      };
    }),
  };
}

function hasActiveTaskWork(task: TaskDetail | undefined): boolean {
  if (!task) return false;
  const isActiveJobStatus = (status: string | undefined | null) => status === "queued" || status === "running";
  for (const generation of Object.values(task.segmentGenerations ?? {})) {
    if (isActiveJobStatus(generation.status)) return true;
  }
  for (const run of task.chunkedGenerationRuns ?? []) {
    if (run.status === "running") return true;
    if (isActiveJobStatus(run.saveStatus)) return true;
    for (const chunk of run.chunks ?? []) {
      if (isActiveJobStatus(chunk.status)) return true;
    }
  }
  for (const track of task.videoCleanupTracks ?? []) {
    if (["created", "preparing", "tracking", "applying"].includes(track.status)) return true;
  }
  for (const report of task.customReports ?? []) {
    if (isActiveJobStatus(report.status)) return true;
  }
  for (const exportItem of task.exports ?? []) {
    const motionSyncStatus = exportItem.motionSyncQc?.status;
    if (isActiveJobStatus(motionSyncStatus)) return true;
    const topazStatus = exportItem.topazUpscale?.status;
    if (isActiveJobStatus(topazStatus)) return true;
  }
  return false;
}

type UseTaskDataQueriesArgs = {
  isAuthed: boolean;
  selectedTaskId: string | null;
  reportTaskId: string | null;
  isReportTab: boolean;
  isAssetLibraryTab: boolean;
  enableAssetTaskQueries: boolean;
  isPageVisible: boolean;
  assetTaskRequests: Array<{
    taskSummary: TaskSummary;
    scope: "mine" | "all" | "project";
    projectId?: string | null;
  }>;
};

export function useTaskDataQueries({
  isAuthed,
  selectedTaskId,
  reportTaskId,
  isReportTab,
  isAssetLibraryTab,
  enableAssetTaskQueries,
  isPageVisible,
  assetTaskRequests,
}: UseTaskDataQueriesArgs) {
  const queryClient = useQueryClient();
  const taskQuery = useQuery({
    queryKey: ["task", selectedTaskId],
    queryFn: async () => {
      const nextTask = await apiClient.getTask(selectedTaskId as string);
      const previousTask = queryClient.getQueryData<TaskDetail>(["task", selectedTaskId]);
      return stabilizeTaskMediaUrls(previousTask, nextTask);
    },
    enabled: isAuthed && !!selectedTaskId && !isReportTab,
    staleTime: TASK_STALE_MS,
    refetchInterval: (query) => {
      if (!(isAuthed && !!selectedTaskId && isPageVisible)) return false;
      const currentTask = query.state.data as TaskDetail | undefined;
      return hasActiveTaskWork(currentTask) ? ACTIVE_TASK_POLL_MS : TASK_URL_REFRESH_MS;
    },
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const reportTaskQuery = useQuery({
    queryKey: ["task", "report", reportTaskId],
    queryFn: async () => {
      const nextTask = await apiClient.getTask(reportTaskId as string);
      const previousTask = queryClient.getQueryData<TaskDetail>(["task", "report", reportTaskId]);
      return stabilizeTaskMediaUrls(previousTask, nextTask);
    },
    enabled: isAuthed && !!reportTaskId && isReportTab,
    staleTime: TASK_STALE_MS,
    refetchInterval: (query) => {
      if (!(isAuthed && !!reportTaskId && isPageVisible)) return false;
      const currentTask = query.state.data as TaskDetail | undefined;
      return hasActiveTaskWork(currentTask) ? ACTIVE_TASK_POLL_MS : TASK_URL_REFRESH_MS;
    },
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const assetTaskQueries = useQueries({
    queries: assetTaskRequests.map(({ taskSummary, scope, projectId }) => ({
      queryKey: ["task", "assets", scope, projectId ?? "none", taskSummary.taskId],
      queryFn: async () => {
        const nextTask = await apiClient.getTask(taskSummary.taskId, { scope, projectId });
        const previousTask = queryClient.getQueryData<TaskDetail>(["task", "assets", scope, projectId ?? "none", taskSummary.taskId]);
        return stabilizeTaskMediaUrls(previousTask, nextTask);
      },
      enabled: isAuthed && (isAssetLibraryTab || enableAssetTaskQueries) && isPageVisible,
      staleTime: ASSET_TASK_STALE_MS,
      refetchOnMount: false as const,
      refetchOnWindowFocus: false as const,
      refetchOnReconnect: false as const,
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

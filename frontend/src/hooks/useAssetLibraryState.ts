import { useMemo } from "react";

import type { SegmentGeneration, TaskDetail } from "../types/api";
import type { LibraryAsset } from "../types/libraryAsset";

function humanizeFilename(value: string): string {
  const withoutExt = value.replace(/\.[^/.]+$/, "");
  return withoutExt.replace(/[_-]+/g, " ").trim();
}

function keyBasenameFromS3Key(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
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

type TaskAssetContext = {
  taskId: string;
  task: TaskDetail;
};

function sortByCreatedDesc(assets: LibraryAsset[]): LibraryAsset[] {
  return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function collectEditedFrameAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    for (const frame of Object.values(task.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.imageUrl) continue;
        assets.push({
          id: `variant:${taskId}:${frame.frameId}:${variant.variantId}`,
          taskId,
          title: humanizeFilename(keyBasenameFromS3Key(variant.outputKey)),
          subtitle: `${task.name} · frame ${frame.frameIndex} · ${variant.model}/${variant.type}`,
          createdAt: variant.createdAt,
          previewUrl: variant.imageUrl,
          downloadUrl: variant.imageUrl,
          mediaType: "image",
          customReportRef: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
          deletePayload: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
        });
      }
    }
  }
  return sortByCreatedDesc(assets);
}

function collectGeneratedVideoAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    for (const generation of Object.values(task.segmentGenerations ?? {})) {
      if (generation.status === "failed" || generation.isChunkInternal || !generation.downloadUrl) continue;
      assets.push({
        id: `generation:${taskId}:${generation.genId}`,
        taskId,
        title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
        subtitle: `${task.name} · ${generation.luma.model} · ${generation.luma.mode}${generation.manualUpload ? " · manual upload" : ""}`,
        createdAt: generation.createdAt,
        previewUrl: generation.downloadUrl,
        downloadUrl: generation.downloadUrl,
        thumbnailUrl: generationThumbnailUrl(generation) ?? undefined,
        mediaType: "video",
        customReportRef: { assetType: "segment_generation", genId: generation.genId },
        deletePayload: { assetType: "segment_generation", genId: generation.genId },
      });
    }
  }
  return sortByCreatedDesc(assets);
}

function collectMergedVideoAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    for (const exportItem of task.exports ?? []) {
      if (!exportItem.downloadUrl) continue;
      assets.push({
        id: `export:${taskId}:${exportItem.exportId}`,
        taskId,
        title: humanizeFilename(keyBasenameFromS3Key(exportItem.outputKey || `${exportItem.exportId}.mp4`)),
        subtitle: `${task.name} · merged export`,
        createdAt: exportItem.createdAt,
        previewUrl: exportItem.downloadUrl,
        downloadUrl: exportItem.downloadUrl,
        mediaType: "video",
        customReportRef: { assetType: "export", exportId: exportItem.exportId },
        deletePayload: { assetType: "export", exportId: exportItem.exportId },
      });
    }
  }
  return sortByCreatedDesc(assets);
}

type UseAssetLibraryStateArgs = {
  selectedTaskId: string | null;
  selectedTask: TaskDetail | undefined;
  assetTasks: TaskDetail[];
};

export function useAssetLibraryState({ selectedTaskId, selectedTask, assetTasks }: UseAssetLibraryStateArgs) {
  const selectedTaskContexts = useMemo<TaskAssetContext[]>(
    () => (selectedTaskId && selectedTask ? [{ taskId: selectedTaskId, task: selectedTask }] : []),
    [selectedTask, selectedTaskId],
  );
  const libraryTaskContexts = useMemo<TaskAssetContext[]>(
    () => assetTasks.map((task) => ({ taskId: task.taskId, task })),
    [assetTasks],
  );

  const editedFrameAssets = useMemo(() => collectEditedFrameAssets(selectedTaskContexts), [selectedTaskContexts]);
  const generatedVideoAssets = useMemo(() => collectGeneratedVideoAssets(selectedTaskContexts), [selectedTaskContexts]);
  const mergedVideoAssets = useMemo(() => collectMergedVideoAssets(selectedTaskContexts), [selectedTaskContexts]);

  const libraryEditedFrameAssets = useMemo(() => collectEditedFrameAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryGeneratedVideoAssets = useMemo(() => collectGeneratedVideoAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryMergedVideoAssets = useMemo(() => collectMergedVideoAssets(libraryTaskContexts), [libraryTaskContexts]);

  return {
    editedFrameAssets,
    generatedVideoAssets,
    mergedVideoAssets,
    libraryEditedFrameAssets,
    libraryGeneratedVideoAssets,
    libraryMergedVideoAssets,
  };
}

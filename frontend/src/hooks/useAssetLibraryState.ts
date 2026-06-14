import { useMemo } from "react";

import { classifyGenerationAssetRole, getGenerationOrigin } from "../lib/generationOrigin";
import { resolveExportThumbnailUrl, resolveGenerationThumbnailUrl } from "../lib/taskPreview";
import type { TaskDetail } from "../types/api";
import type { LibraryAsset } from "../types/libraryAsset";

function humanizeFilename(value: string): string {
  const withoutExt = value.replace(/\.[^/.]+$/, "");
  return withoutExt.replace(/[_-]+/g, " ").trim();
}

function keyBasenameFromS3Key(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function referenceAssetLabel(task: TaskDetail): string {
  if (task.workflowId === "character_animate_workflow") return "character";
  if (task.workflowId === "simple_generation_workflow") return "scene reference";
  return "reference image";
}

function previzFrameReferenceIds(task: TaskDetail): Set<string> {
  return new Set(Array.isArray(task.previz?.frameReferenceIds) ? task.previz?.frameReferenceIds : []);
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
    if (task.workflowId === "simple_generation_workflow") {
      const frameIds = previzFrameReferenceIds(task);
      for (const reference of task.editVideoReferences ?? []) {
        if (!frameIds.has(reference.referenceId) || !reference.imageUrl) continue;
        const filename = reference.filename || keyBasenameFromS3Key(reference.key);
        const modelLabel = reference.model ? ` · ${reference.model}` : "";
        const typeLabel = reference.type === "generated" ? "generated" : "uploaded";
        assets.push({
          id: `previz-frame:${taskId}:${reference.referenceId}`,
          taskId,
          title: humanizeFilename(filename),
          subtitle: `${task.name} · generated frame · ${typeLabel}${modelLabel}`,
          createdAt: reference.createdAt,
          previewUrl: reference.imageUrl,
          downloadUrl: reference.imageUrl,
          mediaType: "image",
          assetRole: "edited_frame",
          deletePayload: { assetType: "edit_video_reference", referenceId: reference.referenceId },
        });
      }
      continue;
    }
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

function collectReferenceImageAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    const previzFrameIds = task.workflowId === "simple_generation_workflow" ? previzFrameReferenceIds(task) : null;
    for (const reference of task.editVideoReferences ?? []) {
      if (previzFrameIds?.has(reference.referenceId)) continue;
      if (!reference.imageUrl) continue;
      const label = referenceAssetLabel(task);
      const filename = reference.filename || keyBasenameFromS3Key(reference.key);
      const modelLabel = reference.model ? ` · ${reference.model}` : "";
      const typeLabel = reference.type === "generated" ? "generated" : "uploaded";
      assets.push({
        id: `edit-reference:${taskId}:${reference.referenceId}`,
        taskId,
        title: humanizeFilename(filename),
        subtitle: `${task.name} · ${label} · ${typeLabel}${modelLabel}`,
        createdAt: reference.createdAt,
        previewUrl: reference.imageUrl,
        downloadUrl: reference.imageUrl,
        mediaType: "image",
        assetRole: task.workflowId === "character_animate_workflow" ? "character" : "reference_image",
        deletePayload: { assetType: "edit_video_reference", referenceId: reference.referenceId },
      });
    }
  }
  return sortByCreatedDesc(assets);
}

function collectGeneratedVideoAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    for (const generation of Object.values(task.segmentGenerations ?? {})) {
      if (classifyGenerationAssetRole(generation, task) !== "generated_video") continue;
      const downloadUrl = generation.downloadUrl;
      if (!downloadUrl) continue;
      assets.push({
        id: `generation:${taskId}:${generation.genId}`,
        taskId,
        title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
        subtitle: `${task.name} · ${generation.luma.model} · ${generation.luma.mode}${generation.manualUpload ? " · manual upload" : ""}`,
        createdAt: generation.createdAt,
        previewUrl: downloadUrl,
        downloadUrl,
        thumbnailUrl: resolveGenerationThumbnailUrl(task, generation) ?? undefined,
        mediaType: "video",
        assetRole: "generated_video",
        customReportRef: { assetType: "segment_generation", genId: generation.genId },
        deletePayload: { assetType: "segment_generation", genId: generation.genId },
      });
    }
  }
  return sortByCreatedDesc(assets);
}

function collectPostProcessVideoAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    for (const generation of Object.values(task.segmentGenerations ?? {})) {
      if (classifyGenerationAssetRole(generation, task) !== "post_process_video") continue;
      const downloadUrl = generation.downloadUrl;
      if (!downloadUrl) continue;
      const origin = getGenerationOrigin(generation, task);
      const toolLabel = origin?.toolOrigin === "clip_lengthen" ? "extended video" : origin?.toolOrigin === "timing_reconcile" ? "timing-reconciled video" : "post-process video";
      assets.push({
        id: `post-process:${taskId}:${generation.genId}`,
        taskId,
        title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
        subtitle: `${task.name} · ${toolLabel} · ${generation.luma.model}`,
        createdAt: generation.createdAt,
        previewUrl: downloadUrl,
        downloadUrl,
        thumbnailUrl: resolveGenerationThumbnailUrl(task, generation) ?? undefined,
        mediaType: "video",
        assetRole: "post_process_video",
        customReportRef: { assetType: "segment_generation", genId: generation.genId },
        deletePayload: { assetType: "segment_generation", genId: generation.genId },
      });
    }
  }
  return sortByCreatedDesc(assets);
}

function collectOrphanedAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    for (const generation of Object.values(task.segmentGenerations ?? {})) {
      if (classifyGenerationAssetRole(generation, task) !== "orphaned") continue;
      const origin = getGenerationOrigin(generation, task);
      const workflowLabel = origin?.workflowId ?? "unknown workflow";
      const stepLabel = origin?.stepOrigin ?? "unknown step";
      assets.push({
        id: `orphaned-generation:${taskId}:${generation.genId}`,
        taskId,
        title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
        subtitle: `${task.name} · uncategorized generation · ${workflowLabel} / ${stepLabel}`,
        createdAt: generation.createdAt,
        previewUrl: generation.downloadUrl!,
        downloadUrl: generation.downloadUrl!,
        thumbnailUrl: resolveGenerationThumbnailUrl(task, generation) ?? undefined,
        mediaType: "video",
        assetRole: "orphaned",
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
      if (exportItem.internalOnlySource) continue;
      if (!exportItem.downloadUrl) continue;
      assets.push({
        id: `export:${taskId}:${exportItem.exportId}`,
        taskId,
        title: humanizeFilename(keyBasenameFromS3Key(exportItem.outputKey || `${exportItem.exportId}.mp4`)),
        subtitle: `${task.name} · merged export`,
        createdAt: exportItem.createdAt,
        previewUrl: exportItem.downloadUrl,
        downloadUrl: exportItem.downloadUrl,
        thumbnailUrl: resolveExportThumbnailUrl(task, exportItem) ?? undefined,
        mediaType: "video",
        assetRole: "merged_video",
        customReportRef: { assetType: "export", exportId: exportItem.exportId },
        deletePayload: { assetType: "export", exportId: exportItem.exportId },
      });
    }
  }
  return sortByCreatedDesc(assets);
}

function collectAudioAssets(tasks: TaskAssetContext[]): LibraryAsset[] {
  const seen = new Set<string>();
  const assets: LibraryAsset[] = [];
  for (const { taskId, task } of tasks) {
    if (task.sourceMedia?.kind === "audio") {
      const sourceAudioUrl = task.sourceMedia.previewSource?.downloadUrl ?? task.sourceMedia.editSource?.downloadUrl;
      if (sourceAudioUrl) {
        const sourceKey = task.sourceMedia.previewSource?.s3Key ?? task.sourceMedia.editSource?.s3Key ?? `source-audio:${taskId}`;
        const dedupeKey = `${taskId}:${sourceKey}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          assets.push({
            id: `audio-source:${taskId}:${sourceKey}`,
            taskId,
            title: humanizeFilename(keyBasenameFromS3Key(sourceKey)),
            subtitle: `${task.name} · source audio`,
            createdAt: task.updatedAt,
            previewUrl: sourceAudioUrl,
            downloadUrl: sourceAudioUrl,
            thumbnailUrl: task.sourceMedia.waveform?.downloadUrl ?? task.video?.editSource?.waveformUrl ?? undefined,
            mediaType: "audio",
            assetRole: "source_audio",
          });
        }
      }
    }
    const generationAudioReference = task.generationAudioReference ?? null;
    const generationAudioUrl = generationAudioReference?.previewUrl ?? generationAudioReference?.editSourceUrl ?? generationAudioReference?.originalUrl;
    if (generationAudioReference?.referenceId && generationAudioUrl) {
      const referenceKey =
        generationAudioReference.previewKey ??
        generationAudioReference.editSourceKey ??
        generationAudioReference.originalKey ??
        `generation-audio:${taskId}:${generationAudioReference.referenceId}`;
      const dedupeKey = `${taskId}:${referenceKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      assets.push({
        id: `audio-reference:${taskId}:${generationAudioReference.referenceId}`,
        taskId,
        title: humanizeFilename(generationAudioReference.filename || keyBasenameFromS3Key(referenceKey)),
        subtitle: `${task.name} · audio reference`,
        createdAt: generationAudioReference.createdAt,
        previewUrl: generationAudioUrl,
        downloadUrl: generationAudioUrl,
        mediaType: "audio",
        thumbnailUrl: generationAudioReference.waveformUrl ?? undefined,
        assetRole: "audio_reference",
        deletePayload: { assetType: "generation_audio_reference" },
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
  const referenceImageAssets = useMemo(() => collectReferenceImageAssets(selectedTaskContexts), [selectedTaskContexts]);
  const generatedVideoAssets = useMemo(() => collectGeneratedVideoAssets(selectedTaskContexts), [selectedTaskContexts]);
  const postProcessVideoAssets = useMemo(() => collectPostProcessVideoAssets(selectedTaskContexts), [selectedTaskContexts]);
  const mergedVideoAssets = useMemo(() => collectMergedVideoAssets(selectedTaskContexts), [selectedTaskContexts]);
  const orphanedAssets = useMemo(() => collectOrphanedAssets(selectedTaskContexts), [selectedTaskContexts]);
  const audioAssets = useMemo(() => collectAudioAssets(selectedTaskContexts), [selectedTaskContexts]);

  const libraryEditedFrameAssets = useMemo(() => collectEditedFrameAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryReferenceImageAssets = useMemo(() => collectReferenceImageAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryGeneratedVideoAssets = useMemo(() => collectGeneratedVideoAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryPostProcessVideoAssets = useMemo(() => collectPostProcessVideoAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryMergedVideoAssets = useMemo(() => collectMergedVideoAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryOrphanedAssets = useMemo(() => collectOrphanedAssets(libraryTaskContexts), [libraryTaskContexts]);
  const libraryAudioAssets = useMemo(() => collectAudioAssets(libraryTaskContexts), [libraryTaskContexts]);

  return {
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
  };
}

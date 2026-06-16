import type { ExportRecord, SegmentGeneration, TaskDetail } from "../types/api";

function resolveReferenceImageUrl(task: TaskDetail, referenceId: string | null | undefined): string | null {
  if (!referenceId) return null;
  const reference = (task.editVideoReferences ?? []).find((item) => item.referenceId === referenceId);
  return reference?.imageUrl ?? null;
}

export function resolveGenerationThumbnailUrl(task: TaskDetail, generation: SegmentGeneration): string | null {
  if (generation.posterUrl) return generation.posterUrl;

  if (task.workflowId === "simple_generation_workflow") {
    const selectedFrameIds = Array.isArray(generation.generationSettings?.selectedFrameIds)
      ? generation.generationSettings.selectedFrameIds
      : [];
    const previzFrameId = selectedFrameIds[0] ?? null;
    return (
      resolveReferenceImageUrl(task, previzFrameId) ??
      generation.sourceFirstFrameCaptureUrl ??
      generation.sourceLastFrameCaptureUrl ??
      null
    );
  }

  if (task.workflowId === "character_animate_workflow") {
    const characterReferenceId =
      generation.characterAnimation?.characterReferenceId ??
      generation.generationSettings?.characterReferenceId ??
      null;
    return (
      resolveReferenceImageUrl(task, characterReferenceId) ??
      generation.sourceFirstFrameCaptureUrl ??
      generation.sourceLastFrameCaptureUrl ??
      null
    );
  }

  const segment = (task.segments ?? []).find((item) => item.segmentId === generation.segmentId) ?? null;
  const startFrameImage = segment?.startFrameId ? task.frames?.[segment.startFrameId]?.imageUrl ?? null : null;
  const endFrameImage = segment?.endFrameId ? task.frames?.[segment.endFrameId]?.imageUrl ?? null : null;
  return startFrameImage ?? generation.sourceFirstFrameCaptureUrl ?? endFrameImage ?? generation.sourceLastFrameCaptureUrl ?? null;
}

function resolveExportThumbnailUrlInternal(
  task: TaskDetail,
  exportItem: ExportRecord,
  visitedExportIds: Set<string>,
): string | null {
  if (exportItem.sourceGenerationId) {
    const sourceGeneration = task.segmentGenerations?.[exportItem.sourceGenerationId];
    if (sourceGeneration) {
      const generationThumbnail = resolveGenerationThumbnailUrl(task, sourceGeneration);
      if (generationThumbnail) return generationThumbnail;
    }
  }

  const selectedGenerationIds = Array.isArray(exportItem.selectedSegmentGenerationIds)
    ? exportItem.selectedSegmentGenerationIds
    : [];
  for (const generationId of selectedGenerationIds) {
    const generation = task.segmentGenerations?.[generationId];
    if (!generation) continue;
    const generationThumbnail = resolveGenerationThumbnailUrl(task, generation);
    if (generationThumbnail) return generationThumbnail;
  }

  if (exportItem.sourceExportId && !visitedExportIds.has(exportItem.sourceExportId)) {
    visitedExportIds.add(exportItem.sourceExportId);
    const parentExport = (task.exports ?? []).find((item) => item.exportId === exportItem.sourceExportId);
    if (parentExport) {
      const parentThumbnail = resolveExportThumbnailUrlInternal(task, parentExport, visitedExportIds);
      if (parentThumbnail) return parentThumbnail;
    }
  }

  return null;
}

export function resolveExportThumbnailUrl(task: TaskDetail, exportItem: ExportRecord): string | null {
  return resolveExportThumbnailUrlInternal(task, exportItem, new Set([exportItem.exportId]));
}

export function resolveLatestTaskThumbnailUrl(task: TaskDetail | null | undefined): string | null {
  if (!task) return null;
  const generations = Object.values(task.segmentGenerations ?? {})
    .filter((generation) => generation.status === "complete")
    .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime());
  for (const generation of generations) {
    const thumbnailUrl = resolveGenerationThumbnailUrl(task, generation);
    if (thumbnailUrl) return thumbnailUrl;
  }

  const frameVariantThumbnail = Object.values(task.frames ?? {})
    .flatMap((frame) => frame.variants ?? [])
    .filter((variant) => Boolean(variant.imageUrl))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.imageUrl;
  if (frameVariantThumbnail) return frameVariantThumbnail;

  const frameThumbnail = Object.values(task.frames ?? {})
    .filter((frame) => Boolean(frame.imageUrl))
    .sort((a, b) => new Date(b.createdAt ?? "").getTime() - new Date(a.createdAt ?? "").getTime())[0]?.imageUrl;
  if (frameThumbnail) return frameThumbnail;

  const referenceThumbnail = [...(task.editVideoReferences ?? [])]
    .filter((reference) => Boolean(reference.imageUrl))
    .sort((a, b) => new Date(b.createdAt ?? "").getTime() - new Date(a.createdAt ?? "").getTime())[0]?.imageUrl;
  if (referenceThumbnail) return referenceThumbnail;

  return null;
}

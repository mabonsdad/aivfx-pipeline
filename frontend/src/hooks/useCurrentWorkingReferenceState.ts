import { useMemo } from "react";

import { isCharacterAnimateWorkflowId, isPrevizWorkflowId, isSourceVideoWorkflowId, type TaskWorkflowId } from "../lib/taskWorkflows";
import type { GenerateInputMode } from "../lib/generationModeRegistry";
import type { PrimaryWorkflowSection } from "../lib/workflowSections";
import type { SegmentGeneration, SegmentRecord, TaskDetail } from "../types/api";
import type { WorkingReferencePreviewItem } from "../types/referencePicker";

type WorkingReferenceAsset = {
  label: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  posterUrl?: string | null;
  audioUrl?: string | null;
  waveformUrl?: string | null;
  rangeStartRatio?: number | null;
  rangeEndRatio?: number | null;
  rangeStartLabel?: string | null;
  rangeEndLabel?: string | null;
  actionLabel?: string;
  actionId?: string;
  actions?: Array<{
    label: string;
    actionId: string;
    disabled?: boolean;
  }>;
  selected?: boolean;
};

type UseCurrentWorkingReferenceStateArgs = {
  workflowId: TaskWorkflowId;
  activeWorkflowSection: PrimaryWorkflowSection | null;
  selectedSegment: SegmentRecord | null;
  defaultVideoSegment: SegmentRecord | null;
  task: TaskDetail | undefined;
  sourceMediaKind?: "video" | "audio" | "scene";
  sourceWaveformUrl?: string | null;
  selectedPreviewGeneration: SegmentGeneration | null;
  mergeTargetGeneration: SegmentGeneration | null;
  refineStartVariantId: string | null;
  refineEndVariantId: string | null;
  compareStartVariantId: string | null;
  compareEndVariantId: string | null;
  editFirstFrameId: string | null;
  editLastFrameId: string | null;
  generationInputMode: GenerateInputMode;
  wholeVideoNeedsChunking: boolean;
  frameVariantImageUrl: (frameId: string | null | undefined, variantId: string | null | undefined) => string | null;
  generationThumbnailUrl: (generation: SegmentGeneration) => string | null;
  editVideoReferencePreview: WorkingReferencePreviewItem[];
  previzReferencePreview?: WorkingReferencePreviewItem[];
  previzFramePreview?: WorkingReferencePreviewItem[];
};

function generationParentId(generation: SegmentGeneration | null | undefined): string | null {
  if (!generation) return null;
  return generation.parentGenerationId ?? generation.extension?.parentGenerationId ?? generation.derivedFromGenerationId ?? null;
}

function isExtensionGeneration(generation: SegmentGeneration | null | undefined): boolean {
  return Boolean(generation?.parentGenerationId || generation?.extension?.parentGenerationId);
}

function isCleanupGeneration(generation: SegmentGeneration | null | undefined): boolean {
  return Boolean(generation?.cleanupTrackId);
}

function isAlignedGeneration(generation: SegmentGeneration | null | undefined): boolean {
  return Boolean(generation?.derivedFromGenerationId) && !isExtensionGeneration(generation) && !isCleanupGeneration(generation);
}

function buildGenerationLineage(
  segmentGenerations: Record<string, SegmentGeneration> | undefined,
  generation: SegmentGeneration | null,
): SegmentGeneration[] {
  if (!segmentGenerations || !generation) return [];
  const lineage: SegmentGeneration[] = [];
  const seen = new Set<string>();
  let current: SegmentGeneration | null | undefined = generation;
  while (current && !seen.has(current.genId)) {
    lineage.unshift(current);
    seen.add(current.genId);
    const parentId = generationParentId(current);
    current = parentId ? segmentGenerations[parentId] : null;
  }
  return lineage;
}

export function useCurrentWorkingReferenceState({
  workflowId,
  activeWorkflowSection,
  selectedSegment,
  defaultVideoSegment,
  task,
  sourceMediaKind = "video",
  sourceWaveformUrl,
  selectedPreviewGeneration,
  mergeTargetGeneration,
  refineStartVariantId,
  refineEndVariantId,
  compareStartVariantId,
  compareEndVariantId,
  editFirstFrameId,
  editLastFrameId,
  generationInputMode,
  wholeVideoNeedsChunking,
  frameVariantImageUrl,
  generationThumbnailUrl,
  editVideoReferencePreview,
  previzReferencePreview = [],
  previzFramePreview = [],
}: UseCurrentWorkingReferenceStateArgs) {
  const currentReferenceSegment = selectedSegment ?? defaultVideoSegment ?? null;
  const isPrevizWorkflow = isPrevizWorkflowId(workflowId);
  const fallbackWaveformUrl = sourceMediaKind === "audio" ? sourceWaveformUrl ?? null : null;
  const currentReferenceStartImageUrl = isPrevizWorkflow
    ? null
    : currentReferenceSegment
    ? task?.frames?.[currentReferenceSegment.startFrameId]?.imageUrl ?? fallbackWaveformUrl
    : null;
  const currentReferenceEndImageUrl = isPrevizWorkflow
    ? null
    : currentReferenceSegment
    ? task?.frames?.[currentReferenceSegment.endFrameId]?.imageUrl ?? fallbackWaveformUrl
    : null;

  const currentReferenceAssets = useMemo<WorkingReferenceAsset[]>(() => {
    const assets: WorkingReferenceAsset[] = [];
    const isCharacterWorkflow = isCharacterAnimateWorkflowId(workflowId);
    if (isPrevizWorkflow) {
      const useFramePreview = activeWorkflowSection === "outputs";
      const activePreviewItems = useFramePreview ? previzFramePreview : previzReferencePreview;
      if (activeWorkflowSection === "create" || activeWorkflowSection === "outputs" || activeWorkflowSection === "post") {
        for (const [index, reference] of activePreviewItems.entries()) {
          if (!reference.imageUrl) continue;
          const actionPrefix = useFramePreview ? "previz-frame" : "previz-reference";
          assets.push({
            label: reference.token,
            imageUrl: reference.imageUrl,
            actions: activePreviewItems.length
              ? [
                  {
                    label: "←",
                    actionId: `${actionPrefix}-move-left:${reference.referenceId}`,
                    disabled: index === 0,
                  },
                  {
                    label: "→",
                    actionId: `${actionPrefix}-move-right:${reference.referenceId}`,
                    disabled: index === activePreviewItems.length - 1,
                  },
                  {
                    label: "Remove",
                    actionId: `${actionPrefix}-remove:${reference.referenceId}`,
                  },
                ]
              : undefined,
          });
        }
      }
      return assets;
    }
    const workingGeneration =
      activeWorkflowSection === "post" ? mergeTargetGeneration ?? selectedPreviewGeneration : selectedPreviewGeneration;
    const showGeneratedOutputs = activeWorkflowSection === "outputs" || activeWorkflowSection === "post";
    const useGenerationBoundInputs =
      (activeWorkflowSection === "outputs" || activeWorkflowSection === "post") && Boolean(workingGeneration);
    const firstFrameVariantId = useGenerationBoundInputs
      ? workingGeneration?.sourceFirstFrameVariantId ?? null
      : refineStartVariantId || compareStartVariantId;
    const lastFrameVariantId = useGenerationBoundInputs
      ? workingGeneration?.sourceLastFrameVariantId ?? null
      : refineEndVariantId || compareEndVariantId;
    const firstFrameEditUrl = frameVariantImageUrl(editFirstFrameId, firstFrameVariantId);
    const lastFrameEditUrl = generationInputMode === "start_end" ? frameVariantImageUrl(editLastFrameId, lastFrameVariantId) : null;

    if (!isCharacterWorkflow && generationInputMode !== "edit_video" && firstFrameEditUrl) {
      assets.push({ label: "Edited start frame", imageUrl: firstFrameEditUrl });
    }
    if (!isCharacterWorkflow && generationInputMode === "start_end" && lastFrameEditUrl) {
      assets.push({ label: "Edited end frame", imageUrl: lastFrameEditUrl });
    }
    if (isCharacterWorkflow) {
      const selectedCharacter = editVideoReferencePreview[0];
      if (selectedCharacter?.imageUrl) {
        assets.push({
          label: selectedCharacter.token.replace(/^Character \d+$/i, "Character"),
          imageUrl: selectedCharacter.imageUrl,
          actionLabel: "Edit",
          actionId: "edit-video-reference-picker",
        });
      }
      if (sourceMediaKind === "audio" && task?.sourceMedia?.previewSource?.downloadUrl) {
        const sourceFrameCount = task?.sourceMedia?.editSource?.frameCount ?? task?.video?.editSource?.frameCount ?? 0;
        assets.push({
          label: "Source audio",
          audioUrl: task.sourceMedia.previewSource.downloadUrl,
          waveformUrl:
            task.sourceMedia.waveform?.downloadUrl ??
            sourceWaveformUrl ??
            currentReferenceStartImageUrl ??
            currentReferenceEndImageUrl ??
            null,
          rangeStartRatio: sourceFrameCount > 0 && currentReferenceSegment ? currentReferenceSegment.startFrame / sourceFrameCount : null,
          rangeEndRatio: sourceFrameCount > 0 && currentReferenceSegment ? currentReferenceSegment.endFrameExclusive / sourceFrameCount : null,
          rangeStartLabel: currentReferenceSegment?.startTimecode ?? null,
          rangeEndLabel: currentReferenceSegment?.endTimecode ?? null,
        });
      }
    } else if (generationInputMode === "edit_video") {
      for (const reference of editVideoReferencePreview) {
        if (!reference.imageUrl) continue;
        assets.push({
          label: reference.token,
          imageUrl: reference.imageUrl,
          actionLabel: "Edit",
          actionId: "edit-video-reference-picker",
        });
      }
      if (isSourceVideoWorkflowId(workflowId) && task?.generationAudioReference?.previewUrl) {
        assets.push({
          label: "Audio1",
          audioUrl: task.generationAudioReference.previewUrl,
          waveformUrl: task.generationAudioReference.waveformUrl ?? null,
        });
      }
    }

    if (!showGeneratedOutputs) {
      return assets;
    }

    const lineage = buildGenerationLineage(task?.segmentGenerations, workingGeneration);
    const rootGeneration = lineage[0] ?? null;
    const extensionGeneration = [...lineage].reverse().find((generation) => isExtensionGeneration(generation)) ?? null;
    const alignedGeneration = [...lineage].reverse().find((generation) => isAlignedGeneration(generation)) ?? null;
    const cleanupGeneration = [...lineage].reverse().find((generation) => isCleanupGeneration(generation)) ?? null;

    const appendGenerationAsset = (generation: SegmentGeneration | null, label: string, selected: boolean) => {
      if (!generation?.downloadUrl) return;
      assets.push({
        label,
        videoUrl: generation.downloadUrl,
        posterUrl: generationThumbnailUrl(generation),
        actionLabel: selected ? undefined : "Use",
        actionId: selected ? undefined : `select-generation:${generation.genId}`,
        selected,
      });
    };

    if (rootGeneration) {
      appendGenerationAsset(
        rootGeneration,
        "Generated video",
        workingGeneration?.genId === rootGeneration.genId,
      );
    }
    if (activeWorkflowSection === "post" && extensionGeneration && extensionGeneration.genId !== rootGeneration?.genId) {
      appendGenerationAsset(
        extensionGeneration,
        "Extended video",
        workingGeneration?.genId === extensionGeneration.genId && !alignedGeneration && !cleanupGeneration,
      );
    }
    if (
      activeWorkflowSection === "post" &&
      alignedGeneration &&
      alignedGeneration.genId !== extensionGeneration?.genId &&
      alignedGeneration.genId !== rootGeneration?.genId
    ) {
      appendGenerationAsset(
        alignedGeneration,
        "Align video",
        workingGeneration?.genId === alignedGeneration.genId && !cleanupGeneration,
      );
    }
    if (
      activeWorkflowSection === "post" &&
      cleanupGeneration &&
      cleanupGeneration.genId !== alignedGeneration?.genId &&
      cleanupGeneration.genId !== extensionGeneration?.genId &&
      cleanupGeneration.genId !== rootGeneration?.genId
    ) {
      appendGenerationAsset(cleanupGeneration, "Clean-up video", workingGeneration?.genId === cleanupGeneration.genId);
    }
    if (!rootGeneration && workingGeneration?.downloadUrl) {
      appendGenerationAsset(workingGeneration, "Generated video", true);
    }

    return assets;
  }, [
    activeWorkflowSection,
    compareEndVariantId,
    compareStartVariantId,
    editFirstFrameId,
    editLastFrameId,
    editVideoReferencePreview,
    frameVariantImageUrl,
    generationInputMode,
    generationThumbnailUrl,
    mergeTargetGeneration,
    refineEndVariantId,
    refineStartVariantId,
    selectedPreviewGeneration,
    currentReferenceEndImageUrl,
    currentReferenceStartImageUrl,
    sourceMediaKind,
    sourceWaveformUrl,
    currentReferenceSegment,
    task?.segmentGenerations,
    task?.sourceMedia?.editSource?.frameCount,
    task?.sourceMedia?.previewSource?.downloadUrl,
    task?.sourceMedia?.waveform?.downloadUrl,
    task?.video?.editSource?.frameCount,
    task?.generationAudioReference?.previewUrl,
    task?.generationAudioReference?.waveformUrl,
    workflowId,
    previzReferencePreview,
    previzFramePreview,
    isPrevizWorkflow,
  ]);

  const currentReferenceWarning =
    isSourceVideoWorkflowId(workflowId) &&
    sourceMediaKind !== "audio" &&
    wholeVideoNeedsChunking &&
    currentReferenceSegment?.segmentId === defaultVideoSegment?.segmentId
      ? "This video is longer than single-pass generation limit and will require chunking."
      : undefined;

  return {
    currentReferenceSegment,
    currentReferenceStartImageUrl,
    currentReferenceEndImageUrl,
    currentReferenceAssets,
    currentReferenceWarning,
  };
}

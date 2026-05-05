import { useMemo } from "react";

import type { PrimaryWorkflowSection } from "../lib/workflowSections";
import type { GenerateInputMode } from "../lib/generationModeRegistry";
import type { SegmentGeneration, SegmentRecord, TaskDetail } from "../types/api";

type WorkingReferenceAsset = {
  label: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  posterUrl?: string | null;
};

type UseCurrentWorkingReferenceStateArgs = {
  activeWorkflowSection: PrimaryWorkflowSection | null;
  selectedSegment: SegmentRecord | null;
  defaultVideoSegment: SegmentRecord | null;
  task: TaskDetail | undefined;
  selectedPreviewGeneration: SegmentGeneration | null;
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
};

export function useCurrentWorkingReferenceState({
  activeWorkflowSection,
  selectedSegment,
  defaultVideoSegment,
  task,
  selectedPreviewGeneration,
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
}: UseCurrentWorkingReferenceStateArgs) {
  const currentReferenceSegment = selectedSegment ?? defaultVideoSegment ?? null;
  const currentReferenceStartImageUrl = currentReferenceSegment ? task?.frames?.[currentReferenceSegment.startFrameId]?.imageUrl ?? null : null;
  const currentReferenceEndImageUrl = currentReferenceSegment ? task?.frames?.[currentReferenceSegment.endFrameId]?.imageUrl ?? null : null;

  const currentReferenceAssets = useMemo<WorkingReferenceAsset[]>(() => {
    const assets: WorkingReferenceAsset[] = [];
    const useGenerationBoundInputs =
      (activeWorkflowSection === "outputs" || activeWorkflowSection === "post") && Boolean(selectedPreviewGeneration);
    const firstFrameVariantId = useGenerationBoundInputs
      ? selectedPreviewGeneration?.sourceFirstFrameVariantId ?? null
      : refineStartVariantId || compareStartVariantId;
    const lastFrameVariantId = useGenerationBoundInputs
      ? selectedPreviewGeneration?.sourceLastFrameVariantId ?? null
      : refineEndVariantId || compareEndVariantId;
    const firstFrameEditUrl = frameVariantImageUrl(editFirstFrameId, firstFrameVariantId);
    const lastFrameEditUrl = generationInputMode === "start_end" ? frameVariantImageUrl(editLastFrameId, lastFrameVariantId) : null;

    if (firstFrameEditUrl) {
      assets.push({ label: "First frame edit", imageUrl: firstFrameEditUrl });
    }
    if (lastFrameEditUrl) {
      assets.push({ label: "Last frame edit", imageUrl: lastFrameEditUrl });
    }
    if (selectedPreviewGeneration?.downloadUrl) {
      assets.push({
        label: "Generated video",
        videoUrl: selectedPreviewGeneration.downloadUrl,
        posterUrl: generationThumbnailUrl(selectedPreviewGeneration),
      });
    }
    return assets;
  }, [
    activeWorkflowSection,
    compareEndVariantId,
    compareStartVariantId,
    editFirstFrameId,
    editLastFrameId,
    frameVariantImageUrl,
    generationInputMode,
    generationThumbnailUrl,
    refineEndVariantId,
    refineStartVariantId,
    selectedPreviewGeneration,
  ]);

  const currentReferenceWarning =
    wholeVideoNeedsChunking && currentReferenceSegment?.segmentId === defaultVideoSegment?.segmentId
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

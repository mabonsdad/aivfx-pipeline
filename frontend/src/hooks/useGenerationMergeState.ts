import { useEffect, useMemo, useRef, useState } from "react";

import type { GenerateInputMode } from "../lib/generationModeRegistry";
import type { TaskWorkflowId } from "../lib/taskWorkflows";
import type { CharacterAnimateMode } from "../lib/characterAnimate/characterAnimateModeRegistry";
import { getGenerationOrigin, isPostProcessDerivedGeneration, matchesGenerateStepGrid } from "../lib/generationOrigin";
import type { SegmentGeneration, SegmentRecord, TaskDetail } from "../types/api";

type UseGenerationMergeStateParams = {
  task: TaskDetail | undefined;
  selectedSegmentId: string | null;
  segmentsById: Map<string, SegmentRecord>;
  workflowId: TaskWorkflowId;
  activeInputMode: GenerateInputMode;
  activeCharacterMode?: CharacterAnimateMode;
};

function safeTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function generationSortTimestamp(generation: SegmentGeneration): number {
  return safeTimestamp(generation.finishedAt) || safeTimestamp(generation.updatedAt) || safeTimestamp(generation.createdAt);
}

function generationSourceFrameOffset(generation: SegmentGeneration | null | undefined): number {
  if (!generation) return 0;
  return Math.max(
    0,
    Number(
      generation.sourceFrameOffset ??
        generation.alignment?.sourceFrameOffset ??
        generation.generationSettings?.timelineAlignment?.sourceFrameOffset ??
        0,
    ) || 0,
  );
}

function generationStoredOutputFrameCount(generation: SegmentGeneration | null | undefined): number {
  if (!generation) return 0;
  return Math.max(0, Number(generation.generationSettings?.storedOutput?.frameCount ?? 0) || 0);
}

function isCharacterPostProcessDerivedGeneration(generation: SegmentGeneration | null | undefined): boolean {
  return isPostProcessDerivedGeneration(generation);
}

function isPrevizPostProcessDerivedGeneration(generation: SegmentGeneration | null | undefined): boolean {
  return isPostProcessDerivedGeneration(generation);
}

export function useGenerationMergeState({ task, selectedSegmentId, segmentsById, workflowId, activeInputMode, activeCharacterMode }: UseGenerationMergeStateParams) {
  const [selectedGenIds, setSelectedGenIds] = useState<string[]>([]);
  const [selectedPreviewGenId, setSelectedPreviewGenId] = useState<string>("");
  const [previewSelectionCleared, setPreviewSelectionCleared] = useState(false);
  const latestKnownGenerationIdRef = useRef<string | null>(null);
  const [mergeFadeInFrames, setMergeFadeInFrames] = useState(0);
  const [mergeFadeOutFrames, setMergeFadeOutFrames] = useState(0);
  const [mergeSourceRestartFrame, setMergeSourceRestartFrame] = useState(0);
  const [mergeInsertStartFrame, setMergeInsertStartFrame] = useState(0);
  const [mergeTrimStartFrames, setMergeTrimStartFrames] = useState(0);
  const [mergeTrimEndFrames, setMergeTrimEndFrames] = useState(0);
  const [mergeConfiguredGenId, setMergeConfiguredGenId] = useState("");

  const filterBySelectedSegment = !(workflowId === "source_video_flow" && activeInputMode === "edit_video");
  const segmentGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {})
        .sort((a, b) => generationSortTimestamp(b) - generationSortTimestamp(a)),
    [task?.segmentGenerations],
  );

  const selectedSegmentGenerations = useMemo(
    () =>
      segmentGenerations
        .filter(
          (gen) =>
            (gen.status === "complete" ? Boolean(gen.outputKey) : gen.status === "failed") &&
            matchesGenerateStepGrid(gen, {
              task,
              workflowId,
              activeInputMode,
              activeCharacterMode,
              selectedSegmentId,
              filterBySelectedSegment,
            }) &&
            !(
              workflowId === "character_animate_workflow"
                ? isCharacterPostProcessDerivedGeneration(gen)
                : workflowId === "simple_generation_workflow"
                  ? isPrevizPostProcessDerivedGeneration(gen)
                  : getGenerationOrigin(gen, task)?.stepOrigin === "post_process"
            ),
        )
        .sort((a, b) => generationSortTimestamp(b) - generationSortTimestamp(a)),
    [activeCharacterMode, activeInputMode, filterBySelectedSegment, segmentGenerations, selectedSegmentId, task, workflowId],
  );

  const selectedSegmentCompleteGenerations = useMemo(
    () => selectedSegmentGenerations.filter((generation) => generation.status === "complete" && Boolean(generation.outputKey)),
    [selectedSegmentGenerations],
  );

  const selectedMergeGenerations = useMemo(
    () =>
      selectedGenIds
        .map((genId) => task?.segmentGenerations?.[genId])
        .filter((generation): generation is SegmentGeneration => {
          if (!generation) return false;
          return generation.status === "complete" && Boolean(generation.outputKey);
        })
        .sort((a, b) => generationSortTimestamp(b) - generationSortTimestamp(a)),
    [selectedGenIds, task?.segmentGenerations],
  );

  const selectedPreviewGeneration =
    selectedSegmentCompleteGenerations.find((gen) => gen.genId === selectedPreviewGenId) ??
    (!previewSelectionCleared ? selectedSegmentCompleteGenerations[0] ?? null : null);

  const sortedExports = useMemo(
    () =>
      [...(task?.exports ?? [])]
        .filter((item) => !item.internalOnlySource)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [task?.exports],
  );

  const mergeTargetGeneration = selectedMergeGenerations[0] ?? null;
  const mergeTargetSegment = mergeTargetGeneration ? segmentsById.get(mergeTargetGeneration.segmentId) ?? null : null;

  useEffect(() => {
    setSelectedGenIds((previous) => {
      const filtered = previous.filter((genId) => {
        const generation = task?.segmentGenerations?.[genId];
        return Boolean(generation && generation.status !== "failed");
      });
      return filtered.length === previous.length ? previous : filtered;
    });
  }, [task?.segmentGenerations]);

  useEffect(() => {
    if (!selectedSegmentGenerations.length) {
      setSelectedPreviewGenId("");
      setPreviewSelectionCleared(false);
      latestKnownGenerationIdRef.current = null;
      return;
    }
    const newestGenerationId = selectedSegmentCompleteGenerations[0]?.genId ?? "";
    const newestGenerationChanged = Boolean(newestGenerationId && newestGenerationId !== latestKnownGenerationIdRef.current);
    latestKnownGenerationIdRef.current = newestGenerationId || null;
    if (newestGenerationChanged) {
      setSelectedPreviewGenId(newestGenerationId);
      setPreviewSelectionCleared(false);
      return;
    }
    if (previewSelectionCleared) {
      return;
    }
    const stillValid = selectedSegmentCompleteGenerations.some((gen) => gen.genId === selectedPreviewGenId);
    if (!stillValid) {
      setSelectedPreviewGenId(selectedSegmentCompleteGenerations[0]?.genId ?? "");
    }
  }, [previewSelectionCleared, selectedPreviewGenId, selectedSegmentCompleteGenerations, selectedSegmentGenerations]);

  useEffect(() => {
    const selectedId = selectedPreviewGeneration?.genId;
    if (!selectedId) {
      setSelectedGenIds([]);
      return;
    }
    setSelectedGenIds((previous) => (previous.length === 1 && previous[0] === selectedId ? previous : [selectedId]));
  }, [selectedPreviewGeneration?.genId, task?.segmentGenerations]);

  useEffect(() => {
    const generationId = mergeTargetGeneration?.genId ?? "";
    if (!generationId) {
      setMergeConfiguredGenId("");
      return;
    }
    if (generationId === mergeConfiguredGenId) return;
    setMergeConfiguredGenId(generationId);
    const sourceFrameOffset = generationSourceFrameOffset(mergeTargetGeneration);
    const segmentDurationFrames = Math.max(
      1,
      Number(mergeTargetSegment?.durationFrames ?? Math.max(1, (mergeTargetSegment?.endFrameExclusive ?? 1) - (mergeTargetSegment?.startFrame ?? 0))) || 1,
    );
    const storedOutputFrameCount = generationStoredOutputFrameCount(mergeTargetGeneration);
    const defaultTrimEndFrames = storedOutputFrameCount > 0 ? Math.max(0, storedOutputFrameCount - Math.max(1, segmentDurationFrames - sourceFrameOffset)) : 0;
    setMergeInsertStartFrame(sourceFrameOffset);
    setMergeTrimStartFrames(0);
    setMergeTrimEndFrames(defaultTrimEndFrames);
    setMergeFadeInFrames(0);
    setMergeFadeOutFrames(0);
    setMergeSourceRestartFrame(intOrFallback(mergeTargetSegment?.endFrameExclusive, intOrFallback(mergeTargetSegment?.startFrame, 0) + segmentDurationFrames));
  }, [mergeConfiguredGenId, mergeTargetGeneration, mergeTargetGeneration?.genId, mergeTargetSegment]);

  function selectSegmentGeneration(genId: string) {
    const selectedGeneration = task?.segmentGenerations?.[genId];
    if (!selectedGeneration || selectedGeneration.status === "failed") return;
    const canUseForMerge = selectedGeneration.status === "complete" && Boolean(selectedGeneration.outputKey);
    if (canUseForMerge && selectedPreviewGenId === genId && !previewSelectionCleared) {
      setSelectedPreviewGenId("");
      setPreviewSelectionCleared(true);
      setSelectedGenIds((previous) => previous.filter((existingGenId) => existingGenId !== genId));
      return;
    }
    if (canUseForMerge) {
      setSelectedPreviewGenId(genId);
      setPreviewSelectionCleared(false);
    }
    setSelectedGenIds((previous) => {
      if (!canUseForMerge) {
        return previous;
      }
      const targetSegmentId = selectedGeneration?.segmentId;
      const filtered = previous.filter((existingGenId) => {
        if (existingGenId === genId) return false;
        if (!targetSegmentId) return true;
        const existing = task?.segmentGenerations?.[existingGenId];
        return existing?.segmentId !== targetSegmentId && existing?.status !== "failed";
      });
      return [genId, ...filtered];
    });
  }

  return {
    selectedGenIds,
    setSelectedGenIds,
    selectedPreviewGenId,
    setSelectedPreviewGenId,
    mergeFadeInFrames,
    setMergeFadeInFrames,
    mergeFadeOutFrames,
    setMergeFadeOutFrames,
    mergeSourceRestartFrame,
    setMergeSourceRestartFrame,
    mergeInsertStartFrame,
    setMergeInsertStartFrame,
    mergeTrimStartFrames,
    setMergeTrimStartFrames,
    mergeTrimEndFrames,
    setMergeTrimEndFrames,
    segmentGenerations,
    selectedSegmentGenerations,
    selectedMergeGenerations,
    selectedPreviewGeneration,
    sortedExports,
    mergeTargetGeneration,
    mergeTargetSegment,
    selectSegmentGeneration,
  };
}

function intOrFallback(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(numeric);
}

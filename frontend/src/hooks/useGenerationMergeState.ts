import { useEffect, useMemo, useState } from "react";

import type { SegmentGeneration, SegmentRecord, TaskDetail } from "../types/api";

type UseGenerationMergeStateParams = {
  task: TaskDetail | undefined;
  selectedSegmentId: string | null;
  segmentsById: Map<string, SegmentRecord>;
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

export function useGenerationMergeState({ task, selectedSegmentId, segmentsById }: UseGenerationMergeStateParams) {
  const [selectedGenIds, setSelectedGenIds] = useState<string[]>([]);
  const [selectedPreviewGenId, setSelectedPreviewGenId] = useState<string>("");
  const [mergeFadeInFrames, setMergeFadeInFrames] = useState(0);
  const [mergeFadeOutFrames, setMergeFadeOutFrames] = useState(0);
  const [mergeSourceRestartFrame, setMergeSourceRestartFrame] = useState(0);
  const [mergeInsertStartFrame, setMergeInsertStartFrame] = useState(0);
  const [mergeTrimStartFrames, setMergeTrimStartFrames] = useState(0);
  const [mergeTrimEndFrames, setMergeTrimEndFrames] = useState(0);
  const [mergeConfiguredGenId, setMergeConfiguredGenId] = useState("");

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
            (!selectedSegmentId || gen.segmentId === selectedSegmentId) &&
            gen.status === "complete" &&
            Boolean(gen.outputKey) &&
            !gen.isChunkInternal,
        )
        .sort((a, b) => generationSortTimestamp(b) - generationSortTimestamp(a)),
    [segmentGenerations, selectedSegmentId],
  );

  const selectedSegmentCompleteGenerations = selectedSegmentGenerations;

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
    selectedSegmentCompleteGenerations[0] ??
    null;

  const sortedExports = useMemo(
    () => [...(task?.exports ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
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
      return;
    }
    const stillValid = selectedSegmentCompleteGenerations.some((gen) => gen.genId === selectedPreviewGenId);
    if (!stillValid) {
      setSelectedPreviewGenId(selectedSegmentCompleteGenerations[0]?.genId ?? "");
    }
  }, [selectedPreviewGenId, selectedSegmentCompleteGenerations, selectedSegmentGenerations]);

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
    if (canUseForMerge) {
      setSelectedPreviewGenId(genId);
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

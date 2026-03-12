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

export function useGenerationMergeState({ task, selectedSegmentId, segmentsById }: UseGenerationMergeStateParams) {
  const [selectedGenIds, setSelectedGenIds] = useState<string[]>([]);
  const [selectedPreviewGenId, setSelectedPreviewGenId] = useState<string>("");
  const [temporalFeatherFrames, setTemporalFeatherFrames] = useState(0);
  const [mergeInsertStartFrame, setMergeInsertStartFrame] = useState(0);
  const [mergeTrimStartFrames, setMergeTrimStartFrames] = useState(0);
  const [mergeTrimEndFrames, setMergeTrimEndFrames] = useState(0);
  const [mergeConfiguredGenId, setMergeConfiguredGenId] = useState("");

  const segmentGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {})
        .filter((generation) => generation.status !== "failed")
        .sort((a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt)),
    [task?.segmentGenerations],
  );

  const selectedSegmentGenerations = useMemo(
    () =>
      segmentGenerations
        .filter((gen) => !selectedSegmentId || gen.segmentId === selectedSegmentId)
        .sort((a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt)),
    [segmentGenerations, selectedSegmentId],
  );

  const selectedSegmentCompleteGenerations = useMemo(
    () =>
      selectedSegmentGenerations.filter(
        (generation) => generation.status === "complete" && Boolean(generation.outputKey),
      ),
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
        .sort((a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt)),
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
    setSelectedGenIds([selectedId]);
  }, [selectedPreviewGeneration?.genId, task?.segmentGenerations]);

  useEffect(() => {
    const generationId = mergeTargetGeneration?.genId ?? "";
    if (!generationId) {
      setMergeConfiguredGenId("");
      return;
    }
    if (generationId === mergeConfiguredGenId) return;
    setMergeConfiguredGenId(generationId);
    setMergeInsertStartFrame(mergeTargetSegment?.startFrame ?? 0);
    setMergeTrimStartFrames(0);
    setMergeTrimEndFrames(0);
  }, [mergeConfiguredGenId, mergeTargetGeneration?.genId, mergeTargetSegment?.startFrame]);

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
    temporalFeatherFrames,
    setTemporalFeatherFrames,
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

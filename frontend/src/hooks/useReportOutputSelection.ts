import { useCallback, useMemo, useState } from "react";

import type { CustomReportOutputRef } from "../types/api";

export type SelectedReportOutputs = Record<string, { taskId: string; ref: CustomReportOutputRef }>;

export function reportOutputRefKey(ref: CustomReportOutputRef): string {
  if (ref.assetType === "segment_generation") {
    return `segment_generation:${ref.genId}`;
  }
  if (ref.assetType === "export") {
    return `export:${ref.exportId}`;
  }
  if (ref.assetType === "external_frame_pair") {
    return `external_frame_pair:${ref.pairId}`;
  }
  return `frame_variant:${ref.frameId}:${ref.variantId}`;
}

export function useReportOutputSelection() {
  const [selectedReportOutputs, setSelectedReportOutputs] = useState<SelectedReportOutputs>({});

  const selectedOutputRefsByTask = useMemo(() => {
    const grouped: Record<string, CustomReportOutputRef[]> = {};
    for (const item of Object.values(selectedReportOutputs)) {
      if (!grouped[item.taskId]) {
        grouped[item.taskId] = [];
      }
      grouped[item.taskId].push(item.ref);
    }
    return grouped;
  }, [selectedReportOutputs]);

  const toggleCustomReportOutput = useCallback((taskId: string, ref: CustomReportOutputRef) => {
    const key = `${taskId}:${reportOutputRefKey(ref)}`;
    setSelectedReportOutputs((previous) => {
      if (previous[key]) {
        const next = { ...previous };
        delete next[key];
        return next;
      }
      return { ...previous, [key]: { taskId, ref } };
    });
  }, []);

  const clearCustomReportOutputs = useCallback((taskId: string, refs?: CustomReportOutputRef[]) => {
    setSelectedReportOutputs((previous) => {
      if (!Object.keys(previous).length) return previous;
      if (!refs?.length) {
        const next = { ...previous };
        for (const key of Object.keys(next)) {
          if (next[key]?.taskId === taskId) {
            delete next[key];
          }
        }
        return next;
      }
      const keysToDelete = new Set(refs.map((ref) => `${taskId}:${reportOutputRefKey(ref)}`));
      const next = { ...previous };
      let changed = false;
      for (const key of keysToDelete) {
        if (next[key]) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, []);

  return {
    selectedReportOutputs,
    selectedOutputRefsByTask,
    reportOutputRefKey,
    toggleCustomReportOutput,
    clearCustomReportOutputs,
  };
}

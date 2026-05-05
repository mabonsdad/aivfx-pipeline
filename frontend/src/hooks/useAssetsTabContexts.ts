import { useMemo } from "react";

import type { AssetsTabCtx } from "../pages/workflow/AssetsTab";
import type { CustomReportOutputRef, TaskDetail } from "../types/api";
import type { LibraryAsset } from "../types/libraryAsset";

type VisibilitySetter = (update: number | ((count: number) => number)) => void;

type UseAssetsTabContextsArgs = {
  selectedTaskId: string | null;
  task: TaskDetail | undefined;
  assetsLoading: boolean;
  assetLibraryLoading: boolean;
  mergedVideoAssets: LibraryAsset[];
  mergedAssetsVisible: number;
  setMergedAssetsVisible: VisibilitySetter;
  generatedVideoAssets: LibraryAsset[];
  generatedAssetsVisible: number;
  setGeneratedAssetsVisible: VisibilitySetter;
  editedFrameAssets: LibraryAsset[];
  editedFrameAssetsVisible: number;
  setEditedFrameAssetsVisible: VisibilitySetter;
  libraryMergedVideoAssets: LibraryAsset[];
  libraryMergedAssetsVisible: number;
  setLibraryMergedAssetsVisible: VisibilitySetter;
  libraryGeneratedVideoAssets: LibraryAsset[];
  libraryGeneratedAssetsVisible: number;
  setLibraryGeneratedAssetsVisible: VisibilitySetter;
  libraryEditedFrameAssets: LibraryAsset[];
  libraryEditedFrameAssetsVisible: number;
  setLibraryEditedFrameAssetsVisible: VisibilitySetter;
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: AssetsTabCtx["reportOutputRefKey"];
  toggleCustomReportOutput: AssetsTabCtx["toggleCustomReportOutput"];
  clearCustomReportOutputs: AssetsTabCtx["clearCustomReportOutputs"];
  handleDeleteAsset: AssetsTabCtx["handleDeleteAsset"];
  createCustomReport: AssetsTabCtx["createCustomReport"];
  isCreatingCustomReport: boolean;
  formatAssetDate: AssetsTabCtx["formatAssetDate"];
  goToReport: (taskId: string) => void;
};

export function useAssetsTabContexts({
  selectedTaskId,
  task,
  assetsLoading,
  assetLibraryLoading,
  mergedVideoAssets,
  mergedAssetsVisible,
  setMergedAssetsVisible,
  generatedVideoAssets,
  generatedAssetsVisible,
  setGeneratedAssetsVisible,
  editedFrameAssets,
  editedFrameAssetsVisible,
  setEditedFrameAssetsVisible,
  libraryMergedVideoAssets,
  libraryMergedAssetsVisible,
  setLibraryMergedAssetsVisible,
  libraryGeneratedVideoAssets,
  libraryGeneratedAssetsVisible,
  setLibraryGeneratedAssetsVisible,
  libraryEditedFrameAssets,
  libraryEditedFrameAssetsVisible,
  setLibraryEditedFrameAssetsVisible,
  selectedReportOutputs,
  reportOutputRefKey,
  toggleCustomReportOutput,
  clearCustomReportOutputs,
  handleDeleteAsset,
  createCustomReport,
  isCreatingCustomReport,
  formatAssetDate,
  goToReport,
}: UseAssetsTabContextsArgs) {
  const assetsTabCtx = useMemo<AssetsTabCtx>(
    () => ({
      selectedTaskId,
      task,
      assetsLoading,
      mergedVideoAssets,
      mergedAssetsVisible,
      setMergedAssetsVisible,
      generatedVideoAssets,
      generatedAssetsVisible,
      setGeneratedAssetsVisible,
      editedFrameAssets,
      editedFrameAssetsVisible,
      setEditedFrameAssetsVisible,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      clearCustomReportOutputs,
      handleDeleteAsset,
      createCustomReport,
      isCreatingCustomReport,
      formatAssetDate,
      onNext: () => {
        if (selectedTaskId) {
          goToReport(selectedTaskId);
        }
      },
      nextDisabled: !selectedTaskId,
      nextWarning: !selectedTaskId ? "Select a task before opening reports." : null,
    }),
    [
      assetsLoading,
      clearCustomReportOutputs,
      createCustomReport,
      editedFrameAssets,
      editedFrameAssetsVisible,
      formatAssetDate,
      generatedAssetsVisible,
      generatedVideoAssets,
      goToReport,
      handleDeleteAsset,
      isCreatingCustomReport,
      mergedAssetsVisible,
      mergedVideoAssets,
      reportOutputRefKey,
      selectedReportOutputs,
      selectedTaskId,
      setEditedFrameAssetsVisible,
      setGeneratedAssetsVisible,
      setMergedAssetsVisible,
      task,
      toggleCustomReportOutput,
    ],
  );

  const assetLibraryTabCtx = useMemo<AssetsTabCtx>(
    () => ({
      selectedTaskId,
      task,
      assetsLoading: assetLibraryLoading,
      pageTitle: "Asset Library",
      pageDescription: "Latest merged videos, generated videos, and edited frames across all source videos for this account.",
      showNext: false,
      mergedVideoAssets: libraryMergedVideoAssets,
      mergedAssetsVisible: libraryMergedAssetsVisible,
      setMergedAssetsVisible: setLibraryMergedAssetsVisible,
      generatedVideoAssets: libraryGeneratedVideoAssets,
      generatedAssetsVisible: libraryGeneratedAssetsVisible,
      setGeneratedAssetsVisible: setLibraryGeneratedAssetsVisible,
      editedFrameAssets: libraryEditedFrameAssets,
      editedFrameAssetsVisible: libraryEditedFrameAssetsVisible,
      setEditedFrameAssetsVisible: setLibraryEditedFrameAssetsVisible,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      clearCustomReportOutputs,
      handleDeleteAsset,
      createCustomReport,
      isCreatingCustomReport,
      formatAssetDate,
      onNext: () => undefined,
      nextDisabled: true,
      nextWarning: null,
    }),
    [
      assetLibraryLoading,
      clearCustomReportOutputs,
      createCustomReport,
      formatAssetDate,
      handleDeleteAsset,
      isCreatingCustomReport,
      libraryEditedFrameAssets,
      libraryEditedFrameAssetsVisible,
      libraryGeneratedAssetsVisible,
      libraryGeneratedVideoAssets,
      libraryMergedAssetsVisible,
      libraryMergedVideoAssets,
      reportOutputRefKey,
      selectedReportOutputs,
      selectedTaskId,
      setLibraryEditedFrameAssetsVisible,
      setLibraryGeneratedAssetsVisible,
      setLibraryMergedAssetsVisible,
      task,
      toggleCustomReportOutput,
    ],
  );

  return { assetsTabCtx, assetLibraryTabCtx };
}

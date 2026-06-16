import { useMemo } from "react";

import type { AssetsTabCtx } from "../pages/workflow/AssetsTab";
import type { CustomReportOutputRef, TaskDetail } from "../types/api";
import type { LibraryAsset } from "../types/libraryAsset";

type VisibilitySetter = (update: number | ((count: number) => number)) => void;

type UseAssetsTabContextsArgs = {
  selectedTaskId: string | null;
  task: TaskDetail | undefined;
  assetLibraryScope?: "mine" | "all";
  assetsLoading: boolean;
  assetLibraryLoading: boolean;
  mergedVideoAssets: LibraryAsset[];
  mergedAssetsVisible: number;
  setMergedAssetsVisible: VisibilitySetter;
  generatedVideoAssets: LibraryAsset[];
  generatedAssetsVisible: number;
  setGeneratedAssetsVisible: VisibilitySetter;
  postProcessVideoAssets: LibraryAsset[];
  postProcessAssetsVisible: number;
  setPostProcessAssetsVisible: VisibilitySetter;
  editedFrameAssets: LibraryAsset[];
  editedFrameAssetsVisible: number;
  setEditedFrameAssetsVisible: VisibilitySetter;
  referenceImageAssets: LibraryAsset[];
  referenceImageAssetsVisible: number;
  setReferenceImageAssetsVisible: VisibilitySetter;
  orphanedAssets: LibraryAsset[];
  orphanedAssetsVisible: number;
  setOrphanedAssetsVisible: VisibilitySetter;
  audioAssets: LibraryAsset[];
  audioAssetsVisible: number;
  setAudioAssetsVisible: VisibilitySetter;
  libraryMergedVideoAssets: LibraryAsset[];
  libraryMergedAssetsVisible: number;
  setLibraryMergedAssetsVisible: VisibilitySetter;
  libraryGeneratedVideoAssets: LibraryAsset[];
  libraryGeneratedAssetsVisible: number;
  setLibraryGeneratedAssetsVisible: VisibilitySetter;
  libraryPostProcessVideoAssets: LibraryAsset[];
  libraryPostProcessAssetsVisible: number;
  setLibraryPostProcessAssetsVisible: VisibilitySetter;
  libraryEditedFrameAssets: LibraryAsset[];
  libraryEditedFrameAssetsVisible: number;
  setLibraryEditedFrameAssetsVisible: VisibilitySetter;
  libraryReferenceImageAssets: LibraryAsset[];
  libraryReferenceImageAssetsVisible: number;
  setLibraryReferenceImageAssetsVisible: VisibilitySetter;
  libraryOrphanedAssets: LibraryAsset[];
  libraryOrphanedAssetsVisible: number;
  setLibraryOrphanedAssetsVisible: VisibilitySetter;
  libraryAudioAssets: LibraryAsset[];
  libraryAudioAssetsVisible: number;
  setLibraryAudioAssetsVisible: VisibilitySetter;
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: AssetsTabCtx["reportOutputRefKey"];
  toggleCustomReportOutput: AssetsTabCtx["toggleCustomReportOutput"];
  clearCustomReportOutputs: AssetsTabCtx["clearCustomReportOutputs"];
  handleDeleteAsset: AssetsTabCtx["handleDeleteAsset"];
  previewImage: NonNullable<AssetsTabCtx["previewImage"]>;
  createCustomReport: AssetsTabCtx["createCustomReport"];
  isCreatingCustomReport: boolean;
  formatAssetDate: AssetsTabCtx["formatAssetDate"];
  goToReport: (taskId: string) => void;
};

export function useAssetsTabContexts({
  selectedTaskId,
  task,
  assetLibraryScope = "mine",
  assetsLoading,
  assetLibraryLoading,
  mergedVideoAssets,
  mergedAssetsVisible,
  setMergedAssetsVisible,
  generatedVideoAssets,
  generatedAssetsVisible,
  setGeneratedAssetsVisible,
  postProcessVideoAssets,
  postProcessAssetsVisible,
  setPostProcessAssetsVisible,
  editedFrameAssets,
  editedFrameAssetsVisible,
  setEditedFrameAssetsVisible,
  referenceImageAssets,
  referenceImageAssetsVisible,
  setReferenceImageAssetsVisible,
  orphanedAssets,
  orphanedAssetsVisible,
  setOrphanedAssetsVisible,
  audioAssets,
  audioAssetsVisible,
  setAudioAssetsVisible,
  libraryMergedVideoAssets,
  libraryMergedAssetsVisible,
  setLibraryMergedAssetsVisible,
  libraryGeneratedVideoAssets,
  libraryGeneratedAssetsVisible,
  setLibraryGeneratedAssetsVisible,
  libraryPostProcessVideoAssets,
  libraryPostProcessAssetsVisible,
  setLibraryPostProcessAssetsVisible,
  libraryEditedFrameAssets,
  libraryEditedFrameAssetsVisible,
  setLibraryEditedFrameAssetsVisible,
  libraryReferenceImageAssets,
  libraryReferenceImageAssetsVisible,
  setLibraryReferenceImageAssetsVisible,
  libraryOrphanedAssets,
  libraryOrphanedAssetsVisible,
  setLibraryOrphanedAssetsVisible,
  libraryAudioAssets,
  libraryAudioAssetsVisible,
  setLibraryAudioAssetsVisible,
  selectedReportOutputs,
  reportOutputRefKey,
  toggleCustomReportOutput,
  clearCustomReportOutputs,
  handleDeleteAsset,
  previewImage,
  createCustomReport,
  isCreatingCustomReport,
  formatAssetDate,
  goToReport,
}: UseAssetsTabContextsArgs) {
  const isCharacterWorkflow = task?.workflowId === "character_animate_workflow";
  const isPrevizWorkflow = task?.workflowId === "simple_generation_workflow";
  const imageAssetsTitle = isCharacterWorkflow ? "Characters" : isPrevizWorkflow ? "Generated Frames" : "Edited Frames";
  const taskImageAssets = isCharacterWorkflow ? referenceImageAssets : editedFrameAssets;
  const libraryImageAssets = isCharacterWorkflow ? libraryReferenceImageAssets : libraryEditedFrameAssets;
  const secondaryImageAssetsTitle = isPrevizWorkflow ? "Scene References / Sheets" : undefined;
  const assetsTabCtx = useMemo<AssetsTabCtx>(
    () => ({
      selectedTaskId,
      task,
      workflowId: task?.workflowId,
      assetsLoading,
      imageAssetsTitle,
      secondaryImageAssetsTitle,
      mergedVideoAssets,
      mergedAssetsVisible,
      setMergedAssetsVisible,
      generatedVideoAssets,
      generatedAssetsVisible,
      setGeneratedAssetsVisible,
      postProcessVideoAssets,
      postProcessAssetsVisible,
      setPostProcessAssetsVisible,
      editedFrameAssets: taskImageAssets,
      editedFrameAssetsVisible,
      setEditedFrameAssetsVisible,
      secondaryImageAssets: isPrevizWorkflow ? referenceImageAssets : undefined,
      secondaryImageAssetsVisible: isPrevizWorkflow ? referenceImageAssetsVisible : undefined,
      setSecondaryImageAssetsVisible: isPrevizWorkflow ? setReferenceImageAssetsVisible : undefined,
      orphanedAssets,
      orphanedAssetsVisible,
      setOrphanedAssetsVisible,
      audioAssets,
      audioAssetsVisible,
      setAudioAssetsVisible,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      clearCustomReportOutputs,
      handleDeleteAsset,
      previewImage,
      createCustomReport,
      isCreatingCustomReport,
      allowMergedVideoReports: !isPrevizWorkflow,
      allowGeneratedVideoReports: true,
      allowImageReports: !isPrevizWorkflow,
      allowReportSelection: true,
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
      audioAssets,
      audioAssetsVisible,
      clearCustomReportOutputs,
      createCustomReport,
      formatAssetDate,
      generatedVideoAssets,
      generatedAssetsVisible,
      goToReport,
      handleDeleteAsset,
      imageAssetsTitle,
      isPrevizWorkflow,
      isCreatingCustomReport,
      orphanedAssets,
      orphanedAssetsVisible,
      mergedAssetsVisible,
      mergedVideoAssets,
      postProcessAssetsVisible,
      postProcessVideoAssets,
      previewImage,
      referenceImageAssets,
      referenceImageAssetsVisible,
      reportOutputRefKey,
      selectedReportOutputs,
      selectedTaskId,
      setAudioAssetsVisible,
      editedFrameAssetsVisible,
      setEditedFrameAssetsVisible,
      setGeneratedAssetsVisible,
      setMergedAssetsVisible,
      setOrphanedAssetsVisible,
      setPostProcessAssetsVisible,
      setReferenceImageAssetsVisible,
      secondaryImageAssetsTitle,
      taskImageAssets,
      task,
      toggleCustomReportOutput,
    ],
  );

  const assetLibraryTabCtx = useMemo<AssetsTabCtx>(
    () => ({
      selectedTaskId,
      task,
      workflowId: task?.workflowId,
      assetsLoading: assetLibraryLoading,
      pageTitle: assetLibraryScope === "all" ? "All Assets" : "Asset Library",
      pageDescription:
        assetLibraryScope === "all"
          ? "Admin view across all users."
          : "Latest merged videos, generated videos, image assets, and audio assets across all tasks for this account.",
      showNext: false,
      imageAssetsTitle,
      secondaryImageAssetsTitle,
      mergedVideoAssets: libraryMergedVideoAssets,
      mergedAssetsVisible: libraryMergedAssetsVisible,
      setMergedAssetsVisible: setLibraryMergedAssetsVisible,
      generatedVideoAssets: libraryGeneratedVideoAssets,
      generatedAssetsVisible: libraryGeneratedAssetsVisible,
      setGeneratedAssetsVisible: setLibraryGeneratedAssetsVisible,
      postProcessVideoAssets: libraryPostProcessVideoAssets,
      postProcessAssetsVisible: libraryPostProcessAssetsVisible,
      setPostProcessAssetsVisible: setLibraryPostProcessAssetsVisible,
      editedFrameAssets: libraryImageAssets,
      editedFrameAssetsVisible: libraryEditedFrameAssetsVisible,
      setEditedFrameAssetsVisible: setLibraryEditedFrameAssetsVisible,
      secondaryImageAssets: isPrevizWorkflow ? libraryReferenceImageAssets : undefined,
      secondaryImageAssetsVisible: isPrevizWorkflow ? libraryReferenceImageAssetsVisible : undefined,
      setSecondaryImageAssetsVisible: isPrevizWorkflow ? setLibraryReferenceImageAssetsVisible : undefined,
      orphanedAssets: libraryOrphanedAssets,
      orphanedAssetsVisible: libraryOrphanedAssetsVisible,
      setOrphanedAssetsVisible: setLibraryOrphanedAssetsVisible,
      audioAssets: libraryAudioAssets,
      audioAssetsVisible: libraryAudioAssetsVisible,
      setAudioAssetsVisible: setLibraryAudioAssetsVisible,
      selectedReportOutputs,
      reportOutputRefKey,
      toggleCustomReportOutput,
      clearCustomReportOutputs,
      handleDeleteAsset,
      previewImage,
      createCustomReport,
      isCreatingCustomReport,
      allowMergedVideoReports: !isPrevizWorkflow,
      allowGeneratedVideoReports: assetLibraryScope !== "all",
      allowImageReports: assetLibraryScope !== "all" && !isPrevizWorkflow,
      allowReportSelection: assetLibraryScope !== "all",
      formatAssetDate,
      onNext: () => undefined,
      nextDisabled: true,
      nextWarning: null,
      hideDeleteActions: false,
    }),
    [
      assetLibraryScope,
      assetLibraryLoading,
      imageAssetsTitle,
      libraryAudioAssets,
      libraryAudioAssetsVisible,
      clearCustomReportOutputs,
      createCustomReport,
      formatAssetDate,
      handleDeleteAsset,
      isCreatingCustomReport,
      libraryEditedFrameAssetsVisible,
      libraryGeneratedAssetsVisible,
      libraryGeneratedVideoAssets,
      libraryImageAssets,
      libraryOrphanedAssets,
      libraryOrphanedAssetsVisible,
      libraryPostProcessAssetsVisible,
      libraryPostProcessVideoAssets,
      libraryReferenceImageAssets,
      libraryReferenceImageAssetsVisible,
      libraryMergedAssetsVisible,
      libraryMergedVideoAssets,
      previewImage,
      reportOutputRefKey,
      selectedReportOutputs,
      selectedTaskId,
      setLibraryAudioAssetsVisible,
      setLibraryEditedFrameAssetsVisible,
      setLibraryGeneratedAssetsVisible,
      setLibraryMergedAssetsVisible,
      setLibraryOrphanedAssetsVisible,
      setLibraryPostProcessAssetsVisible,
      setLibraryReferenceImageAssetsVisible,
      secondaryImageAssetsTitle,
      task,
      toggleCustomReportOutput,
      isPrevizWorkflow,
    ],
  );

  return { assetsTabCtx, assetLibraryTabCtx };
}

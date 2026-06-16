import { useEffect, useMemo, useState } from "react";

import { DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import { FRAME_TEST_OPTIONS, VIDEO_COMPARE_TEST_OPTIONS, VIDEO_TEST_OPTIONS } from "../../components/reports/QcReportShared";
import type { CustomReportOutputRef, TaskDetail } from "../../types/api";
import type { LibraryAsset } from "../../types/libraryAsset";

type AssetReportGroup = "merged_videos" | "generated_videos" | "post_process_videos" | "edited_frames";
type ReportType = "qc_frame" | "qc_video" | "video_compare" | "previz_review";

type ReportTypeOption = {
  type: ReportType;
  label: string;
  description: string;
};

type CreateReportModalState = {
  group: AssetReportGroup;
};

export type AssetsTabCtx = {
  selectedTaskId: string | null;
  task: TaskDetail | undefined;
  workflowId?: string;
  assetsLoading: boolean;
  pageTitle?: string;
  pageDescription?: string | null;
  showNext?: boolean;
  imageAssetsTitle?: string;
  secondaryImageAssetsTitle?: string;
  mergedVideoAssets: LibraryAsset[];
  mergedAssetsVisible: number;
  setMergedAssetsVisible: (update: number | ((count: number) => number)) => void;
  generatedVideoAssets: LibraryAsset[];
  generatedAssetsVisible: number;
  setGeneratedAssetsVisible: (update: number | ((count: number) => number)) => void;
  postProcessVideoAssets?: LibraryAsset[];
  postProcessAssetsVisible?: number;
  setPostProcessAssetsVisible?: (update: number | ((count: number) => number)) => void;
  editedFrameAssets: LibraryAsset[];
  editedFrameAssetsVisible: number;
  setEditedFrameAssetsVisible: (update: number | ((count: number) => number)) => void;
  secondaryImageAssets?: LibraryAsset[];
  secondaryImageAssetsVisible?: number;
  setSecondaryImageAssetsVisible?: (update: number | ((count: number) => number)) => void;
  orphanedAssets?: LibraryAsset[];
  orphanedAssetsVisible?: number;
  setOrphanedAssetsVisible?: (update: number | ((count: number) => number)) => void;
  audioAssets?: LibraryAsset[];
  audioAssetsVisible?: number;
  setAudioAssetsVisible?: (update: number | ((count: number) => number)) => void;
  formatAssetDate: (iso: string) => string;
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  clearCustomReportOutputs: (taskId: string, refs?: CustomReportOutputRef[]) => void;
  handleDeleteAsset: (item: LibraryAsset) => Promise<void>;
  previewImage?: (payload: { url: string; label: string }) => void;
  createCustomReport: (payload: {
    taskId: string;
    reportType: ReportType;
    tests: string[];
    outputRefs: CustomReportOutputRef[];
    name?: string;
  }) => Promise<{ reportId: string }>;
  isCreatingCustomReport: boolean;
  allowMergedVideoReports?: boolean;
  allowGeneratedVideoReports?: boolean;
  allowImageReports?: boolean;
  allowReportSelection?: boolean;
  onNext: () => void;
  nextDisabled: boolean;
  nextWarning: string | null;
  hideDeleteActions?: boolean;
};

type AssetsTabProps = {
  ctx: AssetsTabCtx;
};

function selectionKey(taskId: string, ref: CustomReportOutputRef, reportOutputRefKey: (ref: CustomReportOutputRef) => string): string {
  return `${taskId}:${reportOutputRefKey(ref)}`;
}

function groupTitle(group: AssetReportGroup): string {
  if (group === "merged_videos") return "Merged Videos";
  if (group === "post_process_videos") return "Post-process Videos";
  if (group === "generated_videos") return "Generated Videos";
  return "Edited Frames";
}

function reportOptionsForGroup(group: AssetReportGroup, workflowId?: string): ReportTypeOption[] {
  if (group === "edited_frames") {
    return [{ type: "qc_frame", label: "Frame QC", description: "Analyze selected edited frames." }];
  }
  if (group === "merged_videos") {
    return [{ type: "qc_video", label: "Video QC", description: "Analyze selected merged videos." }];
  }
  if (group === "post_process_videos") {
    return [{ type: "qc_video", label: "Video QC", description: "Analyze selected post-process videos." }];
  }
  if (workflowId === "simple_generation_workflow") {
    return [
      {
        type: "previz_review",
        label: "Previz Review",
        description: "Review selected previz videos against the storyboard frames used to generate them.",
      },
    ];
  }
  return [
    { type: "qc_video", label: "Video QC", description: "Analyze selected generated videos." },
    { type: "video_compare", label: "Video Compare", description: "Compare selected generated videos from the same range." },
  ];
}

function defaultTestsForReportType(reportType: ReportType): string[] {
  if (reportType === "qc_frame") return ["frame_diff", "frame_composite"];
  if (reportType === "video_compare") return ["video_model_compare"];
  if (reportType === "previz_review") return ["storyboard_overview"];
  return ["video_diff", "video_frame_evidence"];
}

function testOptionsForReportType(reportType: ReportType) {
  if (reportType === "qc_frame") return FRAME_TEST_OPTIONS;
  if (reportType === "video_compare") return VIDEO_COMPARE_TEST_OPTIONS;
  if (reportType === "previz_review") {
    return [
      {
        id: "storyboard_overview",
        label: "Storyboard overview",
        description: "Include the storyboard frames used for each selected previz video.",
      },
      {
        id: "frame_continuity",
        label: "Frame continuity",
        description: "Group start, key, and end frames so shot continuity can be reviewed alongside the video.",
      },
    ] as const;
  }
  return VIDEO_TEST_OPTIONS;
}

function AssetCard({
  item,
  isSelected,
  onToggleSelected,
  onDelete,
  onPreviewImage,
  hideDeleteAction = false,
  allowReportSelection = true,
}: {
  item: LibraryAsset;
  isSelected: boolean;
  onToggleSelected: () => void;
  onDelete: () => void;
  onPreviewImage?: (payload: { url: string; label: string }) => void;
  hideDeleteAction?: boolean;
  allowReportSelection?: boolean;
}) {
  return (
    <article className={`space-y-2 rounded-lg border p-3 transition-colors ${isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white"}`}>
      <div className="overflow-hidden rounded-lg border border-ink/10 bg-bg">
        {item.mediaType === "image" ? (
          <img src={item.previewUrl} alt={item.title} className="aspect-video w-full object-contain" loading="lazy" decoding="async" />
        ) : item.mediaType === "audio" ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_top,_rgba(15,176,155,0.12),_transparent_55%)] px-4">
            {item.thumbnailUrl ? (
              <img src={item.thumbnailUrl} alt={item.title} className="max-h-24 w-full rounded object-contain" loading="lazy" decoding="async" />
            ) : null}
            <p className="text-sm font-medium text-ink/75">
              {item.assetRole === "source_audio" ? "Source audio" : item.assetRole === "audio_reference" ? "Audio reference" : "Audio asset"}
            </p>
            <audio controls preload="none" className="w-full max-w-xs">
              <source src={item.previewUrl} />
            </audio>
          </div>
        ) : item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt={item.title} className="aspect-video w-full object-contain" loading="lazy" decoding="async" />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center bg-bg text-xs text-ink/55">Video preview unavailable</div>
        )}
      </div>
      <div className="space-y-1">
        <p className="truncate text-sm font-medium text-ink">{item.title}</p>
        <p className="truncate text-xs text-ink/60">{item.subtitle}</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        {item.customReportRef && allowReportSelection ? (
          <button
            type="button"
            className={`rounded-md border px-3 py-2 text-xs font-medium transition ${
              isSelected ? "border-teal-500 bg-teal-50 text-teal-800" : "border-ink/20 bg-white text-ink/70"
            }`}
            onClick={onToggleSelected}
          >
            {isSelected ? "Added to Report" : "Add to Report"}
          </button>
        ) : (
          <span className="text-xs text-ink/50">Preview / download only</span>
        )}
        <div className="flex items-center gap-2">
          {item.mediaType === "image" && onPreviewImage ? (
            <IconActionButton onClick={() => onPreviewImage({ url: item.previewUrl, label: item.title })} title="Preview">
              <PreviewIcon />
            </IconActionButton>
          ) : (
            <IconActionButton href={item.previewUrl} title="Preview">
              <PreviewIcon />
            </IconActionButton>
          )}
          <IconActionButton href={item.downloadUrl} download title="Download">
            <DownloadIcon />
          </IconActionButton>
          {item.deletePayload && !hideDeleteAction ? (
            <IconActionButton onClick={onDelete} title="Delete" tone="danger">
              <DeleteIcon />
            </IconActionButton>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function AssetSection({
  title,
  items,
  visibleCount,
  setVisibleCount,
  selectedKeys,
  reportOutputRefKey,
  onToggle,
  onDelete,
  onCreateReport,
  onPreviewImage,
  allowReports = true,
  hideDeleteActions = false,
  allowReportSelection = true,
}: {
  title: string;
  items: LibraryAsset[];
  visibleCount: number;
  setVisibleCount: (update: number | ((count: number) => number)) => void;
  selectedKeys: Set<string>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  onToggle: (item: LibraryAsset) => void;
  onDelete: (item: LibraryAsset) => void;
  onCreateReport: () => void;
  onPreviewImage?: (payload: { url: string; label: string }) => void;
  allowReports?: boolean;
  hideDeleteActions?: boolean;
  allowReportSelection?: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        {allowReports ? (
          <button type="button" className="rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink" onClick={onCreateReport}>
            Create Report
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-ink/60">No assets available.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.slice(0, visibleCount).map((item) => {
              const ref = item.customReportRef;
              const isSelected = ref ? selectedKeys.has(selectionKey(item.taskId, ref, reportOutputRefKey)) : false;
              return (
                <AssetCard
                  key={item.id}
                  item={item}
                  isSelected={isSelected}
                  onToggleSelected={() => onToggle(item)}
                  onPreviewImage={onPreviewImage}
                  onDelete={() => {
                    void onDelete(item);
                  }}
                  hideDeleteAction={hideDeleteActions}
                  allowReportSelection={allowReportSelection}
                />
              );
            })}
          </div>
          {visibleCount < items.length ? (
            <button type="button" className="text-sm text-accent underline" onClick={() => setVisibleCount((count) => count + 6)}>
              More...
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function CreateAssetReportModal({
  state,
  workflowId,
  selectedRefs,
  selectedTaskCount,
  isPending,
  onClose,
  onCreate,
}: {
  state: CreateReportModalState | null;
  workflowId?: string;
  selectedRefs: CustomReportOutputRef[];
  selectedTaskCount: number;
  isPending: boolean;
  onClose: () => void;
  onCreate: (payload: { reportType: ReportType; tests: string[] }) => Promise<void>;
}) {
  const [reportType, setReportType] = useState<ReportType>("qc_video");
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [queued, setQueued] = useState(false);
  const options = useMemo(() => (state ? reportOptionsForGroup(state.group, workflowId) : []), [state, workflowId]);

  useEffect(() => {
    if (!state) return;
    const nextType = options[0]?.type ?? "qc_video";
    setReportType(nextType);
    setSelectedTests(defaultTestsForReportType(nextType));
    setQueued(false);
  }, [options, state]);

  if (!state) return null;

  const testOptions = testOptionsForReportType(reportType);
  const needsComparisonWarning = reportType === "video_compare" && selectedRefs.length < 2;
  const mixedTaskWarning = selectedTaskCount > 1;
  const cannotCreate = selectedRefs.length === 0 || selectedTaskCount !== 1 || needsComparisonWarning || selectedTests.length === 0 || isPending || queued;

  async function handleCreate() {
    await onCreate({ reportType, tests: selectedTests });
    setQueued(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4">
      <div className="w-full max-w-3xl rounded-2xl border border-ink/10 bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold">{groupTitle(state.group)} Report</h3>
          </div>
          <button type="button" className="rounded border border-ink/20 bg-white px-3 py-1.5 text-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-4 space-y-4">
          {queued ? (
            <StatusNotice variant="info">
              <p>Report queued. It will appear on the Reports page when the worker starts building it.</p>
            </StatusNotice>
          ) : null}
          {selectedRefs.length === 0 ? (
            <StatusNotice variant="warning">
              <p>Select one or more items with Add to Report before creating a report.</p>
            </StatusNotice>
          ) : null}
          {needsComparisonWarning ? (
            <StatusNotice variant="warning">
              <p>Video Compare requires at least two selected generated videos.</p>
            </StatusNotice>
          ) : null}
          {mixedTaskWarning ? (
            <StatusNotice variant="warning">
              <p>Reports can only be created from assets belonging to one task. Narrow the selection to a single task.</p>
            </StatusNotice>
          ) : null}
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink/80">Report type</p>
            <div className="grid gap-2 md:grid-cols-2">
              {options.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  className={`rounded-lg border px-3 py-3 text-left ${
                    reportType === option.type ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white"
                  }`}
                  onClick={() => {
                    setReportType(option.type);
                    setSelectedTests(defaultTestsForReportType(option.type));
                  }}
                >
                  <p className="text-sm font-medium text-ink">{option.label}</p>
                  <p className="mt-1 text-xs text-ink/60">{option.description}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink/80">QC tests</p>
            <div className="space-y-2">
              {testOptions.map((test) => {
                const checked = selectedTests.includes(test.id);
                return (
                  <label key={test.id} className={`flex items-start gap-3 rounded-lg border p-3 ${checked ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white"}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedTests((previous) => (previous.includes(test.id) ? previous.filter((item) => item !== test.id) : [...previous, test.id]))
                      }
                      className="mt-1"
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium text-ink">{test.label}</span>
                      <span className="block text-xs text-ink/60">{test.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="rounded border border-ink/20 bg-white px-3 py-2 text-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={cannotCreate}
              onClick={() => void handleCreate()}
            >
              <PendingButtonLabel isPending={isPending} idle="Create Report" pending="Queueing report..." />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AssetsTab({ ctx }: AssetsTabProps) {
  const {
    task,
    workflowId = task?.workflowId,
    assetsLoading,
    pageTitle,
    pageDescription,
    showNext = true,
    imageAssetsTitle = "Edited Frames",
    secondaryImageAssetsTitle,
    mergedVideoAssets,
    mergedAssetsVisible,
    setMergedAssetsVisible,
    generatedVideoAssets,
    generatedAssetsVisible,
    setGeneratedAssetsVisible,
    postProcessVideoAssets = [],
    postProcessAssetsVisible = 0,
    setPostProcessAssetsVisible,
    editedFrameAssets,
    editedFrameAssetsVisible,
    setEditedFrameAssetsVisible,
    secondaryImageAssets = [],
    secondaryImageAssetsVisible = 0,
    setSecondaryImageAssetsVisible,
    orphanedAssets = [],
    orphanedAssetsVisible = 0,
    setOrphanedAssetsVisible,
    audioAssets = [],
    audioAssetsVisible = 0,
    setAudioAssetsVisible,
    selectedReportOutputs,
    reportOutputRefKey,
    toggleCustomReportOutput,
    clearCustomReportOutputs,
    handleDeleteAsset,
    previewImage,
    createCustomReport,
    isCreatingCustomReport,
    allowMergedVideoReports = true,
    allowGeneratedVideoReports = true,
    allowImageReports = true,
    allowReportSelection = true,
    onNext,
    nextDisabled,
    nextWarning,
    hideDeleteActions = false,
  } = ctx;

  const [createModalState, setCreateModalState] = useState<CreateReportModalState | null>(null);
  const selectedKeys = useMemo(() => new Set(Object.keys(selectedReportOutputs)), [selectedReportOutputs]);

  const modalSelectedRefs = useMemo(() => {
    if (!createModalState) return [];
    const source =
      createModalState.group === "merged_videos"
        ? mergedVideoAssets
        : createModalState.group === "generated_videos"
          ? generatedVideoAssets
          : createModalState.group === "post_process_videos"
            ? postProcessVideoAssets
            : editedFrameAssets;
    return source
      .filter((item) => item.customReportRef && selectedKeys.has(selectionKey(item.taskId, item.customReportRef, reportOutputRefKey)))
      .map((item) => item.customReportRef as CustomReportOutputRef);
  }, [createModalState, editedFrameAssets, generatedVideoAssets, mergedVideoAssets, postProcessVideoAssets, reportOutputRefKey, selectedKeys]);
  const modalSelectedTaskIds = useMemo(() => {
    if (!createModalState) return [];
    const source =
      createModalState.group === "merged_videos"
        ? mergedVideoAssets
        : createModalState.group === "generated_videos"
          ? generatedVideoAssets
          : createModalState.group === "post_process_videos"
            ? postProcessVideoAssets
            : editedFrameAssets;
    return Array.from(
      new Set(
        source
          .filter((item) => item.customReportRef && selectedKeys.has(selectionKey(item.taskId, item.customReportRef, reportOutputRefKey)))
          .map((item) => item.taskId),
      ),
    );
  }, [createModalState, editedFrameAssets, generatedVideoAssets, mergedVideoAssets, postProcessVideoAssets, reportOutputRefKey, selectedKeys]);

  function toggleItemForReport(item: LibraryAsset) {
    if (!item.customReportRef) return;
    toggleCustomReportOutput(item.taskId, item.customReportRef);
  }

  async function createReportFromModal(payload: { reportType: ReportType; tests: string[] }) {
    const taskId = modalSelectedTaskIds[0];
    if (!taskId || modalSelectedTaskIds.length !== 1) return;
    await createCustomReport({
      taskId,
      reportType: payload.reportType,
      tests: payload.tests,
      outputRefs: modalSelectedRefs,
    });
    clearCustomReportOutputs(taskId, modalSelectedRefs);
  }

  return (
    <div className="space-y-6">
      {pageTitle ? (
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-ink">{pageTitle}</h2>
          {pageDescription ? <p className="text-sm text-ink/60">{pageDescription}</p> : null}
        </div>
      ) : null}
      {assetsLoading ? (
        <StatusNotice variant="loading">
          <p>Loading assets...</p>
        </StatusNotice>
      ) : null}
      {!task ? (
        <p className="text-sm text-ink/60">Select a task to view assets.</p>
      ) : (
        <>
          <AssetSection
            title="Merged Videos"
            items={mergedVideoAssets}
            visibleCount={mergedAssetsVisible}
            setVisibleCount={setMergedAssetsVisible}
            selectedKeys={selectedKeys}
            reportOutputRefKey={reportOutputRefKey}
            onToggle={toggleItemForReport}
            onDelete={handleDeleteAsset}
            onCreateReport={() => setCreateModalState({ group: "merged_videos" })}
            onPreviewImage={previewImage}
            allowReports={allowMergedVideoReports}
            hideDeleteActions={hideDeleteActions}
            allowReportSelection={allowReportSelection}
          />
          <div className="border-t border-ink/10" />
          <AssetSection
            title="Generated Videos"
            items={generatedVideoAssets}
            visibleCount={generatedAssetsVisible}
            setVisibleCount={setGeneratedAssetsVisible}
            selectedKeys={selectedKeys}
            reportOutputRefKey={reportOutputRefKey}
            onToggle={toggleItemForReport}
            onDelete={handleDeleteAsset}
            onCreateReport={() => setCreateModalState({ group: "generated_videos" })}
            onPreviewImage={previewImage}
            allowReports={allowGeneratedVideoReports}
            hideDeleteActions={hideDeleteActions}
            allowReportSelection={allowReportSelection}
          />
          {postProcessVideoAssets.length > 0 && setPostProcessAssetsVisible ? (
            <>
              <div className="border-t border-ink/10" />
              <AssetSection
                title="Post-process Videos"
                items={postProcessVideoAssets}
                visibleCount={postProcessAssetsVisible}
                setVisibleCount={setPostProcessAssetsVisible}
                selectedKeys={selectedKeys}
                reportOutputRefKey={reportOutputRefKey}
                onToggle={toggleItemForReport}
                onDelete={handleDeleteAsset}
                onCreateReport={() => setCreateModalState({ group: "post_process_videos" })}
                onPreviewImage={previewImage}
                allowReports
                hideDeleteActions={hideDeleteActions}
                allowReportSelection={allowReportSelection}
              />
            </>
          ) : null}
          <div className="border-t border-ink/10" />
          <AssetSection
            title={imageAssetsTitle}
            items={editedFrameAssets}
            visibleCount={editedFrameAssetsVisible}
            setVisibleCount={setEditedFrameAssetsVisible}
            selectedKeys={selectedKeys}
            reportOutputRefKey={reportOutputRefKey}
            onToggle={toggleItemForReport}
            onDelete={handleDeleteAsset}
            onCreateReport={() => setCreateModalState({ group: "edited_frames" })}
            onPreviewImage={previewImage}
            allowReports={allowImageReports && editedFrameAssets.some((item) => Boolean(item.customReportRef))}
            hideDeleteActions={hideDeleteActions}
            allowReportSelection={allowReportSelection}
          />
          {secondaryImageAssets.length > 0 && setSecondaryImageAssetsVisible ? (
            <>
              <div className="border-t border-ink/10" />
              <AssetSection
                title={secondaryImageAssetsTitle ?? "Reference Images"}
                items={secondaryImageAssets}
                visibleCount={secondaryImageAssetsVisible}
                setVisibleCount={setSecondaryImageAssetsVisible}
                selectedKeys={selectedKeys}
                reportOutputRefKey={reportOutputRefKey}
                onToggle={toggleItemForReport}
                onDelete={handleDeleteAsset}
                onCreateReport={() => undefined}
                onPreviewImage={previewImage}
                allowReports={false}
                hideDeleteActions={hideDeleteActions}
                allowReportSelection={false}
              />
            </>
          ) : null}
          {orphanedAssets.length > 0 && setOrphanedAssetsVisible ? (
            <>
              <div className="border-t border-ink/10" />
              <AssetSection
                title="Orphaned Assets"
                items={orphanedAssets}
                visibleCount={orphanedAssetsVisible}
                setVisibleCount={setOrphanedAssetsVisible}
                selectedKeys={selectedKeys}
                reportOutputRefKey={reportOutputRefKey}
                onToggle={toggleItemForReport}
                onDelete={handleDeleteAsset}
                onCreateReport={() => undefined}
                onPreviewImage={previewImage}
                allowReports={false}
                hideDeleteActions={hideDeleteActions}
                allowReportSelection={false}
              />
            </>
          ) : null}
          {audioAssets.length > 0 && setAudioAssetsVisible ? (
            <>
              <div className="border-t border-ink/10" />
              <AssetSection
                title="Audio Assets"
                items={audioAssets}
                visibleCount={audioAssetsVisible}
                setVisibleCount={setAudioAssetsVisible}
                selectedKeys={selectedKeys}
                reportOutputRefKey={reportOutputRefKey}
                onToggle={toggleItemForReport}
                onDelete={handleDeleteAsset}
                onCreateReport={() => undefined}
                onPreviewImage={previewImage}
                allowReports={false}
                hideDeleteActions={hideDeleteActions}
                allowReportSelection={false}
              />
            </>
          ) : null}
          {showNext ? (
            <div className="flex justify-end">
              <div className="space-y-2 text-right">
                {nextWarning ? <p className="text-xs text-ink/60">{nextWarning}</p> : null}
                <button
                  type="button"
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={nextDisabled}
                  onClick={onNext}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <CreateAssetReportModal
        state={createModalState}
        workflowId={workflowId}
        selectedRefs={modalSelectedRefs}
        selectedTaskCount={modalSelectedTaskIds.length}
        isPending={isCreatingCustomReport}
        onClose={() => setCreateModalState(null)}
        onCreate={createReportFromModal}
      />
    </div>
  );
}

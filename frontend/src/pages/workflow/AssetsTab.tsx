import { useEffect, useMemo, useState } from "react";

import { DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, StatusNotice } from "../../components/layout/UiFeedback";
import { FRAME_TEST_OPTIONS, VIDEO_COMPARE_TEST_OPTIONS, VIDEO_TEST_OPTIONS } from "../../components/reports/QcReportShared";
import type { CustomReportOutputRef, TaskDetail } from "../../types/api";

type LibraryAsset = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  mediaType: "image" | "video";
  customReportRef?: CustomReportOutputRef;
  deletePayload:
    | { assetType: "upload" }
    | { assetType: "frame_capture"; frameId: string }
    | { assetType: "frame_variant"; frameId: string; variantId: string }
    | { assetType: "segment_generation"; genId: string }
    | { assetType: "export"; exportId: string };
};

type AssetReportGroup = "merged_videos" | "generated_videos" | "edited_frames";
type ReportType = "qc_frame" | "qc_video" | "video_compare";

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
  assetsLoading: boolean;
  pageTitle?: string;
  pageDescription?: string | null;
  showNext?: boolean;
  mergedVideoAssets: LibraryAsset[];
  mergedAssetsVisible: number;
  setMergedAssetsVisible: (update: number | ((count: number) => number)) => void;
  generatedVideoAssets: LibraryAsset[];
  generatedAssetsVisible: number;
  setGeneratedAssetsVisible: (update: number | ((count: number) => number)) => void;
  editedFrameAssets: LibraryAsset[];
  editedFrameAssetsVisible: number;
  setEditedFrameAssetsVisible: (update: number | ((count: number) => number)) => void;
  formatAssetDate: (iso: string) => string;
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  clearCustomReportOutputs: (taskId: string, refs?: CustomReportOutputRef[]) => void;
  handleDeleteAsset: (item: LibraryAsset) => Promise<void>;
  createCustomReport: (payload: {
    taskId: string;
    reportType: ReportType;
    tests: string[];
    outputRefs: CustomReportOutputRef[];
    name?: string;
  }) => Promise<{ reportId: string }>;
  isCreatingCustomReport: boolean;
  onNext: () => void;
  nextDisabled: boolean;
  nextWarning: string | null;
};

type AssetsTabProps = {
  ctx: AssetsTabCtx;
};

function selectionKey(taskId: string, ref: CustomReportOutputRef, reportOutputRefKey: (ref: CustomReportOutputRef) => string): string {
  return `${taskId}:${reportOutputRefKey(ref)}`;
}

function groupTitle(group: AssetReportGroup): string {
  if (group === "merged_videos") return "Merged Videos";
  if (group === "generated_videos") return "Generated Videos";
  return "Edited Frames";
}

function reportOptionsForGroup(group: AssetReportGroup): ReportTypeOption[] {
  if (group === "edited_frames") {
    return [{ type: "qc_frame", label: "Frame QC", description: "Analyze selected edited frames." }];
  }
  if (group === "merged_videos") {
    return [{ type: "qc_video", label: "Video QC", description: "Analyze selected merged videos." }];
  }
  return [
    { type: "qc_video", label: "Video QC", description: "Analyze selected generated videos." },
    { type: "video_compare", label: "Video Compare", description: "Compare selected generated videos from the same range." },
  ];
}

function defaultTestsForReportType(reportType: ReportType): string[] {
  if (reportType === "qc_frame") return ["frame_diff", "frame_composite"];
  if (reportType === "video_compare") return ["video_model_compare"];
  return ["video_diff", "video_frame_evidence"];
}

function testOptionsForReportType(reportType: ReportType) {
  if (reportType === "qc_frame") return FRAME_TEST_OPTIONS;
  if (reportType === "video_compare") return VIDEO_COMPARE_TEST_OPTIONS;
  return VIDEO_TEST_OPTIONS;
}

function AssetCard({
  item,
  isSelected,
  onToggleSelected,
  onDelete,
}: {
  item: LibraryAsset;
  isSelected: boolean;
  onToggleSelected: () => void;
  onDelete: () => void;
}) {
  return (
    <article className={`space-y-2 rounded-lg border p-3 transition-colors ${isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white"}`}>
      <div className="overflow-hidden rounded-lg border border-ink/10 bg-bg">
        {item.mediaType === "image" ? (
          <img src={item.previewUrl} alt={item.title} className="aspect-video w-full object-contain" loading="lazy" decoding="async" />
        ) : item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt={item.title} className="aspect-video w-full object-contain" loading="lazy" decoding="async" />
        ) : (
          <video src={item.previewUrl} className="aspect-video w-full object-contain" preload="metadata" muted playsInline />
        )}
      </div>
      <div className="space-y-1">
        <p className="truncate text-sm font-medium text-ink">{item.title}</p>
        <p className="truncate text-xs text-ink/60">{item.subtitle}</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className={`rounded-md border px-3 py-2 text-xs font-medium transition ${
            isSelected ? "border-teal-500 bg-teal-50 text-teal-800" : "border-ink/20 bg-white text-ink/70"
          }`}
          onClick={onToggleSelected}
        >
          {isSelected ? "Added to Report" : "Add to Report"}
        </button>
        <div className="flex items-center gap-2">
          <IconActionButton href={item.previewUrl} title="Preview">
            <PreviewIcon />
          </IconActionButton>
          <IconActionButton href={item.downloadUrl} download title="Download">
            <DownloadIcon />
          </IconActionButton>
          <IconActionButton onClick={onDelete} title="Delete" tone="danger">
            <DeleteIcon />
          </IconActionButton>
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
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        <button type="button" className="rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink" onClick={onCreateReport}>
          Create Report
        </button>
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
                  onDelete={() => {
                    void onDelete(item);
                  }}
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
  selectedRefs,
  selectedTaskCount,
  isPending,
  onClose,
  onCreate,
}: {
  state: CreateReportModalState | null;
  selectedRefs: CustomReportOutputRef[];
  selectedTaskCount: number;
  isPending: boolean;
  onClose: () => void;
  onCreate: (payload: { reportType: ReportType; tests: string[] }) => Promise<void>;
}) {
  const [reportType, setReportType] = useState<ReportType>("qc_video");
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [queued, setQueued] = useState(false);
  const options = useMemo(() => (state ? reportOptionsForGroup(state.group) : []), [state]);

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
              <p>Reports can only be created from assets belonging to one source video. Narrow the selection to a single video.</p>
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
    assetsLoading,
    pageTitle,
    pageDescription,
    showNext = true,
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
    onNext,
    nextDisabled,
    nextWarning,
  } = ctx;

  const [createModalState, setCreateModalState] = useState<CreateReportModalState | null>(null);
  const selectedKeys = useMemo(() => new Set(Object.keys(selectedReportOutputs)), [selectedReportOutputs]);

  const modalSelectedRefs = useMemo(() => {
    if (!createModalState) return [];
    const source = createModalState.group === "merged_videos" ? mergedVideoAssets : createModalState.group === "generated_videos" ? generatedVideoAssets : editedFrameAssets;
    return source
      .filter((item) => item.customReportRef && selectedKeys.has(selectionKey(item.taskId, item.customReportRef, reportOutputRefKey)))
      .map((item) => item.customReportRef as CustomReportOutputRef);
  }, [createModalState, editedFrameAssets, generatedVideoAssets, mergedVideoAssets, reportOutputRefKey, selectedKeys]);
  const modalSelectedTaskIds = useMemo(() => {
    if (!createModalState) return [];
    const source = createModalState.group === "merged_videos" ? mergedVideoAssets : createModalState.group === "generated_videos" ? generatedVideoAssets : editedFrameAssets;
    return Array.from(
      new Set(
        source
          .filter((item) => item.customReportRef && selectedKeys.has(selectionKey(item.taskId, item.customReportRef, reportOutputRefKey)))
          .map((item) => item.taskId),
      ),
    );
  }, [createModalState, editedFrameAssets, generatedVideoAssets, mergedVideoAssets, reportOutputRefKey, selectedKeys]);

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
          />
          <div className="border-t border-ink/10" />
          <AssetSection
            title="Edited Frames"
            items={editedFrameAssets}
            visibleCount={editedFrameAssetsVisible}
            setVisibleCount={setEditedFrameAssetsVisible}
            selectedKeys={selectedKeys}
            reportOutputRefKey={reportOutputRefKey}
            onToggle={toggleItemForReport}
            onDelete={handleDeleteAsset}
            onCreateReport={() => setCreateModalState({ group: "edited_frames" })}
          />
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
        selectedRefs={modalSelectedRefs}
        selectedTaskCount={modalSelectedTaskIds.length}
        isPending={isCreatingCustomReport}
        onClose={() => setCreateModalState(null)}
        onCreate={createReportFromModal}
      />
    </div>
  );
}

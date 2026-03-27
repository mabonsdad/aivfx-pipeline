import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import type {
  CustomReportOutputRef,
  CustomReportRecord,
  FrameRecord,
  FrameVariant,
  JobStatus,
  QcReportResult,
  SegmentGeneration,
  SegmentRecord,
  TaskDetail,
} from "../types/api";

type ReportView = "frames" | "videos" | "reports";

type ReportsPageCtx = {
  reportTask: TaskDetail | undefined;
  reportTaskId: string | null;
  sortedJobs: JobStatus[];
  selectedOutputRefsByTask: Record<string, CustomReportOutputRef[]>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  reportView: ReportView;
  setReportView: (view: ReportView) => void;
  setActiveCustomReportId: (reportId: string | null) => void;
  activeCustomReportId: string | null;
  goToTaskTimeline: (taskId: string) => void;
  logout: () => void;
  formatAssetDate: (iso: string) => string;
  truncateIdentifier: (value: string, maxLength?: number) => string;
  reportTaskQuery: UseQueryResult<TaskDetail, Error>;
  createCustomReportMutation: UseMutationResult<
    { reportId: string },
    Error,
    {
      taskId: string;
      reportType: "qc_frame" | "qc_video";
      tests: string[];
      outputRefs: CustomReportOutputRef[];
      name?: string;
    },
    unknown
  >;
  deleteCustomReportMutation: UseMutationResult<{ ok: true }, Error, { taskId: string; reportId: string }, unknown>;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  setVideoPreviewModal: (value: { url: string; label: string } | null) => void;
  setImagePreviewModal: (value: { url: string; label: string } | null) => void;
  formatCompactTimestamp: (iso: string | undefined) => string;
  asNumber: (value: unknown) => number | null;
  describeSegment: (segment: SegmentRecord) => string;
  setReportGraphModal: (value: { url: string; label: string } | null) => void;
};

type ReportsPageProps = {
  ctx: ReportsPageCtx;
};

type FrameOutputRow = {
  frame: FrameRecord;
  variant: FrameVariant;
  role: "start" | "end" | "unlinked";
};

type VideoOutputRow = {
  generation: SegmentGeneration;
  segment: SegmentRecord | null;
  startFrame: FrameRecord | null;
  endFrame: FrameRecord | null;
  startVariant: FrameVariant | null;
  endVariant: FrameVariant | null;
};

type FrameReportRow = {
  assetType: "frame_variant";
  frameId: string;
  variantId: string;
  role: "start" | "end" | "unlinked";
  frameIndex: number;
  timecode: string;
  createdAt?: string;
  model?: string;
  variantType?: string;
  prompt?: string;
  originalFrameUrl?: string;
  maskUrl?: string;
  editedFrameUrl?: string;
  standard?: {
    metrics?: Record<string, unknown>;
    artifacts?: Record<string, unknown>;
  } | null;
  advanced?: {
    status?: string;
    selectedTests?: string[];
    metrics?: Record<string, unknown>;
    topRegions?: Array<Record<string, unknown>>;
    tooltips?: Record<string, string>;
    artifacts?: Record<string, unknown>;
  } | null;
};

type VideoReportRow = {
  assetType: "segment_generation";
  genId: string;
  segmentId: string;
  createdAt?: string;
  model?: string;
  mode?: string;
  prompt?: string;
  originalFrameUrl?: string;
  editedStartFrameUrl?: string;
  maskUrl?: string;
  endFrameUrl?: string;
  generatedVideoUrl?: string;
  standard?: {
    selectedTests?: string[];
    aggregates?: Record<string, unknown>;
    selectedFrames?: Array<Record<string, unknown>>;
    artifacts?: Record<string, unknown>;
  } | null;
};

const FRAME_TEST_OPTIONS = [
  { id: "frame_diff", label: "Frame diff set", description: "Diff heatmap, overlay, binary/boundary map and standard still metrics." },
  { id: "frame_composite", label: "Composite anomaly summary", description: "Combined anomaly heatmap with top anomalous regions." },
  { id: "frame_perceptual", label: "Frame perceptual impact", description: "LPIPS-style patch difference map and perceptual change scores." },
  { id: "frame_boundary", label: "Frame boundary spill", description: "Inside/outside ring analysis for spill beyond the intended edit region." },
  { id: "frame_sharpness", label: "Frame sharpness consistency", description: "Focus and sharpness mismatch maps across the edited frame." },
  { id: "frame_naturalness", label: "Frame naturalness", description: "Naturalness anomaly map highlighting statistically unusual patches." },
  { id: "frame_texture", label: "Frame microtexture", description: "Noise and microtexture consistency map for over-smoothed or over-sharpened areas." },
] as const;

const VIDEO_TEST_OPTIONS = [
  { id: "video_diff", label: "Video diff set", description: "Diff video, timeline graph/CSV and aggregate video QC metrics." },
  { id: "video_frame_evidence", label: "Video frame evidence", description: "Representative extracted frame QC evidence from the generated segment." },
] as const;

function safeTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function frameRole(task: TaskDetail, frameId: string): "start" | "end" | "unlinked" {
  for (const segment of task.segments ?? []) {
    if (segment.startFrameId === frameId) return "start";
    if (segment.endFrameId === frameId) return "end";
  }
  return "unlinked";
}

function framePrompt(variant: FrameVariant, truncateIdentifier: (value: string, maxLength?: number) => string): string {
  const promptValue = (variant.generationSettings?.prompt as string | undefined)?.trim();
  return promptValue || `Prompt hash ${truncateIdentifier(variant.promptHash, 16)}`;
}

function resolveVariant(
  frame: FrameRecord | null,
  preferredVariantId: string | null | undefined,
  preferredOutputKey: string | null | undefined,
  fallbackOutputKey: string | null | undefined,
): FrameVariant | null {
  if (!frame) return null;
  if (preferredVariantId) {
    const byId = frame.variants.find((variant) => variant.variantId === preferredVariantId) ?? null;
    if (byId) return byId;
  }
  const key = preferredOutputKey ?? fallbackOutputKey ?? null;
  if (key) {
    const byKey = frame.variants.find((variant) => variant.outputKey === key) ?? null;
    if (byKey) return byKey;
  }
  if (frame.selectedVariantId) {
    return frame.variants.find((variant) => variant.variantId === frame.selectedVariantId) ?? null;
  }
  return null;
}

function hasGraphEvidence(row: VideoReportRow): boolean {
  const artifacts = row.standard?.artifacts;
  return Boolean(artifacts?.timelineGraphUrl || artifacts?.timelineCsvUrl || artifacts?.diffVideoUrl);
}

function ReportCreateModal(props: {
  isOpen: boolean;
  title: string;
  selectedCount: number;
  reportName: string;
  setReportName: (value: string) => void;
  tests: readonly { id: string; label: string; description: string }[];
  selectedTests: string[];
  toggleTest: (id: string) => void;
  onClose: () => void;
  onCreate: () => void;
  isPending: boolean;
}) {
  const { isOpen, title, selectedCount, reportName, setReportName, tests, selectedTests, toggleTest, onClose, onCreate, isPending } = props;
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-ink/10 bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold">{title}</h3>
            <p className="text-sm text-ink/60">Selected outputs: {selectedCount}</p>
          </div>
          <button type="button" className="text-sm text-ink/60 underline" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-4 space-y-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-ink/80">Report name</span>
            <input
              value={reportName}
              onChange={(event) => setReportName(event.target.value)}
              placeholder="Optional report name"
              className="w-full rounded border border-ink/20 bg-white px-3 py-2 text-sm"
            />
          </label>
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink/80">QC tests</p>
            {tests.map((test) => (
              <label key={test.id} className="flex items-start gap-3 rounded border border-ink/10 bg-white p-3">
                <input
                  type="checkbox"
                  checked={selectedTests.includes(test.id)}
                  onChange={() => toggleTest(test.id)}
                  className="mt-1"
                />
                <span className="space-y-1">
                  <span className="block text-sm font-medium">{test.label}</span>
                  <span className="block text-xs text-ink/60">{test.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" className="rounded border border-ink/20 bg-white px-3 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isPending || selectedCount === 0 || selectedTests.length === 0}
            onClick={onCreate}
          >
            {isPending ? "Creating..." : "Create Report"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ReportsPage({ ctx }: ReportsPageProps) {
  const {
    reportTask,
    reportTaskId,
    sortedJobs,
    selectedOutputRefsByTask,
    reportOutputRefKey,
    reportView,
    setReportView,
    setActiveCustomReportId,
    activeCustomReportId,
    goToTaskTimeline,
    logout,
    formatAssetDate,
    truncateIdentifier,
    reportTaskQuery,
    createCustomReportMutation,
    deleteCustomReportMutation,
    toggleCustomReportOutput,
    setVideoPreviewModal,
    setImagePreviewModal,
    formatCompactTimestamp,
    asNumber,
    describeSegment,
    setReportGraphModal,
  } = ctx;

  const [createModalMode, setCreateModalMode] = useState<"qc_frame" | "qc_video" | null>(null);
  const [reportName, setReportName] = useState("");
  const [selectedTests, setSelectedTests] = useState<string[]>([]);

  const frameOutputRows = useMemo(() => {
    if (!reportTask) return [] as FrameOutputRow[];
    const rows: FrameOutputRow[] = [];
    for (const frame of Object.values(reportTask.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.imageUrl) continue;
        rows.push({
          frame,
          variant,
          role: frameRole(reportTask, frame.frameId),
        });
      }
    }
    return rows.sort((a, b) => safeTimestamp(b.variant.createdAt) - safeTimestamp(a.variant.createdAt));
  }, [reportTask]);

  const videoOutputRows = useMemo(() => {
    if (!reportTask) return [] as VideoOutputRow[];
    return Object.values(reportTask.segmentGenerations ?? {})
      .filter((generation) => generation.status === "complete" && generation.outputKey)
      .map((generation) => {
        const segment = reportTask.segments.find((item) => item.segmentId === generation.segmentId) ?? null;
        const startFrame = segment ? reportTask.frames[segment.startFrameId] ?? null : null;
        const endFrame = segment ? reportTask.frames[segment.endFrameId] ?? null : null;
        return {
          generation,
          segment,
          startFrame,
          endFrame,
          startVariant: resolveVariant(
            startFrame,
            generation.sourceFirstFrameVariantId,
            generation.sourceFirstFrameResolvedKey,
            generation.inputFirstFrameKey,
          ),
          endVariant: resolveVariant(
            endFrame,
            generation.sourceLastFrameVariantId,
            generation.sourceLastFrameResolvedKey,
            generation.inputLastFrameKey,
          ),
        };
      })
      .sort((a, b) => safeTimestamp(b.generation.createdAt) - safeTimestamp(a.generation.createdAt));
  }, [reportTask]);

  const reports = useMemo(
    () => [...(reportTask?.customReports ?? [])].sort((a, b) => safeTimestamp(b.updatedAt) - safeTimestamp(a.updatedAt)),
    [reportTask?.customReports],
  );
  const activeReportMeta = useMemo(
    () => reports.find((report) => report.reportId === activeCustomReportId) ?? null,
    [activeCustomReportId, reports],
  );
  const selectedRefsForTask = reportTaskId ? selectedOutputRefsByTask[reportTaskId] ?? [] : [];
  const selectedFrameRefs = selectedRefsForTask.filter((ref) => ref.assetType === "frame_variant");
  const selectedVideoRefs = selectedRefsForTask.filter((ref) => ref.assetType === "segment_generation");

  const activeReportQuery = useQuery({
    queryKey: ["task", "report-result", reportTaskId, activeCustomReportId],
    queryFn: async () => {
      if (!reportTaskId || !activeCustomReportId) throw new Error("Missing report selection");
      return apiClient.getCustomReport(reportTaskId, activeCustomReportId);
    },
    enabled: Boolean(reportTaskId && activeCustomReportId),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!activeCustomReportId) return;
    if (!reports.some((report) => report.reportId === activeCustomReportId)) {
      setActiveCustomReportId(null);
    }
  }, [activeCustomReportId, reports, setActiveCustomReportId]);

  useEffect(() => {
    if (!activeReportMeta) return;
    if (activeReportMeta.status !== "queued" && activeReportMeta.status !== "running") return;
    const timer = window.setInterval(() => {
      void reportTaskQuery.refetch();
      void activeReportQuery.refetch();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeReportMeta, activeReportQuery, reportTaskQuery]);

  function openCreateModal(mode: "qc_frame" | "qc_video") {
    setCreateModalMode(mode);
    setReportName("");
    setSelectedTests(
      mode === "qc_frame"
        ? ["frame_diff", "frame_composite"]
        : ["video_diff", "video_frame_evidence"],
    );
  }

  function closeCreateModal() {
    setCreateModalMode(null);
    setReportName("");
    setSelectedTests([]);
  }

  function toggleTest(id: string) {
    setSelectedTests((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));
  }

  async function createReport() {
    if (!reportTaskId || !createModalMode) return;
    const outputRefs = createModalMode === "qc_frame" ? selectedFrameRefs : selectedVideoRefs;
    const result = await createCustomReportMutation.mutateAsync({
      taskId: reportTaskId,
      reportType: createModalMode,
      tests: selectedTests,
      outputRefs,
      name: reportName.trim() || undefined,
    });
    setReportView("reports");
    setActiveCustomReportId(result.reportId);
    closeCreateModal();
    await reportTaskQuery.refetch();
  }

  async function deleteReport(report: CustomReportRecord) {
    if (!reportTaskId) return;
    const ok = window.confirm(`Delete report "${report.name}"?`);
    if (!ok) return;
    await deleteCustomReportMutation.mutateAsync({ taskId: reportTaskId, reportId: report.reportId });
    if (activeCustomReportId === report.reportId) {
      setActiveCustomReportId(null);
    }
    await reportTaskQuery.refetch();
  }

  const latestQcJob =
    sortedJobs.find((job) => job.type === "qc_report_build" && (!reportTaskId || job.taskId === reportTaskId)) ?? null;

  const activeResult = activeReportQuery.data?.result ?? null;
  const frameReportRows = ((activeResult?.rows as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (row): row is FrameReportRow => row.assetType === "frame_variant",
  );
  const videoReportRows = ((activeResult?.rows as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (row): row is VideoReportRow => row.assetType === "segment_generation",
  );

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto w-full max-w-[1700px] space-y-4 p-4 md:p-6">
        <div className="flex items-center justify-between rounded-2xl border border-ink/10 bg-card p-4">
          <div>
            <h2 className="text-xl font-semibold">Reports: {reportTask?.name ?? reportTaskId ?? "Task"}</h2>
            {reportTask ? <p className="text-sm text-ink/60">Updated {formatAssetDate(reportTask.updatedAt)}</p> : null}
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
              onClick={() => {
                if (reportTaskId) goToTaskTimeline(reportTaskId);
              }}
            >
              Back to Task
            </button>
            <button onClick={() => logout()} className="text-sm text-ink/60 underline">
              Sign out
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ink/10 bg-card p-3">
          <button className={`rounded px-3 py-2 text-sm ${reportView === "frames" ? "bg-ink text-white" : "bg-ink/10"}`} onClick={() => setReportView("frames")}>
            Frame Outputs
          </button>
          <button className={`rounded px-3 py-2 text-sm ${reportView === "videos" ? "bg-ink text-white" : "bg-ink/10"}`} onClick={() => setReportView("videos")}>
            Video Outputs
          </button>
          <button className={`rounded px-3 py-2 text-sm ${reportView === "reports" ? "bg-ink text-white" : "bg-ink/10"}`} onClick={() => setReportView("reports")}>
            Reports
          </button>
          {reportView === "frames" ? (
            <button
              type="button"
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!reportTaskId || selectedFrameRefs.length === 0 || createCustomReportMutation.isPending}
              onClick={() => openCreateModal("qc_frame")}
            >
              Create Frame QC Report
            </button>
          ) : null}
          {reportView === "videos" ? (
            <button
              type="button"
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!reportTaskId || selectedVideoRefs.length === 0 || createCustomReportMutation.isPending}
              onClick={() => openCreateModal("qc_video")}
            >
              Create Video QC Report
            </button>
          ) : null}
          <button type="button" className="rounded border border-ink/20 bg-white px-3 py-2 text-sm" onClick={() => void reportTaskQuery.refetch()}>
            Refresh
          </button>
        </div>

        {latestQcJob ? (
          <p className="text-xs text-ink/70">
            Latest report job {truncateIdentifier(latestQcJob.jobId, 12)}: {latestQcJob.status} ({latestQcJob.progress}%)
          </p>
        ) : null}
        {reportTaskQuery.isPending ? <p className="text-sm text-ink/60">Loading reports...</p> : null}
        {reportTaskQuery.error ? <p className="text-sm text-red-600">{reportTaskQuery.error.message}</p> : null}
        {createCustomReportMutation.error ? <p className="text-sm text-red-600">{createCustomReportMutation.error.message}</p> : null}
        {deleteCustomReportMutation.error ? <p className="text-sm text-red-600">{deleteCustomReportMutation.error.message}</p> : null}

        {reportView === "frames" ? (
          <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">Frame Outputs</h3>
              <p className="text-xs text-ink/60">Selected for report: {selectedFrameRefs.length}</p>
            </div>
            {frameOutputRows.length === 0 ? (
              <p className="text-sm text-ink/60">No edited frames available.</p>
            ) : (
              <div className="space-y-3">
                {frameOutputRows.map((row) => {
                  const ref: CustomReportOutputRef = { assetType: "frame_variant", frameId: row.frame.frameId, variantId: row.variant.variantId };
                  const checked = Boolean(selectedOutputRefsByTask[`${reportTaskId}:${reportOutputRefKey(ref)}`]);
                  return (
                    <article
                      key={`${row.frame.frameId}:${row.variant.variantId}`}
                      className={`space-y-2 rounded-lg border p-3 transition-colors ${
                        checked ? "border-teal-500 bg-teal-50/50" : "border-ink/10 bg-white"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold">
                          {row.role === "start" ? "Start" : row.role === "end" ? "End" : "Unlinked"} frame edit - frame {row.frame.frameIndex}
                        </p>
                        <label className="flex items-center gap-2 text-xs text-ink/70">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-teal-600"
                            checked={checked}
                            onChange={() => reportTaskId && toggleCustomReportOutput(reportTaskId, ref)}
                          />
                          Include in report
                        </label>
                      </div>
                      <div className="grid gap-3 md:grid-cols-3">
                        <div>
                          <p className="text-xs font-medium text-ink/70">Original frame</p>
                          {row.frame.imageUrl ? <img src={row.frame.imageUrl} alt="Original frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" /> : null}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Mask edit</p>
                          {row.variant.patchMeta?.maskUrl ? (
                            <img src={row.variant.patchMeta.maskUrl} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                          ) : (
                            <p className="text-xs text-ink/50">No mask</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Edited frame</p>
                          {row.variant.imageUrl ? (
                            <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: row.variant.imageUrl as string, label: "Edited frame" })}>
                              <img src={row.variant.imageUrl} alt="Edited frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="rounded border border-ink/10 bg-bg/20 p-2 text-xs text-ink/70">
                        <p>Model: {row.variant.model} ({row.variant.type})</p>
                        <p>Prompt: {framePrompt(row.variant, truncateIdentifier)}</p>
                        <p>{formatCompactTimestamp(row.variant.createdAt)}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {reportView === "videos" ? (
          <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">Video Outputs</h3>
              <p className="text-xs text-ink/60">Selected for report: {selectedVideoRefs.length}</p>
            </div>
            {videoOutputRows.length === 0 ? (
              <p className="text-sm text-ink/60">No generated videos available.</p>
            ) : (
              <div className="space-y-3">
                {videoOutputRows.map((row) => {
                  const ref: CustomReportOutputRef = { assetType: "segment_generation", genId: row.generation.genId };
                  const checked = Boolean(selectedOutputRefsByTask[`${reportTaskId}:${reportOutputRefKey(ref)}`]);
                  return (
                    <article
                      key={row.generation.genId}
                      className={`space-y-2 rounded-lg border p-3 transition-colors ${
                        checked ? "border-teal-500 bg-teal-50/50" : "border-ink/10 bg-white"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold">Generated segment - {row.segment ? describeSegment(row.segment) : row.generation.genId}</p>
                        <label className="flex items-center gap-2 text-xs text-ink/70">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-teal-600"
                            checked={checked}
                            onChange={() => reportTaskId && toggleCustomReportOutput(reportTaskId, ref)}
                          />
                          Include in report
                        </label>
                      </div>
                      <div className="grid gap-3 md:grid-cols-5">
                        <div>
                          <p className="text-xs font-medium text-ink/70">Original start frame</p>
                          {row.startFrame?.imageUrl ? <img src={row.startFrame.imageUrl} alt="Original start frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" /> : null}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Mask edit</p>
                          {row.startVariant?.patchMeta?.maskUrl ? (
                            <img src={row.startVariant.patchMeta.maskUrl} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                          ) : (
                            <p className="text-xs text-ink/50">No mask</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Edited start frame</p>
                          {row.startVariant?.imageUrl ? <img src={row.startVariant.imageUrl} alt="Edited start frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" /> : null}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">End frame</p>
                          {row.endVariant?.imageUrl || row.endFrame?.imageUrl ? (
                            <img src={(row.endVariant?.imageUrl ?? row.endFrame?.imageUrl) as string} alt="End frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                          ) : null}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Generated video</p>
                          {row.generation.downloadUrl ? (
                            <button type="button" className="block w-full" onClick={() => setVideoPreviewModal({ url: row.generation.downloadUrl as string, label: row.generation.genId })}>
                              <img
                                src={row.startVariant?.imageUrl ?? row.startFrame?.imageUrl ?? row.generation.inputFirstFrameUrl ?? ""}
                                alt="Generated video preview"
                                className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                              />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="rounded border border-ink/10 bg-bg/20 p-2 text-xs text-ink/70">
                        <p>Model: {row.generation.luma.model} - {row.generation.luma.mode}</p>
                        <p>Prompt: {row.generation.luma.prompt?.trim() || "No prompt provided"}</p>
                        <p>{formatCompactTimestamp(row.generation.createdAt)}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {reportView === "reports" ? (
          <section className="space-y-4 rounded-2xl border border-ink/10 bg-card p-4">
            <h3 className="text-lg font-semibold">Saved Reports</h3>
            {!reports.length ? (
              <p className="text-sm text-ink/60">No reports created yet.</p>
            ) : (
              <div className="space-y-2">
                {reports.map((report) => (
                  <div key={report.reportId} className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-white p-3">
                    <button type="button" className="text-left" onClick={() => setActiveCustomReportId(report.reportId)}>
                      <p className="text-sm font-semibold">{report.name}</p>
                      <p className="text-xs text-ink/60">
                        {report.reportType === "qc_frame" ? "Frame QC" : "Video QC"} - {report.status} - {report.tests.join(", ")}
                      </p>
                      <p className="text-xs text-ink/50">{formatAssetDate(report.updatedAt)}</p>
                    </button>
                    <div className="flex items-center gap-2">
                      <button type="button" className="rounded border border-ink/20 bg-white px-3 py-1 text-sm" onClick={() => setActiveCustomReportId(report.reportId)}>
                        Open
                      </button>
                      <button
                        type="button"
                        className="rounded border border-red-200 bg-white px-3 py-1 text-sm text-red-700"
                        disabled={deleteCustomReportMutation.isPending}
                        onClick={() => void deleteReport(report)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeReportMeta ? (
              <div className="space-y-3 rounded-xl border border-ink/10 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-lg font-semibold">{activeReportMeta.name}</h4>
                    <p className="text-xs text-ink/60">
                      {activeReportMeta.reportType === "qc_frame" ? "Frame QC" : "Video QC"} - {activeReportMeta.status}
                    </p>
                  </div>
                  {activeReportMeta.error ? <p className="text-sm text-red-600">{activeReportMeta.error}</p> : null}
                </div>

                {activeReportQuery.isPending ? <p className="text-sm text-ink/60">Loading report data...</p> : null}
                {activeReportQuery.error ? <p className="text-sm text-red-600">{activeReportQuery.error.message}</p> : null}

                {activeResult && activeReportMeta.reportType === "qc_frame" ? (
                  <div className="space-y-3">
                    {frameReportRows.map((row) => {
                      const frameMetrics = row.standard?.metrics;
                      const frameArtifacts = row.standard?.artifacts;
                      const advanced = row.advanced;
                      const advancedArtifacts = advanced?.artifacts;
                      const advancedMetrics = advanced?.metrics;
                      const boundaryOverlayUrl =
                        (frameArtifacts?.boundaryOverlayUrl as string | undefined) ??
                        (frameArtifacts?.binaryChangeUrl as string | undefined);
                      const frameHeatmapUrl = frameArtifacts?.heatmapUrl as string | undefined;
                      const frameOverlayUrl = frameArtifacts?.overlayUrl as string | undefined;
                      const frameBinaryUrl = frameArtifacts?.binaryChangeUrl as string | undefined;
                      const advancedCards = [
                        {
                          key: "composite",
                          title: "Composite anomaly map",
                          imageUrl: advancedArtifacts?.compositeMapUrl as string | undefined,
                          main: asNumber(advancedMetrics?.compositeImpactGlobal),
                          mask: asNumber(advancedMetrics?.compositeImpactMask),
                          ring: asNumber(advancedMetrics?.compositeImpactOuterRing),
                        },
                        {
                          key: "lpips",
                          title: "LPIPS patch map",
                          imageUrl: advancedArtifacts?.lpipsMapUrl as string | undefined,
                          main: asNumber(advancedMetrics?.lpips_global_mean),
                          mask: asNumber(advancedMetrics?.lpips_mask_mean),
                          ring: asNumber(advancedMetrics?.lpips_outer_ring_mean),
                        },
                        {
                          key: "boundary",
                          title: "Boundary spill analysis",
                          imageUrl: advancedArtifacts?.boundaryMapUrl as string | undefined,
                          main: asNumber(advancedMetrics?.boundary_spill_score),
                          mask: asNumber(advancedMetrics?.inside_boundary_mean),
                          ring: asNumber(advancedMetrics?.outside_boundary_mean),
                        },
                        {
                          key: "sharpness",
                          title: "Focus / sharpness consistency",
                          imageUrl: advancedArtifacts?.sharpnessMapUrl as string | undefined,
                          main: asNumber(advancedMetrics?.sharpness_mask_mean),
                          mask: asNumber(advancedMetrics?.sharpness_outer_ring_mean),
                          ring: null,
                        },
                        {
                          key: "naturalness",
                          title: "Naturalness map",
                          imageUrl: advancedArtifacts?.naturalnessMapUrl as string | undefined,
                          main: asNumber(advancedMetrics?.naturalness_mask_mean),
                          mask: asNumber(advancedMetrics?.naturalness_outer_ring_mean),
                          ring: null,
                        },
                        {
                          key: "texture",
                          title: "Noise / microtexture map",
                          imageUrl: advancedArtifacts?.textureMapUrl as string | undefined,
                          main: asNumber(advancedMetrics?.texture_mask_mean),
                          mask: asNumber(advancedMetrics?.texture_outer_ring_mean),
                          ring: null,
                        },
                      ].filter((card) => (advanced?.selectedTests ?? []).some((test) => test.includes(card.key) || (card.key === "lpips" && test === "frame_perceptual") || (card.key === "boundary" && test === "frame_boundary") || (card.key === "sharpness" && test === "frame_sharpness") || (card.key === "naturalness" && test === "frame_naturalness") || (card.key === "texture" && test === "frame_texture") || (card.key === "composite" && test === "frame_composite")));
                      return (
                        <article key={`${row.frameId}:${row.variantId}`} className="space-y-2 rounded-lg border border-ink/10 bg-bg/20 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold">
                              {row.role === "start" ? "Start" : row.role === "end" ? "End" : "Unlinked"} frame edit - frame {row.frameIndex}
                            </p>
                            <p className="text-xs text-ink/60">{formatCompactTimestamp(row.createdAt)}</p>
                          </div>
                          <div className="grid gap-3 md:grid-cols-3">
                            <div>
                              <p className="text-xs font-medium text-ink/70">Original frame</p>
                              {row.originalFrameUrl ? <img src={row.originalFrameUrl} alt="Original frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" /> : null}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Mask edit</p>
                              {row.maskUrl ? <img src={row.maskUrl} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" /> : <p className="text-xs text-ink/50">No mask</p>}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Edited frame</p>
                              {row.editedFrameUrl ? <img src={row.editedFrameUrl} alt="Edited frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" /> : null}
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-3">
                            <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70 md:col-span-2">
                              <p className="font-semibold text-ink/90">Edit metadata</p>
                              <p>Model: {row.model} ({row.variantType})</p>
                              <p>Prompt: {row.prompt}</p>
                            </div>
                            <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                              <p className="font-semibold text-ink/90">Frame QC analysis</p>
                              {row.standard ? (
                                <>
                                  <p>Changed: {asNumber(frameMetrics?.changedPctTotal)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Outside leakage: {asNumber(frameMetrics?.outsideLeakagePct)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Boundary spill: {asNumber(frameMetrics?.boundarySpillPct)?.toFixed(2) ?? "n/a"}%</p>
                                </>
                              ) : (
                                <p>No standard frame diff set was selected for this report.</p>
                              )}
                            </div>
                          </div>
                          {row.standard ? (
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Frame diff heatmap</p>
                                {frameHeatmapUrl ? (
                                  <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: frameHeatmapUrl, label: "Frame QC heatmap" })}>
                                    <img src={frameHeatmapUrl} alt="Frame diff heatmap" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No heatmap</p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Frame diff overlay</p>
                                {frameOverlayUrl ? (
                                  <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: frameOverlayUrl, label: "Frame QC overlay" })}>
                                    <img src={frameOverlayUrl} alt="Frame diff overlay" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No overlay</p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Boundary/Binary map</p>
                                {boundaryOverlayUrl || frameBinaryUrl ? (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    onClick={() => setImagePreviewModal({ url: (boundaryOverlayUrl ?? frameBinaryUrl) as string, label: "Frame QC boundary map" })}
                                  >
                                    <img src={(boundaryOverlayUrl ?? frameBinaryUrl) as string} alt="Frame QC boundary map" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No boundary or binary map</p>
                                )}
                              </div>
                            </div>
                          ) : null}
                          {advanced ? (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-2">
                                <p className="text-sm font-semibold text-ink/90">Advanced QC analysis</p>
                                <p
                                  className={`text-xs uppercase tracking-wide ${
                                    advanced.status === "pass"
                                      ? "text-emerald-700"
                                      : advanced.status === "warn"
                                        ? "text-amber-700"
                                        : advanced.status === "fail"
                                          ? "text-red-700"
                                          : "text-ink/60"
                                  }`}
                                >
                                  Overall status: {advanced.status ?? "n/a"}
                                </p>
                              </div>
                              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {advancedCards.map((card) => (
                                  <div key={card.key} className="space-y-2 rounded border border-ink/10 bg-bg/20 p-2">
                                    <p className="text-xs font-semibold text-ink/90">{card.title}</p>
                                    <p className="text-[11px] text-ink/70">Main: {card.main !== null ? card.main.toFixed(4) : "n/a"}</p>
                                    <p className="text-[11px] text-ink/70">Mask: {card.mask !== null ? card.mask.toFixed(4) : "n/a"}</p>
                                    <p className="text-[11px] text-ink/70">Outer ring: {card.ring !== null ? card.ring.toFixed(4) : "n/a"}</p>
                                    {card.imageUrl ? (
                                      <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: card.imageUrl as string, label: card.title })}>
                                        <img src={card.imageUrl} alt={card.title} className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                      </button>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                    {activeResult.failures?.length ? (
                      <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {activeResult.failures.length} frame asset(s) failed during report build.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {activeResult && activeReportMeta.reportType === "qc_video" ? (
                  <div className="space-y-3">
                    {videoReportRows.map((row) => {
                      const videoAggregates = row.standard?.aggregates;
                      const videoArtifacts = row.standard?.artifacts;
                      const timelineGraphUrl = videoArtifacts?.timelineGraphUrl as string | undefined;
                      const timelineCsvUrl = videoArtifacts?.timelineCsvUrl as string | undefined;
                      const diffVideoUrl = videoArtifacts?.diffVideoUrl as string | undefined;
                      const selectedFrames = (row.standard?.selectedFrames ?? []) as Array<Record<string, unknown>>;
                      return (
                        <article key={row.genId} className="space-y-3 rounded-lg border border-ink/10 bg-bg/20 p-3">
                          <div className="grid gap-3 overflow-x-auto xl:grid-cols-5">
                            <div>
                              <p className="text-xs font-medium text-ink/70">Original start frame</p>
                              {row.originalFrameUrl ? <img src={row.originalFrameUrl} alt="Original start frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" /> : null}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Mask edit</p>
                              {row.maskUrl ? <img src={row.maskUrl} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" /> : <p className="text-xs text-ink/50">No mask</p>}
                              <p className="mt-2 text-xs text-ink/70">{row.prompt}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Edited start frame</p>
                              {row.editedStartFrameUrl ? <img src={row.editedStartFrameUrl} alt="Edited start frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" /> : null}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">End frame</p>
                              {row.endFrameUrl ? <img src={row.endFrameUrl} alt="End frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" /> : <p className="text-xs text-ink/50">No end frame</p>}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Generated video</p>
                              {row.generatedVideoUrl ? (
                                <button type="button" className="block w-full" onClick={() => setVideoPreviewModal({ url: row.generatedVideoUrl as string, label: row.genId })}>
                                  <img src={row.editedStartFrameUrl ?? row.originalFrameUrl ?? ""} alt="Generated video" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                </button>
                              ) : null}
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-5">
                            <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                              <p className="font-semibold text-ink/90">Video QC analysis</p>
                              {row.standard ? (
                                <>
                                  <p>Changed mean: {asNumber(videoAggregates?.changedPctTotalMean)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Outside leak mean: {asNumber(videoAggregates?.outsideLeakagePctMean)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>SSIM mean: {asNumber(videoAggregates?.ssimMean)?.toFixed(4) ?? "n/a"}</p>
                                  <p>PSNR mean: {asNumber(videoAggregates?.psnrMean)?.toFixed(2) ?? "n/a"}</p>
                                </>
                              ) : (
                                <p>No video diff tests were selected for this report.</p>
                              )}
                            </div>
                            <div className="md:col-span-2">
                              <p className="text-xs font-medium text-ink/70">Timeline graph</p>
                              {timelineGraphUrl ? (
                                <button type="button" className="block w-full" onClick={() => setReportGraphModal({ url: timelineGraphUrl, label: "Video QC timeline graph" })}>
                                  <img src={timelineGraphUrl} alt="Timeline graph" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                </button>
                              ) : (
                                <p className="text-xs text-ink/50">No timeline graph</p>
                              )}
                              {timelineCsvUrl ? (
                                <a href={timelineCsvUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-ink underline">
                                  Download CSV
                                </a>
                              ) : null}
                            </div>
                            <div className="md:col-span-2">
                              <p className="text-xs font-medium text-ink/70">Diff video map</p>
                              {diffVideoUrl ? (
                                <button type="button" className="block w-full" onClick={() => setVideoPreviewModal({ url: diffVideoUrl, label: "Video diff map" })}>
                                  <img src={row.editedStartFrameUrl ?? row.originalFrameUrl ?? ""} alt="Diff video map" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                </button>
                              ) : (
                                <p className="text-xs text-ink/50">No diff video map</p>
                              )}
                            </div>
                          </div>
                          {(row.standard?.selectedTests ?? []).includes("video_frame_evidence") && selectedFrames.length ? (
                            <div className="grid gap-3 md:grid-cols-3">
                              {selectedFrames.slice(0, 3).map((frame) => (
                                <div key={`video-frame-${row.genId}-${frame.index}`} className="space-y-1">
                                  <p className="text-xs font-medium text-ink/70">Evidence frame {String(frame.index)}</p>
                                  {frame.overlayUrl ? (
                                    <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: frame.overlayUrl as string, label: `Video evidence frame ${String(frame.index)}` })}>
                                      <img src={frame.overlayUrl as string} alt="Video evidence frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                    </button>
                                  ) : (
                                    <p className="text-xs text-ink/50">No evidence image</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                    {activeResult.failures?.length ? (
                      <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {activeResult.failures.length} video asset(s) failed during report build.
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <ReportCreateModal
        isOpen={createModalMode !== null}
        title={createModalMode === "qc_frame" ? "Create Frame QC Report" : "Create Video QC Report"}
        selectedCount={createModalMode === "qc_frame" ? selectedFrameRefs.length : selectedVideoRefs.length}
        reportName={reportName}
        setReportName={setReportName}
        tests={createModalMode === "qc_frame" ? FRAME_TEST_OPTIONS : VIDEO_TEST_OPTIONS}
        selectedTests={selectedTests}
        toggleTest={toggleTest}
        onClose={closeCreateModal}
        onCreate={() => void createReport()}
        isPending={createCustomReportMutation.isPending}
      />
    </main>
  );
}

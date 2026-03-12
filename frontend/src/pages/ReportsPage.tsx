import { useEffect, useMemo, useRef } from "react";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import type {
  CustomReportOutputRef,
  CustomReportRecord,
  FrameRecord,
  FrameVariant,
  JobStatus,
  SegmentGeneration,
  SegmentRecord,
  TaskDetail,
} from "../types/api";

type ReportGenerationRow = {
  generation: SegmentGeneration;
  segment: SegmentRecord | null;
  startFrame: FrameRecord | null;
  endFrame: FrameRecord | null;
  startVariant: FrameVariant | null;
  endVariant: FrameVariant | null;
  originalUrl: string | null;
  maskUrl: string | null;
  editedUrl: string | null;
  endFrameUrl: string | null;
  generatedVideoUrl: string | null;
};

type VideoGenerationGroup = "start_video" | "start_end" | "start_only";
const AUTO_QC_RETRY_MS = 45_000;

type ReportView = "outputs" | "qc_frame" | "qc_video";

type ReportOutputGroup = "video_generations" | "start_frames" | "end_frames";

type ReportOutputCard = {
  id: string;
  taskId: string;
  group: ReportOutputGroup;
  title: string;
  subtitle: string;
  createdAt: string;
  modelLabel: string;
  promptLabel: string;
  imageUrl: string | null;
  videoUrl: string | null;
  selectionRef: CustomReportOutputRef;
};

type QcFrameResult = {
  metrics?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
};

type QcFrameRow = {
  id: string;
  frame: FrameRecord;
  variant: FrameVariant;
  role: "start" | "end" | "unlinked";
  linkedGenerations: ReportGenerationRow[];
  qcGeneration: ReportGenerationRow | null;
};

type VideoSelectedFrameArtifact = {
  index: number;
  timeSec: number;
  heatmapUrl?: string;
  overlayUrl?: string;
  binaryChangeUrl?: string;
  [key: string]: unknown;
};

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
  runQcMutation: UseMutationResult<
    { jobId: string },
    Error,
    { taskId: string; generationIds?: string[] },
    unknown
  >;
  renderCustomReportBox: (taskId: string | null, reports: CustomReportRecord[] | undefined) => React.ReactNode;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  setVideoPreviewModal: (value: { url: string; label: string } | null) => void;
  setImagePreviewModal: (value: { url: string; label: string } | null) => void;
  formatCompactTimestamp: (iso: string | undefined) => string;
  asNumber: (value: unknown) => number | null;
  describeSegment: (segment: SegmentRecord) => string;
  fpsValue: (task: TaskDetail | undefined) => number;
  reportGraphModal: { url: string; label: string } | null;
  setReportGraphModal: (value: { url: string; label: string } | null) => void;
};

type ReportsPageProps = {
  ctx: ReportsPageCtx;
};

function safeTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function generationThumbnailUrl(generation: SegmentGeneration): string | null {
  return (
    generation.inputFirstFrameUrl ??
    generation.sourceFirstFrameCaptureUrl ??
    generation.inputLastFrameUrl ??
    generation.sourceLastFrameCaptureUrl ??
    null
  );
}

function classifyVideoGeneration(row: ReportGenerationRow): VideoGenerationGroup {
  const model = row.generation.luma.model;
  if (model === "ray-2" || model === "ray-flash-2" || model === "wan2.2-animate") {
    return "start_video";
  }
  if (model === "runway-gen4.5" || model === "wan2.2-a14b") {
    return "start_only";
  }
  const firstKey = row.generation.sourceFirstFrameResolvedKey ?? row.generation.inputFirstFrameKey ?? null;
  const lastKey = row.generation.sourceLastFrameResolvedKey ?? row.generation.inputLastFrameKey ?? null;
  if (!lastKey) return "start_only";
  if (firstKey && firstKey === lastKey) return "start_end";
  return "start_end";
}

function frameQcForVariant(generation: SegmentGeneration, variantId: string, variantOutputKey?: string | null): QcFrameResult | null {
  const qc = generation.qc;
  if (!qc) return null;
  const frameByVariant = (qc.frameByVariant as Record<string, QcFrameResult> | undefined) ?? undefined;
  if (frameByVariant?.[variantId]) return frameByVariant[variantId];
  if (generation.sourceFirstFrameVariantId === variantId && qc.frame) return qc.frame as QcFrameResult;
  if (
    qc.frame &&
    variantOutputKey &&
    !generation.sourceFirstFrameVariantId &&
    (generation.sourceFirstFrameResolvedKey === variantOutputKey || generation.inputFirstFrameKey === variantOutputKey)
  ) {
    return qc.frame as QcFrameResult;
  }
  return null;
}

function hasFrameQcArtifacts(frameQc: QcFrameResult | null): boolean {
  const artifacts = frameQc?.artifacts as Record<string, unknown> | undefined;
  if (!artifacts) return false;
  return Boolean(
    artifacts.heatmapUrl ||
      artifacts.heatmapKey ||
      artifacts.overlayUrl ||
      artifacts.overlayKey ||
      artifacts.binaryChangeUrl ||
      artifacts.binaryChangeKey ||
      artifacts.boundaryOverlayUrl ||
      artifacts.boundaryOverlayKey,
  );
}

function generationNeedsQcForVideo(generation: SegmentGeneration): boolean {
  if (generation.status !== "complete" || !generation.outputKey) return false;
  const qc = generation.qc;
  if (!qc) return true;
  if (qc.status === "running") return false;
  if (qc.status !== "complete") return true;
  const artifacts = qc.video?.artifacts as Record<string, unknown> | undefined;
  const hasVideoArtifacts = Boolean(
    artifacts?.diffVideoUrl ||
      artifacts?.diffVideoKey ||
      artifacts?.timelineGraphUrl ||
      artifacts?.timelineGraphKey ||
      artifacts?.timelineCsvUrl ||
      artifacts?.timelineCsvKey,
  );
  const selectedFrames = qc.video?.selectedFrames ?? [];
  return !hasVideoArtifacts || selectedFrames.length === 0;
}

function generationNeedsQcForFrameVariant(generation: SegmentGeneration, variant: FrameVariant): boolean {
  if (generation.status !== "complete" || !generation.outputKey) return false;
  const qc = generation.qc;
  if (!qc) return true;
  if (qc.status === "running") return false;
  if (qc.status !== "complete") return true;
  return !hasFrameQcArtifacts(frameQcForVariant(generation, variant.variantId, variant.outputKey));
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
    runQcMutation,
    renderCustomReportBox,
    toggleCustomReportOutput,
    setVideoPreviewModal,
    setImagePreviewModal,
    formatCompactTimestamp,
    asNumber,
    describeSegment,
    fpsValue,
    reportGraphModal,
    setReportGraphModal,
  } = ctx;

  const requestedAutoQcRef = useRef<Map<string, number>>(new Map());
  const reportSegmentsById = useMemo(
    () => new Map((reportTask?.segments ?? []).map((segment) => [segment.segmentId, segment])),
    [reportTask?.segments],
  );
  const reportRows = useMemo(() => {
    if (!reportTask) return { rows: [] as ReportGenerationRow[] };
    const frameById = reportTask.frames ?? {};
    const resolveVariant = (
      frame: FrameRecord | null,
      preferredVariantId: string | null | undefined,
      preferredOutputKey: string | null | undefined,
      fallbackOutputKey: string | null | undefined,
    ): FrameVariant | null => {
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
    };
    const allRows: ReportGenerationRow[] = Object.values(reportTask.segmentGenerations ?? {})
      .filter((generation) => generation.status !== "failed")
      .map((generation) => {
        const segment = reportSegmentsById.get(generation.segmentId) ?? null;
        const startFrame = segment ? frameById[segment.startFrameId] ?? null : null;
        const endFrame = segment ? frameById[segment.endFrameId] ?? null : null;
        const startVariant = resolveVariant(
          startFrame,
          generation.sourceFirstFrameVariantId,
          generation.sourceFirstFrameResolvedKey,
          generation.inputFirstFrameKey,
        );
        const endVariant = resolveVariant(
          endFrame,
          generation.sourceLastFrameVariantId,
          generation.sourceLastFrameResolvedKey,
          generation.inputLastFrameKey,
        );
        return {
          generation,
          segment,
          startFrame,
          endFrame,
          startVariant,
          endVariant,
          originalUrl: startFrame?.imageUrl ?? generation.sourceFirstFrameCaptureUrl ?? null,
          maskUrl: (startVariant?.patchMeta?.maskUrl as string | undefined) ?? null,
          editedUrl: startVariant?.imageUrl ?? generation.inputFirstFrameUrl ?? null,
          endFrameUrl: endVariant?.imageUrl ?? generation.inputLastFrameUrl ?? endFrame?.imageUrl ?? null,
          generatedVideoUrl: generation.downloadUrl ?? null,
        };
      });
    const sortScore = (row: ReportGenerationRow) => (row.generatedVideoUrl ? 0 : 1);
    allRows.sort((a, b) => sortScore(a) - sortScore(b) || safeTimestamp(b.generation.createdAt) - safeTimestamp(a.generation.createdAt));
    return { rows: allRows };
  }, [reportSegmentsById, reportTask]);
  const reportCustomReports = useMemo(
    () => [...(reportTask?.customReports ?? [])].sort((a, b) => safeTimestamp(b.updatedAt) - safeTimestamp(a.updatedAt)),
    [reportTask?.customReports],
  );
  const activeCustomReport = useMemo(
    () => reportCustomReports.find((report) => report.reportId === activeCustomReportId) ?? null,
    [activeCustomReportId, reportCustomReports],
  );
  const reportOutputCards = useMemo(() => {
    if (!reportTask) {
      return {
        videoGenerations: [] as ReportOutputCard[],
        startFrames: [] as ReportOutputCard[],
        endFrames: [] as ReportOutputCard[],
      };
    }
    const startFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.startFrameId));
    const endFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.endFrameId));
    const videoCards: ReportOutputCard[] = reportRows.rows
      .filter((row) => Boolean(row.generatedVideoUrl))
      .map((row) => ({
        id: `report-card:gen:${row.generation.genId}`,
        taskId: reportTask.taskId,
        group: "video_generations",
        title: row.segment ? `Segment ${row.segment.segmentId}` : row.generation.genId,
        subtitle: row.segment
          ? `${row.segment.startFrame}-${Math.max(row.segment.startFrame, row.segment.endFrameExclusive - 1)} · ${row.segment.durationSec.toFixed(2)}s`
          : row.generation.segmentId,
        createdAt: row.generation.createdAt,
        modelLabel: row.generation.luma.model,
        promptLabel: row.generation.luma.prompt?.trim() || "No prompt provided",
        imageUrl: row.editedUrl ?? row.originalUrl ?? generationThumbnailUrl(row.generation),
        videoUrl: row.generatedVideoUrl,
        selectionRef: { assetType: "segment_generation", genId: row.generation.genId },
      }));
    const startCards: ReportOutputCard[] = [];
    const endCards: ReportOutputCard[] = [];
    for (const frame of Object.values(reportTask.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.imageUrl) continue;
        const baseCard: ReportOutputCard = {
          id: `report-card:variant:${frame.frameId}:${variant.variantId}`,
          taskId: reportTask.taskId,
          group: startFrameIds.has(frame.frameId) ? "start_frames" : "end_frames",
          title: `Frame ${frame.frameIndex} (${frame.timecode})`,
          subtitle: startFrameIds.has(frame.frameId)
            ? "Start frame edit"
            : endFrameIds.has(frame.frameId)
              ? "End frame edit"
              : "Unlinked frame edit",
          createdAt: variant.createdAt,
          modelLabel: `${variant.model} (${variant.type})`,
          promptLabel: `Prompt hash ${truncateIdentifier(variant.promptHash, 16)}`,
          imageUrl: variant.imageUrl,
          videoUrl: null,
          selectionRef: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
        };
        if (startFrameIds.has(frame.frameId)) {
          startCards.push(baseCard);
        } else if (endFrameIds.has(frame.frameId)) {
          endCards.push(baseCard);
        } else {
          startCards.push(baseCard);
        }
      }
    }
    const byCreated = (a: ReportOutputCard, b: ReportOutputCard) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt);
    videoCards.sort(byCreated);
    startCards.sort(byCreated);
    endCards.sort(byCreated);
    return { videoGenerations: videoCards, startFrames: startCards, endFrames: endCards };
  }, [reportRows.rows, reportTask, truncateIdentifier]);
  const activeReportGenerationIds = useMemo(() => {
    const ids = new Set<string>();
    if (!activeCustomReport) return ids;
    for (const ref of activeCustomReport.outputRefs ?? []) {
      if (ref.assetType === "segment_generation") ids.add(ref.genId);
    }
    return ids;
  }, [activeCustomReport]);
  const activeReportFrameVariantKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!activeCustomReport) return keys;
    for (const ref of activeCustomReport.outputRefs ?? []) {
      if (ref.assetType === "frame_variant") {
        keys.add(`${ref.frameId}:${ref.variantId}`);
      }
    }
    return keys;
  }, [activeCustomReport]);
  const scopedVideoRows = useMemo(() => {
    const rows = reportRows.rows.filter((row) => Boolean(row.generation.outputKey));
    if (!activeCustomReport) return rows;
    return rows.filter((row) => activeReportGenerationIds.has(row.generation.genId));
  }, [activeCustomReport, activeReportGenerationIds, reportRows.rows]);
  const qcFrameRows = useMemo(() => {
    if (!reportTask) return [] as QcFrameRow[];
    const startFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.startFrameId));
    const endFrameIds = new Set((reportTask.segments ?? []).map((segment) => segment.endFrameId));
    const generationRowsByVariant = new Map<string, ReportGenerationRow[]>();
    const variantIdsByOutputKey = new Map<string, string[]>();
    for (const frame of Object.values(reportTask.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.outputKey) continue;
        const existing = variantIdsByOutputKey.get(variant.outputKey) ?? [];
        if (!existing.includes(variant.variantId)) {
          variantIdsByOutputKey.set(variant.outputKey, [...existing, variant.variantId]);
        }
      }
    }
    for (const row of reportRows.rows) {
      const linkedIds = new Set<string>();
      for (const variantId of [row.generation.sourceFirstFrameVariantId, row.generation.sourceLastFrameVariantId]) {
        if (!variantId) continue;
        linkedIds.add(variantId);
      }
      for (const key of [
        row.generation.sourceFirstFrameResolvedKey,
        row.generation.inputFirstFrameKey,
        row.generation.sourceLastFrameResolvedKey,
        row.generation.inputLastFrameKey,
      ]) {
        if (!key) continue;
        for (const resolvedId of variantIdsByOutputKey.get(key) ?? []) {
          linkedIds.add(resolvedId);
        }
      }
      for (const variantId of linkedIds) {
        if (!variantId) continue;
        const existing = generationRowsByVariant.get(variantId) ?? [];
        generationRowsByVariant.set(variantId, [...existing, row]);
      }
      for (const variant of row.startFrame?.variants ?? []) {
        if (!variant.variantId || !variant.outputKey) continue;
        const existing = generationRowsByVariant.get(variant.variantId) ?? [];
        generationRowsByVariant.set(variant.variantId, [...existing, row]);
      }
      for (const variant of row.endFrame?.variants ?? []) {
        if (!variant.variantId || !variant.outputKey) continue;
        const existing = generationRowsByVariant.get(variant.variantId) ?? [];
        generationRowsByVariant.set(variant.variantId, [...existing, row]);
      }
    }
    const rows: QcFrameRow[] = [];
    for (const frame of Object.values(reportTask.frames ?? {})) {
      for (const variant of frame.variants ?? []) {
        if (!variant.imageUrl) continue;
        const refKey = `${frame.frameId}:${variant.variantId}`;
        const linkedGenerations = generationRowsByVariant.get(variant.variantId) ?? [];
        if (activeCustomReport) {
          const includedByRef = activeReportFrameVariantKeys.has(refKey);
          const includedByGeneration = linkedGenerations.some((row) => activeReportGenerationIds.has(row.generation.genId));
          if (!includedByRef && !includedByGeneration) continue;
        }
        const qcGeneration =
          linkedGenerations.find(
            (row) =>
              row.generation.qc?.status === "complete" &&
              hasFrameQcArtifacts(frameQcForVariant(row.generation, variant.variantId, variant.outputKey)),
          ) ??
          linkedGenerations.find((row) => row.generation.qc?.status === "running") ??
          linkedGenerations.find((row) => row.generation.qc?.status === "complete") ??
          linkedGenerations[0] ??
          null;
        const role: "start" | "end" | "unlinked" = startFrameIds.has(frame.frameId)
          ? "start"
          : endFrameIds.has(frame.frameId)
            ? "end"
            : "unlinked";
        rows.push({
          id: `qc-frame:${frame.frameId}:${variant.variantId}`,
          frame,
          variant,
          role,
          linkedGenerations,
          qcGeneration,
        });
      }
    }
    return rows.sort((a, b) => safeTimestamp(b.variant.createdAt) - safeTimestamp(a.variant.createdAt));
  }, [activeCustomReport, activeReportFrameVariantKeys, activeReportGenerationIds, reportRows.rows, reportTask]);
  const qcVideoRowsByGroup = useMemo(() => {
    const grouped: Record<VideoGenerationGroup, ReportGenerationRow[]> = {
      start_video: [],
      start_end: [],
      start_only: [],
    };
    for (const row of scopedVideoRows) {
      grouped[classifyVideoGeneration(row)].push(row);
    }
    return grouped;
  }, [scopedVideoRows]);
  const scopedQcGenerationIdsNeedingRun = useMemo(() => {
    if (!reportTask || reportView === "outputs") return [] as string[];
    const ids = new Set<string>();
    if (reportView === "qc_video") {
      for (const row of scopedVideoRows) {
        if (generationNeedsQcForVideo(row.generation)) ids.add(row.generation.genId);
      }
      return [...ids];
    }
    for (const row of qcFrameRows) {
      for (const linked of row.linkedGenerations) {
        if (generationNeedsQcForFrameVariant(linked.generation, row.variant)) {
          ids.add(linked.generation.genId);
        }
      }
    }
    return [...ids];
  }, [qcFrameRows, reportTask, reportView, scopedVideoRows]);
  const isQcView = reportView === "qc_frame" || reportView === "qc_video";
  const hasMissingQc = scopedQcGenerationIdsNeedingRun.length > 0;

  async function runMissingQcNow() {
    if (!reportTask || !hasMissingQc) return;
    const generationIds = [...scopedQcGenerationIdsNeedingRun].sort();
    for (let index = 0; index < generationIds.length; index += 20) {
      const batch = generationIds.slice(index, index + 20);
      await runQcMutation.mutateAsync({ taskId: reportTask.taskId, generationIds: batch });
    }
  }

  const latestQcJob =
    sortedJobs.find((job) => job.type === "qc_analysis" && (!reportTaskId || job.taskId === reportTaskId)) ?? null;

  useEffect(() => {
    if (!activeCustomReportId) return;
    if (!reportCustomReports.some((report) => report.reportId === activeCustomReportId)) {
      setActiveCustomReportId(null);
    }
  }, [activeCustomReportId, reportCustomReports, setActiveCustomReportId]);

  useEffect(() => {
    requestedAutoQcRef.current.clear();
  }, [activeCustomReportId, reportTaskId, reportView]);

  useEffect(() => {
    if (!reportTask || reportView === "outputs") return;
    if (!scopedQcGenerationIdsNeedingRun.length) return;
    const sortedMissing = [...scopedQcGenerationIdsNeedingRun].sort();
    void (async () => {
      for (let index = 0; index < sortedMissing.length; index += 20) {
        const generationIds = sortedMissing.slice(index, index + 20);
        const chunkKey = `${reportTask.taskId}:${reportView}:${activeCustomReportId ?? "default"}:${generationIds.join(",")}`;
        const now = Date.now();
        const lastRequestedAt = requestedAutoQcRef.current.get(chunkKey) ?? 0;
        if (now - lastRequestedAt < AUTO_QC_RETRY_MS) continue;
        requestedAutoQcRef.current.set(chunkKey, now);
        try {
          await runQcMutation.mutateAsync({ taskId: reportTask.taskId, generationIds });
        } catch {
          requestedAutoQcRef.current.delete(chunkKey);
          break;
        }
      }
    })();
  }, [activeCustomReportId, reportTask, reportView, runQcMutation, scopedQcGenerationIdsNeedingRun]);

  useEffect(() => {
    const status = latestQcJob?.status;
    if (status !== "queued" && status !== "running") return;
    const timer = window.setInterval(() => {
      void reportTaskQuery.refetch();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [latestQcJob?.jobId, latestQcJob?.status, reportTaskQuery]);

  const reportPlaybackUrl = reportTask?.video?.editSource?.downloadUrl ?? reportTask?.video?.original?.downloadUrl ?? null;
  const selectedRefKeys = new Set(
    reportTaskId ? (selectedOutputRefsByTask[reportTaskId] ?? []).map((ref) => reportOutputRefKey(ref)) : [],
  );
  const qcVideoGroupLabels: Record<VideoGenerationGroup, string> = {
    start_video: "Start Frame + Source Video",
    start_end: "Start Frame + End Frame",
    start_only: "Start Frame Only",
  };

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto w-full max-w-[1700px] space-y-4 p-4 md:p-6">
        <div className="flex items-center justify-between rounded-2xl border border-ink/10 bg-card p-4">
          <div>
            <h2 className="text-xl font-semibold">Task Report: {reportTask?.name ?? reportTaskId ?? "Task"}</h2>
            {reportTask ? <p className="text-sm text-ink/60">Updated {formatAssetDate(reportTask.updatedAt)}</p> : null}
            {activeCustomReport ? (
              <p className="text-xs text-ink/60">
                Custom: {activeCustomReport.name} ({activeCustomReport.reportType === "qc_frame" ? "QC Frame" : "QC Video"})
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
              onClick={() => {
                if (reportTaskId) {
                  goToTaskTimeline(reportTaskId);
                }
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
          <button
            className={`rounded px-3 py-2 text-sm ${reportView === "outputs" ? "bg-ink text-white" : "bg-ink/10"}`}
            onClick={() => {
              setReportView("outputs");
              setActiveCustomReportId(null);
            }}
          >
            Output Report
          </button>
          <button
            className={`rounded px-3 py-2 text-sm ${reportView === "qc_frame" ? "bg-ink text-white" : "bg-ink/10"}`}
            onClick={() => {
              setReportView("qc_frame");
              if (!activeCustomReport || activeCustomReport.reportType !== "qc_frame") {
                setActiveCustomReportId(null);
              }
            }}
          >
            QC Frame Report
          </button>
          <button
            className={`rounded px-3 py-2 text-sm ${reportView === "qc_video" ? "bg-ink text-white" : "bg-ink/10"}`}
            onClick={() => {
              setReportView("qc_video");
              if (!activeCustomReport || activeCustomReport.reportType !== "qc_video") {
                setActiveCustomReportId(null);
              }
            }}
          >
            QC Video Report
          </button>
          <button
            type="button"
            className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
            onClick={() => {
              if (typeof document === "undefined") return;
              document.getElementById("custom-report-builder")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            Custom Reports
          </button>
          <button
            type="button"
            className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
            onClick={() => {
              void reportTaskQuery.refetch();
            }}
          >
            Refresh Report Data
          </button>
          {isQcView ? (
            <button
              type="button"
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!reportTask || !hasMissingQc || runQcMutation.isPending}
              onClick={() => {
                void runMissingQcNow();
              }}
            >
              {runQcMutation.isPending ? "Running QC..." : hasMissingQc ? "Run Missing QC Now" : "QC Up To Date"}
            </button>
          ) : null}
        </div>
        {latestQcJob ? (
          <p className="text-xs text-ink/70">
            Latest QC job {truncateIdentifier(latestQcJob.jobId, 12)}: {latestQcJob.status} ({latestQcJob.progress}%)
          </p>
        ) : null}

        {reportTaskQuery.isPending ? <p className="text-sm text-ink/60">Loading report...</p> : null}
        {reportTaskQuery.error ? <p className="text-sm text-red-600">{(reportTaskQuery.error as Error).message}</p> : null}
        {runQcMutation.error ? <p className="text-sm text-red-600">{runQcMutation.error.message}</p> : null}

        {reportTask ? (
          <>
            {reportView === "outputs" ? (
              <>
                <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                  <h3 className="text-lg font-semibold">Task Playback</h3>
                  {reportPlaybackUrl ? (
                    <video
                      src={reportPlaybackUrl}
                      controls
                      preload="metadata"
                      className="w-full rounded border border-ink/10 bg-bg object-contain"
                    />
                  ) : (
                    <p className="text-sm text-ink/60">Original video not available.</p>
                  )}
                </section>
                {[
                  { title: "Video Generations", items: reportOutputCards.videoGenerations },
                  { title: "Start Frames", items: reportOutputCards.startFrames },
                  { title: "End Frames", items: reportOutputCards.endFrames },
                ].map((section) => (
                  <section key={section.title} className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
                    <h3 className="text-lg font-semibold">{section.title}</h3>
                    {section.items.length === 0 ? (
                      <p className="text-sm text-ink/60">No outputs in this section yet.</p>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {section.items.map((card: ReportOutputCard) => (
                          <article key={card.id} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                            <label className="flex items-center gap-2 text-xs text-ink/70">
                              <input
                                type="checkbox"
                                checked={selectedRefKeys.has(reportOutputRefKey(card.selectionRef))}
                                onChange={() => toggleCustomReportOutput(card.taskId, card.selectionRef)}
                              />
                              QC
                            </label>
                            {card.imageUrl ? (
                              <button
                                type="button"
                                className="block w-full"
                                onClick={() => {
                                  if (card.videoUrl) {
                                    setVideoPreviewModal({ url: card.videoUrl, label: card.title });
                                  } else {
                                    setImagePreviewModal({ url: card.imageUrl as string, label: card.title });
                                  }
                                }}
                              >
                                <img
                                  src={card.imageUrl}
                                  alt={card.title}
                                  className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                />
                              </button>
                            ) : card.videoUrl ? (
                              <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                                Preview unavailable
                              </div>
                            ) : (
                              <div className="rounded border border-dashed border-ink/20 p-4 text-sm text-ink/50">
                                Preview unavailable
                              </div>
                            )}
                            <div className="space-y-1">
                              <p className="text-sm font-semibold">{card.title}</p>
                              <p className="text-xs text-ink/70">{card.subtitle}</p>
                              <p className="text-xs text-ink/70">Model: {card.modelLabel}</p>
                              <p className="text-xs text-ink/70">Prompt: {card.promptLabel}</p>
                              <p className="text-[11px] text-ink/50">{formatCompactTimestamp(card.createdAt)}</p>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </>
            ) : null}

            {reportView === "qc_frame" ? (
              <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">QC Frame Report</h3>
                {qcFrameRows.length === 0 ? (
                  <p className="text-sm text-ink/60">No frame edits available for this report scope.</p>
                ) : (
                  <div className="space-y-3">
                    {qcFrameRows.map((row: QcFrameRow) => {
                      const frameQc = row.qcGeneration
                        ? frameQcForVariant(row.qcGeneration.generation, row.variant.variantId, row.variant.outputKey)
                        : null;
                      const frameMetrics = frameQc?.metrics as Record<string, unknown> | undefined;
                      const frameArtifacts = frameQc?.artifacts as Record<string, unknown> | undefined;
                      const boundaryOverlayUrl =
                        (frameArtifacts?.boundaryOverlayUrl as string | undefined) ??
                        (frameArtifacts?.binaryChangeUrl as string | undefined);
                      const frameHeatmapUrl = frameArtifacts?.heatmapUrl as string | undefined;
                      const frameOverlayUrl = frameArtifacts?.overlayUrl as string | undefined;
                      const frameBinaryUrl = frameArtifacts?.binaryChangeUrl as string | undefined;
                      const variantPrompt =
                        (row.variant.generationSettings?.prompt as string | undefined) ??
                        row.qcGeneration?.generation.luma.prompt ??
                        `Prompt hash ${truncateIdentifier(row.variant.promptHash, 16)}`;
                      const qcStatus = row.qcGeneration?.generation.qc?.status ?? "not_run";
                      const hasFrameQc = qcStatus === "complete" && hasFrameQcArtifacts(frameQc);
                      return (
                        <article key={row.id} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold">
                              {row.role === "start" ? "Start" : row.role === "end" ? "End" : "Unlinked"} frame edit · frame {row.frame.frameIndex}
                            </p>
                            <label className="flex items-center gap-2 text-xs text-ink/70">
                              <input
                                type="checkbox"
                                checked={selectedRefKeys.has(
                                  reportOutputRefKey({ assetType: "frame_variant", frameId: row.frame.frameId, variantId: row.variant.variantId }),
                                )}
                                onChange={() =>
                                  toggleCustomReportOutput(reportTask.taskId, {
                                    assetType: "frame_variant",
                                    frameId: row.frame.frameId,
                                    variantId: row.variant.variantId,
                                  })
                                }
                              />
                              QC
                            </label>
                          </div>
                          <div className="grid gap-3 md:grid-cols-4">
                            <div>
                              <p className="text-xs font-medium text-ink/70">Original frame</p>
                              {row.frame.imageUrl ? (
                                <img src={row.frame.imageUrl} alt="Original frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <p className="text-xs text-ink/50">Unavailable</p>
                              )}
                              <p className="mt-1 text-[11px] text-ink/70">Model: {row.variant.model} ({row.variant.type})</p>
                              <p className="text-[11px] text-ink/70">Prompt: {variantPrompt}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Mask edit</p>
                              {(row.variant.patchMeta?.maskUrl as string | undefined) ? (
                                <img src={row.variant.patchMeta?.maskUrl as string} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <p className="text-xs text-ink/50">No mask</p>
                              )}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Edited frame</p>
                              {row.variant.imageUrl ? (
                                <img src={row.variant.imageUrl} alt="Edited frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <p className="text-xs text-ink/50">Unavailable</p>
                              )}
                            </div>
                            <div className="rounded border border-ink/10 bg-bg/40 p-2 text-xs text-ink/70">
                              <p className="font-semibold text-ink/90">Frame QC analysis</p>
                              {hasFrameQc ? (
                                <>
                                  <p>Changed: {asNumber(frameMetrics?.changedPctTotal)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Outside leakage: {asNumber(frameMetrics?.outsideLeakagePct)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Boundary spill: {asNumber(frameMetrics?.boundarySpillPct)?.toFixed(2) ?? "n/a"}%</p>
                                  {boundaryOverlayUrl ? (
                                    <button
                                      type="button"
                                      className="mt-2 underline"
                                      onClick={() => setImagePreviewModal({ url: boundaryOverlayUrl, label: "Frame QC boundary overlay" })}
                                    >
                                      Open boundary overlay
                                    </button>
                                  ) : null}
                                </>
                              ) : (
                                <p>
                                  {qcStatus === "running"
                                    ? "QC is running..."
                                    : qcStatus === "failed"
                                      ? `QC failed: ${row.qcGeneration?.generation.qc?.error ?? "unknown"}`
                                      : "No frame QC evidence for this edit frame yet."}
                                </p>
                              )}
                            </div>
                          </div>
                          {hasFrameQc ? (
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Frame diff heatmap</p>
                                {frameHeatmapUrl ? (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    onClick={() => setImagePreviewModal({ url: frameHeatmapUrl, label: "Frame QC heatmap" })}
                                  >
                                    <img src={frameHeatmapUrl} alt="Frame diff heatmap" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No heatmap</p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Frame diff overlay</p>
                                {frameOverlayUrl ? (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    onClick={() => setImagePreviewModal({ url: frameOverlayUrl, label: "Frame QC overlay" })}
                                  >
                                    <img src={frameOverlayUrl} alt="Frame diff overlay" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
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
                                    onClick={() =>
                                      setImagePreviewModal({
                                        url: (boundaryOverlayUrl ?? frameBinaryUrl) as string,
                                        label: "Frame QC boundary/binary map",
                                      })
                                    }
                                  >
                                    <img
                                      src={(boundaryOverlayUrl ?? frameBinaryUrl) as string}
                                      alt="Frame QC boundary or binary map"
                                      className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                    />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No boundary or binary map</p>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}

            {reportView === "qc_video" ? (
              <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">QC Video Report</h3>
                {(["start_video", "start_end", "start_only"] as VideoGenerationGroup[]).map((group) => {
                  const rows = qcVideoRowsByGroup[group];
                  return (
                    <div key={group} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                      <h4 className="text-base font-semibold">{qcVideoGroupLabels[group]}</h4>
                      {rows.length === 0 ? (
                        <p className="text-sm text-ink/60">No generations in this category.</p>
                      ) : (
                        <div className="space-y-3">
                          {rows.map((row: ReportGenerationRow) => {
                            const videoAggregates = row.generation.qc?.video?.aggregates as Record<string, unknown> | undefined;
                            const videoArtifacts = row.generation.qc?.video?.artifacts;
                            const qcStatus = row.generation.qc?.status ?? "not_run";
                            const firstFrameMetrics = (videoAggregates?.firstFrame as Record<string, unknown> | undefined) ?? undefined;
                            const lastFrameMetrics = (videoAggregates?.lastFrame as Record<string, unknown> | undefined) ?? undefined;
                            const timelineGraphUrl = videoArtifacts?.timelineGraphUrl as string | undefined;
                            const timelineCsvUrl = videoArtifacts?.timelineCsvUrl as string | undefined;
                            const reportJsonUrl = videoArtifacts?.reportJsonUrl as string | undefined;
                            const diffVideoUrl = videoArtifacts?.diffVideoUrl as string | undefined;
                            const selectedFrames = ((row.generation.qc?.video?.selectedFrames ?? []) as VideoSelectedFrameArtifact[]).slice(0, 6);
                            const fps = Math.max(1, fpsValue(reportTask));
                            const startCaptureMismatch =
                              row.startFrame?.captureKey &&
                              row.generation.sourceFirstFrameCaptureKey &&
                              row.startFrame.captureKey !== row.generation.sourceFirstFrameCaptureKey;
                            const endCaptureMismatch =
                              row.endFrame?.captureKey &&
                              row.generation.sourceLastFrameCaptureKey &&
                              row.endFrame.captureKey !== row.generation.sourceLastFrameCaptureKey;
                            return (
                              <article key={row.generation.genId} className="space-y-2 rounded border border-ink/10 bg-bg/30 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-sm font-semibold">
                                    {row.segment ? `${row.segment.segmentId} · ${describeSegment(row.segment)}` : row.generation.segmentId}
                                  </p>
                                  <label className="flex items-center gap-2 text-xs text-ink/70">
                                    <input
                                      type="checkbox"
                                      checked={selectedRefKeys.has(reportOutputRefKey({ assetType: "segment_generation", genId: row.generation.genId }))}
                                      onChange={() =>
                                        toggleCustomReportOutput(reportTask.taskId, {
                                          assetType: "segment_generation",
                                          genId: row.generation.genId,
                                        })
                                      }
                                    />
                                    QC
                                  </label>
                                </div>
                                <p className="text-xs text-ink/60">
                                  Relationships: generation {truncateIdentifier(row.generation.genId, 12)} · start frame{" "}
                                  {row.startFrame ? `${row.startFrame.frameId}` : "n/a"} · end frame {row.endFrame ? `${row.endFrame.frameId}` : "n/a"}
                                </p>
                                {startCaptureMismatch || endCaptureMismatch ? (
                                  <p className="text-xs text-red-600">
                                    Relationship warning: source capture keys differ from current segment boundary frames.
                                  </p>
                                ) : null}
                                <div className="grid gap-3 lg:grid-cols-2">
                                  <div>
                                    <p className="text-xs font-medium text-ink/70">Original segment video</p>
                                    {row.segment && reportPlaybackUrl ? (
                                      <video
                                        src={`${reportPlaybackUrl}#t=${(row.segment.startFrame / fps).toFixed(3)},${(row.segment.endFrameExclusive / fps).toFixed(3)}`}
                                        controls
                                        preload="none"
                                        className="w-full rounded border border-ink/10 bg-bg object-contain"
                                      />
                                    ) : (
                                      <p className="text-xs text-ink/50">Unavailable</p>
                                    )}
                                  </div>
                                  <div>
                                    <p className="text-xs font-medium text-ink/70">Generated segment video</p>
                                    {row.generatedVideoUrl ? (
                                      <video
                                        src={row.generatedVideoUrl}
                                        controls
                                        preload="none"
                                        className="w-full rounded border border-ink/10 bg-bg object-contain"
                                      />
                                    ) : (
                                      <p className="text-xs text-ink/50">Unavailable</p>
                                    )}
                                  </div>
                                </div>
                                <div className="grid gap-2 md:grid-cols-2">
                                  <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                                    <p className="font-semibold text-ink/90">Video QC analysis</p>
                                    {qcStatus === "complete" ? (
                                      <>
                                        <p>Changed mean: {asNumber(videoAggregates?.changedPctTotalMean)?.toFixed(2) ?? "n/a"}%</p>
                                        <p>Outside mean: {asNumber(videoAggregates?.outsideLeakagePctMean)?.toFixed(2) ?? "n/a"}%</p>
                                        <p>SSIM: {asNumber(videoAggregates?.ssimMean)?.toFixed(4) ?? "n/a"}</p>
                                        <p>PSNR: {asNumber(videoAggregates?.psnrMean)?.toFixed(2) ?? "n/a"} dB</p>
                                      </>
                                    ) : (
                                      <p>
                                        {qcStatus === "running"
                                          ? "QC analysis running..."
                                          : qcStatus === "failed"
                                            ? `QC failed: ${row.generation.qc?.error ?? "unknown"}`
                                            : "No QC data yet."}
                                      </p>
                                    )}
                                  </div>
                                  <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                                    <p className="font-semibold text-ink/90">First/Last frame comparison</p>
                                    <p>
                                      First:{" "}
                                      {firstFrameMetrics
                                        ? `${asNumber(firstFrameMetrics.changedPctTotal)?.toFixed(2) ?? "n/a"}% changed`
                                        : "n/a"}
                                    </p>
                                    <p>
                                      Last:{" "}
                                      {lastFrameMetrics
                                        ? `${asNumber(lastFrameMetrics.changedPctTotal)?.toFixed(2) ?? "n/a"}% changed`
                                        : "n/a"}
                                    </p>
                                    {timelineGraphUrl ? (
                                      <button
                                        type="button"
                                        className="mt-2 underline"
                                        onClick={() =>
                                          setReportGraphModal({ url: timelineGraphUrl, label: `QC timeline: ${row.generation.genId}` })
                                        }
                                      >
                                        Open timeline graph
                                      </button>
                                    ) : null}
                                    {timelineCsvUrl ? (
                                      <a href={timelineCsvUrl} target="_blank" rel="noreferrer" className="mt-1 block underline">
                                        Download timeline CSV
                                      </a>
                                    ) : null}
                                    {reportJsonUrl ? (
                                      <a href={reportJsonUrl} target="_blank" rel="noreferrer" className="mt-1 block underline">
                                        Open full QC report JSON
                                      </a>
                                    ) : null}
                                    {diffVideoUrl ? (
                                      <button
                                        type="button"
                                        className="mt-1 block underline"
                                        onClick={() => setVideoPreviewModal({ url: diffVideoUrl, label: `Diff video ${row.generation.genId}` })}
                                      >
                                        Open diff video
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                  <div className="space-y-1">
                                    <p className="text-xs font-medium text-ink/70">Timeline graph</p>
                                    {timelineGraphUrl ? (
                                      <button
                                        type="button"
                                        className="block w-full"
                                        onClick={() => setReportGraphModal({ url: timelineGraphUrl, label: `QC timeline: ${row.generation.genId}` })}
                                      >
                                        <img
                                          src={timelineGraphUrl}
                                          alt="QC timeline graph"
                                          className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                        />
                                      </button>
                                    ) : (
                                      <p className="text-xs text-ink/50">No timeline graph</p>
                                    )}
                                  </div>
                                  <div className="space-y-1">
                                    <p className="text-xs font-medium text-ink/70">Diff map video</p>
                                    {diffVideoUrl ? (
                                      <video
                                        src={diffVideoUrl}
                                        controls
                                        preload="none"
                                        className="w-full rounded border border-ink/10 bg-bg object-contain"
                                      />
                                    ) : (
                                      <p className="text-xs text-ink/50">No diff map video</p>
                                    )}
                                  </div>
                                </div>
                                {selectedFrames.length ? (
                                  <div className="space-y-2">
                                    <p className="text-xs font-medium text-ink/70">Selected frame diff artifacts</p>
                                    <div className="grid gap-3 md:grid-cols-3">
                                      {selectedFrames.map((frame: VideoSelectedFrameArtifact) => {
                                        const frameOverlayUrl =
                                          (frame.overlayUrl as string | undefined) ??
                                          ((frame as Record<string, unknown>).boundaryOverlayUrl as string | undefined);
                                        return (
                                          <div key={`${row.generation.genId}:selected:${frame.index}`} className="space-y-1 rounded border border-ink/10 bg-white p-2">
                                            <p className="text-[11px] text-ink/60">
                                              f{frame.index} · t={frame.timeSec}s
                                            </p>
                                            {frameOverlayUrl ? (
                                              <button
                                                type="button"
                                                className="block w-full"
                                                onClick={() => setImagePreviewModal({ url: frameOverlayUrl, label: `Overlay frame ${frame.index}` })}
                                              >
                                                <img
                                                  src={frameOverlayUrl}
                                                  alt={`Frame ${frame.index} diff overlay`}
                                                  className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                                />
                                              </button>
                                            ) : (
                                              <p className="text-xs text-ink/50">Overlay unavailable</p>
                                            )}
                                            <div className="flex flex-wrap gap-2 text-[11px] text-ink/70">
                                              {frame.heatmapUrl ? (
                                                <a href={frame.heatmapUrl} target="_blank" rel="noreferrer" className="underline">
                                                  Heatmap
                                                </a>
                                              ) : null}
                                              {frameOverlayUrl ? (
                                                <a href={frameOverlayUrl} target="_blank" rel="noreferrer" className="underline">
                                                  Overlay
                                                </a>
                                              ) : null}
                                              {frame.binaryChangeUrl ? (
                                                <a href={frame.binaryChangeUrl} target="_blank" rel="noreferrer" className="underline">
                                                  Binary
                                                </a>
                                              ) : null}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ) : null}

            <div id="custom-report-builder">{renderCustomReportBox(reportTask.taskId, reportCustomReports)}</div>
          </>
        ) : null}
      </div>
      {reportGraphModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setReportGraphModal(null)}>
          <div className="relative w-[92vw] max-w-6xl rounded-lg border border-ink/20 bg-white p-3" onClick={(event) => event.stopPropagation()}>
            <button className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={() => setReportGraphModal(null)}>
              x
            </button>
            <img src={reportGraphModal.url} alt={reportGraphModal.label} className="w-full rounded object-contain" />
          </div>
        </div>
      ) : null}
    </main>
  );
}

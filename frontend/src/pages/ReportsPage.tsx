import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import { StatusNotice } from "../components/layout/UiFeedback";
import {
  FRAME_TEST_OPTIONS,
  HeatmapLegend,
  InfoButton,
  InfoModal,
  QC_INFO_TEXT,
  ReportCreateModal,
  VIDEO_COMPARE_TEST_OPTIONS,
  VIDEO_TEST_OPTIONS,
  type InfoModalState,
} from "../components/reports/QcReportShared";
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
type CustomReportType = "qc_frame" | "qc_video" | "video_compare";

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
  formatAssetDate: (iso: string) => string;
  truncateIdentifier: (value: string, maxLength?: number) => string;
  reportTaskQuery: UseQueryResult<TaskDetail, Error>;
  createCustomReportMutation: UseMutationResult<
    { reportId: string },
    Error,
    {
      taskId: string;
      reportType: CustomReportType;
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
  openSource: (taskId: string) => void;
  openOutputs: (taskId: string) => void;
  currentWorkingRangeLabel: string;
  currentWorkingRangeSegment: SegmentRecord | null;
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
  assetType: "frame_variant" | "external_frame_pair";
  frameId?: string;
  variantId?: string;
  pairId?: string;
  sourceMediaType?: "image" | "video" | string;
  role: "start" | "end" | "unlinked" | "external";
  frameIndex?: number;
  timecode?: string;
  label?: string;
  sampleIndex?: number;
  sampleTimeSec?: number;
  createdAt?: string;
  model?: string;
  variantType?: string;
  processingDurationSec?: number;
  prompt?: string;
  originalFilename?: string;
  editedFilename?: string;
  originalFrameUrl?: string;
  maskUrl?: string;
  editedFrameUrl?: string;
  comparisonPreprocess?: {
    sizeAdjusted?: boolean;
    mode?: string;
    originalSize?: { width: number; height: number };
    editedSize?: { width: number; height: number };
  } | null;
  standard?: {
    metrics?: Record<string, unknown>;
    artifacts?: Record<string, unknown>;
  } | null;
  advanced?: {
    status?: string;
    classification?: Record<string, unknown>;
    selectedTests?: string[];
    metrics?: Record<string, unknown>;
    topRegions?: Array<Record<string, unknown>>;
    tooltips?: Record<string, string>;
    artifacts?: Record<string, unknown>;
  } | null;
};

type VideoReportRow = {
  assetType: "segment_generation" | "export";
  genId?: string;
  exportId?: string;
  segmentId?: string;
  createdAt?: string;
  model?: string;
  mode?: string;
  processingDurationSec?: number;
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

type VideoCompareItem = {
  genId?: string;
  model?: string;
  mode?: string;
  generatedFrameIndex?: number;
  expectedGeneratedFrameIndex?: number;
  sourceFrameOffset?: number;
  frameUrl?: string;
  diffUrl?: string;
  zoomFrameUrl?: string;
  zoomDiffUrl?: string;
};

type VideoCompareSample = {
  frameIndex?: number;
  comparisonFrameIndex?: number;
  sourceFrameIndex?: number;
  timeSec?: number;
  alignedTimeSec?: number;
  originalUrl?: string;
  originalZoomUrl?: string;
  zoomRegion?: { x: number; y: number; width: number; height: number; scale: number };
  items?: VideoCompareItem[];
};

type VideoCompareReport = {
  segmentId?: string;
  segmentStartFrame?: number;
  segmentEndFrameExclusive?: number;
  sourceFps?: number;
  alignment?: {
    method?: string;
    scanFrameCount?: number;
    anchorFrames?: number[];
    alignedStartFrame?: number;
    note?: string;
  };
  generations?: Array<{
    genId?: string;
    model?: string;
    modelSubsetting?: string;
    prompt?: string;
    inputResolution?: { width?: number; height?: number };
    outputResolution?: { width?: number; height?: number };
    storedOutputResolution?: { width?: number; height?: number };
    aspectRatio?: string;
    frameCount?: number;
    fps?: number;
    durationSec?: number;
    processingDurationSec?: number;
    sourceFrameOffset?: number;
    alignmentConfidence?: number;
    alignment?: {
      sourceFrameOffset?: number;
      confidence?: number;
      score?: number;
      runnerUpScore?: number;
      scanFrameCount?: number;
      method?: string;
      anchorFrames?: number[];
      anchorCount?: number;
      sourceFrameSteps?: number[];
    };
  }>;
  samples?: VideoCompareSample[];
};

type ReportScope = "current_range" | "all_ranges";

function reportTypeLabel(reportType: CustomReportType): string {
  if (reportType === "qc_frame") return "Frame QC";
  if (reportType === "video_compare") return "Video Compare";
  return "Video QC";
}

function safeTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatProcessingDuration(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const whole = Math.round(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function formatResolution(resolution: { width?: number; height?: number } | undefined): string {
  return resolution?.width && resolution?.height ? `${resolution.width}x${resolution.height}` : "n/a";
}

function sameResolution(
  first: { width?: number; height?: number } | undefined,
  second: { width?: number; height?: number } | undefined,
): boolean {
  return Boolean(first?.width && first?.height && second?.width && second?.height && first.width === second.width && first.height === second.height);
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

function selectionMarker(checked: boolean): string {
  return checked ? "✓" : "";
}

function PreviewableImage(props: {
  url: string | null | undefined;
  alt: string;
  label: string;
  className: string;
  onPreview: (value: { url: string; label: string }) => void;
}) {
  if (!props.url) return null;
  return (
    <button type="button" className="block w-full text-left" onClick={() => props.onPreview({ url: props.url as string, label: props.label })}>
      <img src={props.url} alt={props.alt} className={props.className} loading="lazy" decoding="async" />
    </button>
  );
}

function summarizeReport(report: CustomReportRecord, task: TaskDetail | undefined): string {
  const asset_refs = report.assetRefs ?? [];
  if (!task || !asset_refs.length) {
    return `${asset_refs.length} selected asset${asset_refs.length === 1 ? "" : "s"}`;
  }
  if (report.reportType === "qc_frame") {
    const external_pairs = asset_refs.filter(
      (ref): ref is Extract<CustomReportOutputRef, { assetType: "external_frame_pair" }> => ref.assetType === "external_frame_pair",
    );
    if (external_pairs.length) {
      const pair_map = new Map((task.externalQcPairs ?? []).map((pair) => [pair.pairId, pair]));
      const preview = external_pairs
        .slice(0, 3)
        .map((ref) => pair_map.get(ref.pairId)?.editedFilename || pair_map.get(ref.pairId)?.originalFilename || ref.pairId)
        .join(", ");
      return `External pairs ${preview}${external_pairs.length > 3 ? ` +${external_pairs.length - 3} more` : ""}`;
    }
    const frame_numbers = asset_refs
      .filter((ref): ref is Extract<CustomReportOutputRef, { assetType: "frame_variant" }> => ref.assetType === "frame_variant")
      .map((ref) => task.frames[ref.frameId]?.frameIndex)
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);
    if (!frame_numbers.length) return `${asset_refs.length} selected frame${asset_refs.length === 1 ? "" : "s"}`;
    const preview = frame_numbers.slice(0, 4).join(", ");
    return `Frames ${preview}${frame_numbers.length > 4 ? ` +${frame_numbers.length - 4} more` : ""}`;
  }
  const generation_map = task.segmentGenerations ?? {};
  const segment_map = new Map((task.segments ?? []).map((segment) => [segment.segmentId, segment]));
  const segment_labels = asset_refs
    .filter((ref): ref is Extract<CustomReportOutputRef, { assetType: "segment_generation" }> => ref.assetType === "segment_generation")
    .map((ref) => {
      const generation = generation_map[ref.genId];
      const segment = generation ? segment_map.get(generation.segmentId) : null;
      return segment ? `start ${segment.startFrame}` : null;
    })
    .filter((value): value is string => Boolean(value));
  if (!segment_labels.length) return `${asset_refs.length} selected video${asset_refs.length === 1 ? "" : "s"}`;
  const preview = segment_labels.slice(0, 4).join(", ");
  return `Segments ${preview}${segment_labels.length > 4 ? ` +${segment_labels.length - 4} more` : ""}`;
}

function reportMatchesScope(report: CustomReportRecord, task: TaskDetail | undefined, segment: SegmentRecord | null): boolean {
  if (!task || !segment) return true;
  const segmentGenerations = task.segmentGenerations ?? {};
  const frames = task.frames ?? {};
  return (report.assetRefs ?? []).some((ref) => {
    if (ref.assetType === "segment_generation") {
      return segmentGenerations[ref.genId]?.segmentId === segment.segmentId;
    }
    if (ref.assetType === "frame_variant") {
      const frame = frames[ref.frameId];
      if (!frame) return false;
      return frame.frameIndex >= segment.startFrame && frame.frameIndex < segment.endFrameExclusive;
    }
    return false;
  });
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
    openSource,
    openOutputs,
    currentWorkingRangeLabel,
    currentWorkingRangeSegment,
  } = ctx;

  const [createModalMode, setCreateModalMode] = useState<CustomReportType | null>(null);
  const [reportName, setReportName] = useState("");
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [infoModal, setInfoModal] = useState<InfoModalState>(null);
  const [reportScope, setReportScope] = useState<ReportScope>(currentWorkingRangeSegment ? "current_range" : "all_ranges");

  useEffect(() => {
    setReportScope(currentWorkingRangeSegment ? "current_range" : "all_ranges");
  }, [currentWorkingRangeSegment?.segmentId]);

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

  const scopedFrameOutputRows = useMemo(() => {
    if (reportScope !== "current_range" || !currentWorkingRangeSegment) return frameOutputRows;
    return frameOutputRows.filter(
      (row) =>
        row.frame.frameIndex >= currentWorkingRangeSegment.startFrame &&
        row.frame.frameIndex < currentWorkingRangeSegment.endFrameExclusive,
    );
  }, [currentWorkingRangeSegment, frameOutputRows, reportScope]);

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

  const scopedVideoOutputRows = useMemo(() => {
    if (reportScope !== "current_range" || !currentWorkingRangeSegment) return videoOutputRows;
    return videoOutputRows.filter((row) => row.segment?.segmentId === currentWorkingRangeSegment.segmentId);
  }, [currentWorkingRangeSegment, reportScope, videoOutputRows]);

  const reports = useMemo(
    () => [...(reportTask?.customReports ?? [])].sort((a, b) => safeTimestamp(b.updatedAt) - safeTimestamp(a.updatedAt)),
    [reportTask?.customReports],
  );
  const scopedReports = useMemo(() => {
    if (reportScope !== "current_range" || !currentWorkingRangeSegment) return reports;
    return reports.filter((report) => reportMatchesScope(report, reportTask, currentWorkingRangeSegment));
  }, [currentWorkingRangeSegment, reportScope, reportTask, reports]);
  const activeReportMeta = useMemo(
    () => scopedReports.find((report) => report.reportId === activeCustomReportId) ?? null,
    [activeCustomReportId, scopedReports],
  );
  const selectedRefsForTask = reportTaskId ? selectedOutputRefsByTask[reportTaskId] ?? [] : [];
  const selectedFrameRefs = selectedRefsForTask.filter(
    (ref): ref is Extract<CustomReportOutputRef, { assetType: "frame_variant" }> => {
      if (ref.assetType !== "frame_variant") return false;
      if (reportScope !== "current_range" || !currentWorkingRangeSegment || !reportTask) return true;
      const frame = reportTask.frames?.[ref.frameId];
      if (!frame) return false;
      return frame.frameIndex >= currentWorkingRangeSegment.startFrame && frame.frameIndex < currentWorkingRangeSegment.endFrameExclusive;
    },
  );
  const selectedVideoRefs = selectedRefsForTask.filter(
    (ref): ref is Extract<CustomReportOutputRef, { assetType: "segment_generation" }> => {
      if (ref.assetType !== "segment_generation") return false;
      if (reportScope !== "current_range" || !currentWorkingRangeSegment || !reportTask) return true;
      const generation = reportTask.segmentGenerations?.[ref.genId];
      return generation?.segmentId === currentWorkingRangeSegment.segmentId;
    },
  );
  const selectedVideoComparisonEligible = useMemo(() => {
    if (!reportTask || selectedVideoRefs.length < 2) return false;
    const keys = new Set<string>();
    for (const ref of selectedVideoRefs) {
      const generation = reportTask.segmentGenerations?.[ref.genId];
      const segment = generation ? reportTask.segments.find((item) => item.segmentId === generation.segmentId) : null;
      if (!generation || generation.status !== "complete" || !generation.outputKey || !segment) return false;
      keys.add(`${segment.segmentId}:${segment.startFrame}`);
    }
    return keys.size === 1;
  }, [reportTask, selectedVideoRefs]);

  useEffect(() => {
    if (!activeCustomReportId || reportScope !== "current_range") return;
    if (scopedReports.some((report) => report.reportId === activeCustomReportId)) return;
    if (reports.some((report) => report.reportId === activeCustomReportId)) {
      setReportScope("all_ranges");
    }
  }, [activeCustomReportId, reportScope, reports, scopedReports]);

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
    if (!scopedReports.some((report) => report.reportId === activeCustomReportId)) {
      setActiveCustomReportId(null);
    }
  }, [activeCustomReportId, scopedReports, setActiveCustomReportId]);

  useEffect(() => {
    if (!activeReportMeta) return;
    if (activeReportMeta.status !== "queued" && activeReportMeta.status !== "running") return;
    const timer = window.setInterval(() => {
      void reportTaskQuery.refetch();
      void activeReportQuery.refetch();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeReportMeta, activeReportQuery, reportTaskQuery]);

  function openCreateModal(mode: CustomReportType) {
    setCreateModalMode(mode);
    setReportName("");
    setSelectedTests(
      mode === "qc_frame"
        ? ["frame_diff", "frame_composite"]
        : mode === "video_compare"
          ? ["video_model_compare"]
          : ["video_diff", "video_frame_evidence"],
    );
  }

  function closeCreateModal() {
    setCreateModalMode(null);
    setReportName("");
    setSelectedTests([]);
  }

  function openInfo(title: string, lines: string[]) {
    setInfoModal({ title, lines });
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
  const runningReport =
    scopedReports.find((report) => report.status === "running") ??
    scopedReports.find((report) => report.status === "queued") ??
    null;
  const runningReportJob =
    latestQcJob && (latestQcJob.status === "queued" || latestQcJob.status === "running") ? latestQcJob : null;

  const activeResult = activeReportQuery.data?.result ?? null;
  const frameReportRows = ((activeResult?.rows as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (row): row is FrameReportRow => row.assetType === "frame_variant" || row.assetType === "external_frame_pair",
  );
  const videoReportRows = ((activeResult?.rows as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (row): row is VideoReportRow => row.assetType === "segment_generation" || row.assetType === "export",
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-ink/10 bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-ink">
            {reportTask?.name ?? reportTaskId ?? "Source video"} · Working range: {currentWorkingRangeLabel}
          </p>
          {reportTask ? <p className="text-xs text-ink/50">Updated {formatAssetDate(reportTask.updatedAt)}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
            onClick={() => {
              if (reportTaskId) openSource(reportTaskId);
            }}
          >
            Open Source
          </button>
          <button
            className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
            onClick={() => {
              if (reportTaskId) openOutputs(reportTaskId);
            }}
          >
            Open Outputs
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-ink/10 bg-card p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-ink/10 bg-bg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Frame Edits</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{scopedFrameOutputRows.length}</p>
            <p className="text-xs text-ink/60">
              {reportScope === "current_range" ? "Edited and refined frames in the current working range." : "Edited and refined frames available for frame QC."}
            </p>
          </div>
          <div className="rounded-lg border border-ink/10 bg-bg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Video Outputs</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{scopedVideoOutputRows.length}</p>
            <p className="text-xs text-ink/60">
              {reportScope === "current_range" ? "Completed generated outputs for the current working range." : "Completed generated outputs attached to this source video."}
            </p>
          </div>
          <div className="rounded-lg border border-ink/10 bg-bg p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Saved Reports</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{scopedReports.length}</p>
            <p className="text-xs text-ink/60">
              {reportScope === "current_range" ? "Reports whose selected assets belong to this working range." : "QC reports built from selected edits and outputs."}
            </p>
          </div>
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
        {currentWorkingRangeSegment ? (
          <>
            <span className="mx-1 hidden h-5 w-px bg-ink/10 md:block" aria-hidden="true" />
            <button
              type="button"
              className={`rounded px-3 py-2 text-sm ${reportScope === "current_range" ? "border border-teal-500 bg-teal-50 text-ink" : "bg-ink/10"}`}
              onClick={() => setReportScope("current_range")}
            >
              Current Range
            </button>
            <button
              type="button"
              className={`rounded px-3 py-2 text-sm ${reportScope === "all_ranges" ? "border border-teal-500 bg-teal-50 text-ink" : "bg-ink/10"}`}
              onClick={() => setReportScope("all_ranges")}
            >
              All Ranges
            </button>
          </>
        ) : null}
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
          {reportView === "videos" ? (
            <button
              type="button"
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!reportTaskId || !selectedVideoComparisonEligible || createCustomReportMutation.isPending}
              onClick={() => openCreateModal("video_compare")}
              title={
                selectedVideoRefs.length < 2
                  ? "Select at least two generated videos"
                  : selectedVideoComparisonEligible
                    ? "Compare selected videos from this segment"
                    : "Comparison reports require completed videos from the same segment/start frame"
              }
            >
              Create Video Comparison Report
            </button>
          ) : null}
          <button type="button" className="rounded border border-ink/20 bg-white px-3 py-2 text-sm" onClick={() => void reportTaskQuery.refetch()}>
            Refresh
          </button>
        </div>

        {runningReport || runningReportJob ? (
          <StatusNotice variant="loading" title={`Report is ${runningReport?.status ?? runningReportJob?.status ?? "running"}`} className="rounded-2xl border-2 p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                {runningReport?.name ?? "A QC report"} is being built. This page refreshes automatically while the worker generates the report assets.
              </p>
              {runningReportJob ? (
                <div className="min-w-48 rounded-lg bg-white/70 px-3 py-2 text-sm text-ink">
                  <p className="font-medium">Job {truncateIdentifier(runningReportJob.jobId, 12)}</p>
                  <p>{runningReportJob.progress}% complete</p>
                </div>
              ) : null}
            </div>
          </StatusNotice>
        ) : latestQcJob ? (
          <p className="text-xs text-ink/70">
            Latest report job {truncateIdentifier(latestQcJob.jobId, 12)}: {latestQcJob.status} ({latestQcJob.progress}%)
          </p>
        ) : null}
        {reportTaskQuery.isPending ? (
          <StatusNotice variant="loading">
            <p>Loading reports...</p>
          </StatusNotice>
        ) : null}
        {reportTaskQuery.error ? (
          <StatusNotice variant="error">
            <p>{reportTaskQuery.error.message}</p>
          </StatusNotice>
        ) : null}
        {createCustomReportMutation.error ? (
          <StatusNotice variant="error">
            <p>{createCustomReportMutation.error.message}</p>
          </StatusNotice>
        ) : null}
        {deleteCustomReportMutation.error ? (
          <StatusNotice variant="error">
            <p>{deleteCustomReportMutation.error.message}</p>
          </StatusNotice>
        ) : null}

        {reportView === "frames" ? (
          <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">Frame Outputs</h3>
              <p className="text-xs text-ink/60">Selected for report: {selectedFrameRefs.length}</p>
            </div>
            {scopedFrameOutputRows.length === 0 ? (
              <p className="text-sm text-ink/60">No edited frames available.</p>
            ) : (
              <div className="space-y-3">
                {scopedFrameOutputRows.map((row) => {
                  const ref: CustomReportOutputRef = { assetType: "frame_variant", frameId: row.frame.frameId, variantId: row.variant.variantId };
                  const checked = selectedFrameRefs.some(
                    (selected_ref) => reportOutputRefKey(selected_ref) === reportOutputRefKey(ref),
                  );
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
                          <span
                            aria-hidden="true"
                            className={`flex h-4 w-4 items-center justify-center rounded border text-[11px] font-semibold ${
                              checked ? "border-teal-600 bg-teal-600 text-white" : "border-ink/30 bg-white text-transparent"
                            }`}
                          >
                            {selectionMarker(checked)}
                          </span>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={checked}
                            onChange={() => reportTaskId && toggleCustomReportOutput(reportTaskId, ref)}
                          />
                          Include in report
                        </label>
                      </div>
                      <div className="grid gap-3 md:grid-cols-3">
                        <div>
                          <p className="text-xs font-medium text-ink/70">Original frame</p>
                          <PreviewableImage
                            url={row.frame.imageUrl}
                            alt="Original frame"
                            label="Original frame"
                            onPreview={setImagePreviewModal}
                            className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                          />
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Mask edit</p>
                          {row.variant.patchMeta?.maskUrl ? (
                            <PreviewableImage
                              url={row.variant.patchMeta.maskUrl}
                              alt="Mask"
                              label="Mask"
                              onPreview={setImagePreviewModal}
                              className="aspect-video w-full rounded border border-ink/10 bg-black object-contain"
                            />
                          ) : (
                            <p className="text-xs text-ink/50">No mask</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Edited frame</p>
                          <PreviewableImage
                            url={row.variant.imageUrl}
                            alt="Edited frame"
                            label="Edited frame"
                            onPreview={setImagePreviewModal}
                            className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                          />
                        </div>
                      </div>
                      <div className="rounded border border-ink/10 bg-bg/20 p-2 text-xs text-ink/70">
                        <p>
                          Model: {row.variant.model} ({row.variant.type})
                          {formatProcessingDuration(row.variant.processingDurationSec)
                            ? ` · ${formatProcessingDuration(row.variant.processingDurationSec)}`
                            : ""}
                        </p>
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
            {scopedVideoOutputRows.length === 0 ? (
              <p className="text-sm text-ink/60">No generated videos available.</p>
            ) : (
              <div className="space-y-3">
                {scopedVideoOutputRows.map((row) => {
                  const ref: CustomReportOutputRef = { assetType: "segment_generation", genId: row.generation.genId };
                  const checked = selectedVideoRefs.some(
                    (selected_ref) => reportOutputRefKey(selected_ref) === reportOutputRefKey(ref),
                  );
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
                          <span
                            aria-hidden="true"
                            className={`flex h-4 w-4 items-center justify-center rounded border text-[11px] font-semibold ${
                              checked ? "border-teal-600 bg-teal-600 text-white" : "border-ink/30 bg-white text-transparent"
                            }`}
                          >
                            {selectionMarker(checked)}
                          </span>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={checked}
                            onChange={() => reportTaskId && toggleCustomReportOutput(reportTaskId, ref)}
                          />
                          Include in report
                        </label>
                      </div>
                      <div className="grid gap-3 md:grid-cols-5">
                        <div>
                          <p className="text-xs font-medium text-ink/70">Original start frame</p>
                          <PreviewableImage
                            url={row.startFrame?.imageUrl}
                            alt="Original start frame"
                            label="Original start frame"
                            onPreview={setImagePreviewModal}
                            className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                          />
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Mask edit</p>
                          {row.startVariant?.patchMeta?.maskUrl ? (
                            <PreviewableImage
                              url={row.startVariant.patchMeta.maskUrl}
                              alt="Mask"
                              label="Mask"
                              onPreview={setImagePreviewModal}
                              className="aspect-video w-full rounded border border-ink/10 bg-black object-contain"
                            />
                          ) : (
                            <p className="text-xs text-ink/50">No mask</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">Edited start frame</p>
                          <PreviewableImage
                            url={row.startVariant?.imageUrl}
                            alt="Edited start frame"
                            label="Edited start frame"
                            onPreview={setImagePreviewModal}
                            className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                          />
                        </div>
                        <div>
                          <p className="text-xs font-medium text-ink/70">End frame</p>
                          {row.endVariant?.imageUrl || row.endFrame?.imageUrl ? (
                            <PreviewableImage
                              url={(row.endVariant?.imageUrl ?? row.endFrame?.imageUrl) as string}
                              alt="End frame"
                              label="End frame"
                              onPreview={setImagePreviewModal}
                              className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                            />
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
                        <p>
                          Model: {row.generation.luma.model} - {row.generation.luma.mode}
                          {formatProcessingDuration(row.generation.processingDurationSec)
                            ? ` · ${formatProcessingDuration(row.generation.processingDurationSec)}`
                            : ""}
                        </p>
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
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">Saved Reports</h3>
              <p className="text-xs text-ink/60">Create new reports from the Assets step. Older reports remain available here.</p>
            </div>
            {!activeReportMeta ? (
              !scopedReports.length ? (
                <p className="text-sm text-ink/60">No reports created yet.</p>
              ) : (
                <div className="space-y-2">
                  {scopedReports.map((report) => (
                    <div key={report.reportId} className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-white p-3">
                      <button type="button" className="text-left" onClick={() => setActiveCustomReportId(report.reportId)}>
                        <p className="text-sm font-semibold">{report.name}</p>
                        <p className="text-xs text-ink/60">
                          {reportTypeLabel(report.reportType)} - {report.status}
                        </p>
                        <p className="text-xs text-ink/60">{summarizeReport(report, reportTask)}</p>
                        <p className="text-xs text-ink/50">Tests: {report.tests.join(", ")}</p>
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
              )
            ) : (
              <div className="space-y-3 rounded-xl border border-ink/10 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <button type="button" className="mb-2 text-xs text-ink/60 underline" onClick={() => setActiveCustomReportId(null)}>
                      Back to Reports
                    </button>
                    <h4 className="text-lg font-semibold">{activeReportMeta.name}</h4>
                    <p className="text-xs text-ink/60">
                      {reportTypeLabel(activeReportMeta.reportType)} - {activeReportMeta.status}
                    </p>
                  </div>
                  {activeReportMeta.error ? (
                    <div className="min-w-[220px]">
                      <StatusNotice variant="error">
                        <p>{activeReportMeta.error}</p>
                      </StatusNotice>
                    </div>
                  ) : null}
                </div>

                {activeReportQuery.isPending ? (
                  <StatusNotice variant="loading">
                    <p>Loading report data...</p>
                  </StatusNotice>
                ) : null}
                {activeReportQuery.error ? (
                  <StatusNotice variant="error">
                    <p>{activeReportQuery.error.message}</p>
                  </StatusNotice>
                ) : null}

                {activeResult && activeReportMeta.reportType === "qc_frame" ? (
                  <div className="space-y-3">
                    {Array.isArray((activeResult as { videoComparisons?: Array<Record<string, unknown>> }).videoComparisons) &&
                    (activeResult as { videoComparisons?: Array<Record<string, unknown>> }).videoComparisons!.length ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        {(activeResult as { videoComparisons?: Array<Record<string, unknown>> }).videoComparisons!.map((item, index) => {
                          const diffVideoUrl = typeof item.diffVideoUrl === "string" ? item.diffVideoUrl : undefined;
                          const diffVideoPosterUrl = typeof item.diffVideoPosterUrl === "string" ? item.diffVideoPosterUrl : undefined;
                          const label = typeof item.label === "string" ? item.label : `Video comparison ${index + 1}`;
                          return (
                            <div key={`${label}:${index}`} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold">{label}</p>
                                <p className="text-xs text-ink/60">
                                  {typeof item.durationSec === "number" ? `${item.durationSec.toFixed(1)}s` : null}
                                  {typeof item.sampledFrameCount === "number" ? ` · ${item.sampledFrameCount} sampled frames` : null}
                                </p>
                              </div>
                              {diffVideoUrl ? (
                                <button type="button" className="block w-full" onClick={() => setVideoPreviewModal({ url: diffVideoUrl, label })}>
                                  {diffVideoPosterUrl ? (
                                    <img src={diffVideoPosterUrl} alt={label} className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                  ) : (
                                    <div className="flex aspect-video items-center justify-center rounded border border-ink/10 bg-bg/30 text-sm text-ink/55">Open diff video</div>
                                  )}
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {frameReportRows.map((row) => {
                      const frameMetrics = row.standard?.metrics;
                      const frameArtifacts = row.standard?.artifacts;
                      const advanced = row.advanced;
                      const advancedClassification = (advanced?.classification ?? {}) as Record<string, unknown>;
                      const advancedArtifacts = advanced?.artifacts;
                      const advancedMetrics = advanced?.metrics;
                      const advancedReasons = Array.isArray(advancedClassification.reasons)
                        ? advancedClassification.reasons.filter((reason): reason is string => typeof reason === "string")
                        : [];
                      const advancedThresholds = (advancedClassification.thresholds ?? {}) as Record<string, unknown>;
                      const advancedObserved = (advancedClassification.observed ?? {}) as Record<string, unknown>;
                      const dominantDriver = typeof advancedClassification.dominantDriver === "string" ? advancedClassification.dominantDriver : null;
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
                          imageUrl: (advancedArtifacts?.compositeOverlayUrl as string | undefined) ?? (advancedArtifacts?.compositeMapUrl as string | undefined),
                          main: asNumber(advancedMetrics?.compositeImpactGlobal),
                          mask: asNumber(advancedMetrics?.compositeImpactMask),
                          ring: asNumber(advancedMetrics?.compositeImpactOuterRing),
                        },
                        {
                          key: "lpips",
                          title: "Perceptual difference map",
                          imageUrl: (advancedArtifacts?.lpipsOverlayUrl as string | undefined) ?? (advancedArtifacts?.lpipsMapUrl as string | undefined),
                          main: asNumber(advancedMetrics?.lpips_global_mean),
                          mask: asNumber(advancedMetrics?.lpips_mask_mean),
                          ring: asNumber(advancedMetrics?.lpips_outer_ring_mean),
                        },
                        {
                          key: "boundary",
                          title: "Boundary spill analysis",
                          imageUrl: (advancedArtifacts?.boundarySpillMapUrl as string | undefined) ?? (advancedArtifacts?.boundaryMapUrl as string | undefined),
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
                          title: "Naturalness proxy",
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
                        <article
                          key={
                            row.assetType === "external_frame_pair"
                              ? `external:${row.pairId}:${String(row.sampleIndex ?? row.sampleTimeSec ?? "base")}`
                              : `${row.frameId}:${row.variantId}`
                          }
                          className="space-y-2 rounded-lg border border-ink/10 bg-bg/20 p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold">
                              {row.assetType === "external_frame_pair"
                                ? row.label || "External frame comparison"
                                : `${row.role === "start" ? "Start" : row.role === "end" ? "End" : "Unlinked"} frame edit - frame ${row.frameIndex}`}
                            </p>
                            <p className="text-xs text-ink/60">{formatCompactTimestamp(row.createdAt)}</p>
                          </div>
                          <div className="grid gap-3 md:grid-cols-3">
                            <div>
                              <p className="text-xs font-medium text-ink/70">Original frame</p>
                              <PreviewableImage
                                url={row.originalFrameUrl}
                                alt="Original frame"
                                label="Original frame"
                                onPreview={setImagePreviewModal}
                                className="aspect-video w-full rounded border border-ink/10 bg-white object-contain"
                              />
                            </div>
                            {row.assetType === "external_frame_pair" ? null : (
                              <div>
                                <p className="text-xs font-medium text-ink/70">Mask edit</p>
                                {row.maskUrl ? (
                                  <PreviewableImage
                                    url={row.maskUrl}
                                    alt="Mask"
                                    label="Mask"
                                    onPreview={setImagePreviewModal}
                                    className="aspect-video w-full rounded border border-ink/10 bg-black object-contain"
                                  />
                                ) : (
                                  <p className="text-xs text-ink/50">No user mask was used. QC will infer a provisional mask from the frame difference.</p>
                                )}
                              </div>
                            )}
                            <div>
                              <p className="text-xs font-medium text-ink/70">Edited frame</p>
                              <PreviewableImage
                                url={row.editedFrameUrl}
                                alt="Edited frame"
                                label="Edited frame"
                                onPreview={setImagePreviewModal}
                                className="aspect-video w-full rounded border border-ink/10 bg-white object-contain"
                              />
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-3">
                            <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70 md:col-span-2">
                              <p className="font-semibold text-ink/90">Edit metadata</p>
                              {row.assetType === "external_frame_pair" ? (
                                <>
                                  <p>Original file: {row.originalFilename ?? "original"}</p>
                                  <p>Edited file: {row.editedFilename ?? "edited"}</p>
                                </>
                              ) : (
                                <>
                                  <p>Model: {`${row.model ?? "unknown"} (${row.variantType ?? "unknown"})`}</p>
                                  {formatProcessingDuration(row.processingDurationSec) ? (
                                    <p>Processing: {formatProcessingDuration(row.processingDurationSec)}</p>
                                  ) : null}
                                  <p>Prompt: {row.prompt}</p>
                                </>
                              )}
                            </div>
                            <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                              <div className="mb-1 flex items-center gap-2">
                                <p className="font-semibold text-ink/90">Frame QC analysis</p>
                                <InfoButton
                                  label="Explain frame QC analysis"
                                  onClick={() => openInfo("Frame QC analysis", [...QC_INFO_TEXT.frameQcAnalysis])}
                                />
                              </div>
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
                          {row.comparisonPreprocess?.sizeAdjusted ? (
                            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                              Comparison caution: the edited frame was resized and padded to match the original before QC. Edge differences can be exaggerated when aspect ratios or dimensions differ.
                            </div>
                          ) : null}
                          {row.standard ? (
                            <div className="space-y-2">
                              <HeatmapLegend
                                label="Standard diff legend"
                                description="Standard diff views are thresholded pixel-change diagnostics."
                              />
                              <div className="grid gap-3 md:grid-cols-3">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs font-medium text-ink/70">Frame diff heatmap</p>
                                  <InfoButton
                                  label="Explain frame diff heatmap"
                                  onClick={() => openInfo("Frame diff heatmap", [...QC_INFO_TEXT.frameDiffHeatmap])}
                                  />
                                </div>
                                {frameHeatmapUrl ? (
                                  <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: frameHeatmapUrl, label: "Frame QC heatmap" })}>
                                    <img src={frameHeatmapUrl} alt="Frame diff heatmap" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No heatmap</p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs font-medium text-ink/70">Frame diff overlay</p>
                                  <InfoButton
                                  label="Explain frame diff overlay"
                                  onClick={() => openInfo("Frame diff overlay", [...QC_INFO_TEXT.frameDiffOverlay])}
                                  />
                                </div>
                                {frameOverlayUrl ? (
                                  <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: frameOverlayUrl, label: "Frame QC overlay" })}>
                                    <img src={frameOverlayUrl} alt="Frame diff overlay" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No overlay</p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-xs font-medium text-ink/70">Boundary/Binary map</p>
                                  <InfoButton
                                  label="Explain boundary and binary map"
                                  onClick={() => openInfo("Boundary/Binary map", [...QC_INFO_TEXT.boundaryBinaryMap])}
                                  />
                                </div>
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
                            </div>
                          ) : null}
                          {advanced ? (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-2">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-semibold text-ink/90">Advanced QC analysis</p>
                                  <InfoButton
                                  label="Explain advanced QC analysis"
                                    onClick={() => openInfo("Advanced QC analysis", [...QC_INFO_TEXT.advancedQcAnalysis])}
                                  />
                                </div>
                                <div className="flex items-center gap-2">
                                  <p
                                    className={`text-xs tracking-wide ${
                                    advanced.status === "pass"
                                      ? "text-emerald-700"
                                      : advanced.status === "warn"
                                        ? "text-amber-700"
                                        : advanced.status === "fail"
                                          ? "text-red-700"
                                          : "text-ink/60"
                                  }`}
                                  >
                                    QC classification: {advanced.status ?? "n/a"}
                                  </p>
                                  <p className="text-xs text-ink/65">
                                    Driver:{" "}
                                    {dominantDriver === "outer_ring"
                                      ? "Outer-ring spill"
                                      : dominantDriver === "boundary_spill"
                                        ? "Boundary spill"
                                        : "Balanced"}
                                  </p>
                                  <InfoButton
                                  label="Explain advanced QC classification"
                                    onClick={() =>
                                      openInfo("QC classification", [
                                        ...QC_INFO_TEXT.qcClassification,
                                        `Driver: ${
                                          dominantDriver === "outer_ring"
                                            ? "Outer-ring spill"
                                            : dominantDriver === "boundary_spill"
                                              ? "Boundary spill"
                                              : "Balanced"
                                        }.`,
                                        `Observed outer ring = ${asNumber(advancedObserved.outerRingMean)?.toFixed(4) ?? "n/a"} · fail at >${asNumber(advancedThresholds.outerRingFail)?.toFixed(4) ?? "n/a"} · warn at >${asNumber(advancedThresholds.outerRingWarn)?.toFixed(4) ?? "n/a"}`,
                                        `Observed boundary spill = ${asNumber(advancedObserved.boundarySpill)?.toFixed(4) ?? "n/a"} · fail at >${asNumber(advancedThresholds.boundaryFail)?.toFixed(4) ?? "n/a"} · warn at >${asNumber(advancedThresholds.boundaryWarn)?.toFixed(4) ?? "n/a"}`,
                                        advancedReasons.length ? advancedReasons.join("; ") : "No classification explanation available.",
                                      ])
                                    }
                                  />
                                </div>
                              </div>
                              <HeatmapLegend
                                label="Advanced anomaly legend"
                                description="Advanced views are normalized patchwise anomaly maps."
                              />
                              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {advancedCards.map((card) => (
                                  <div key={card.key} className="space-y-2 rounded border border-ink/10 bg-bg/20 p-2">
                                    <div className="flex items-center gap-2">
                                      <p className="text-xs font-semibold text-ink/90">{card.title}</p>
                                      <InfoButton
                                        label={`Explain ${card.title}`}
                                        onClick={() =>
                                          openInfo(
                                            card.title,
                                            card.key === "composite"
                                              ? [...QC_INFO_TEXT.compositeAnomalyMap]
                                              : card.key === "lpips"
                                                ? [...QC_INFO_TEXT.perceptualDifferenceMap]
                                                : card.key === "boundary"
                                                  ? [...QC_INFO_TEXT.boundarySpillAnalysis]
                                                  : card.key === "sharpness"
                                                    ? [...QC_INFO_TEXT.sharpnessConsistency]
                                                    : card.key === "naturalness"
                                                      ? [...QC_INFO_TEXT.naturalnessProxy]
                                                      : [...QC_INFO_TEXT.microtextureMap],
                                          )
                                        }
                                      />
                                    </div>
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
                      const rowLabel = row.assetType === "export" ? row.exportId ?? "merged export" : row.genId ?? "generation";
                      const videoAggregates = row.standard?.aggregates;
                      const videoArtifacts = row.standard?.artifacts;
                      const timelineGraphUrl = videoArtifacts?.timelineGraphUrl as string | undefined;
                      const timelineCsvUrl = videoArtifacts?.timelineCsvUrl as string | undefined;
                      const diffVideoUrl = videoArtifacts?.diffVideoUrl as string | undefined;
                      const diffVideoPosterUrl = videoArtifacts?.diffVideoPosterUrl as string | undefined;
                      const selectedFrames = (row.standard?.selectedFrames ?? []) as Array<Record<string, unknown>>;
                      return (
                        <article key={row.assetType === "export" ? `export:${row.exportId}` : `generation:${row.genId}`} className="space-y-3 rounded-lg border border-ink/10 bg-bg/20 p-3">
                          <div className="grid gap-3 overflow-x-auto xl:grid-cols-5">
                            <div>
                              <p className="text-xs font-medium text-ink/70">Original start frame</p>
                              <PreviewableImage
                                url={row.originalFrameUrl}
                                alt="Original start frame"
                                label="Original start frame"
                                onPreview={setImagePreviewModal}
                                className="aspect-video w-full rounded border border-ink/10 bg-white object-contain"
                              />
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Mask edit</p>
                              {row.maskUrl ? (
                                <PreviewableImage
                                  url={row.maskUrl}
                                  alt="Mask"
                                  label="Mask"
                                  onPreview={setImagePreviewModal}
                                  className="aspect-video w-full rounded border border-ink/10 bg-black object-contain"
                                />
                              ) : (
                                <p className="text-xs text-ink/50">No user mask was used. QC will infer a provisional mask from frame differences where needed.</p>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{row.prompt}</p>
                              {formatProcessingDuration(row.processingDurationSec) ? (
                                <p className="mt-1 text-xs text-ink/70">Processing: {formatProcessingDuration(row.processingDurationSec)}</p>
                              ) : null}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Edited start frame</p>
                              <PreviewableImage
                                url={row.editedStartFrameUrl}
                                alt="Edited start frame"
                                label="Edited start frame"
                                onPreview={setImagePreviewModal}
                                className="aspect-video w-full rounded border border-ink/10 bg-white object-contain"
                              />
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">End frame</p>
                              {row.endFrameUrl ? (
                                <PreviewableImage
                                  url={row.endFrameUrl}
                                  alt="End frame"
                                  label="End frame"
                                  onPreview={setImagePreviewModal}
                                  className="aspect-video w-full rounded border border-ink/10 bg-white object-contain"
                                />
                              ) : <p className="text-xs text-ink/50">No end frame</p>}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Generated video</p>
                              {row.generatedVideoUrl ? (
                                <button type="button" className="block w-full" onClick={() => setVideoPreviewModal({ url: row.generatedVideoUrl as string, label: rowLabel })}>
                                  <img src={row.editedStartFrameUrl ?? row.originalFrameUrl ?? ""} alt="Generated video" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                </button>
                              ) : null}
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-5">
                            <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                              <div className="mb-1 flex items-center gap-2">
                                <p className="font-semibold text-ink/90">Video QC analysis</p>
                                <InfoButton
                                  label="Explain video QC analysis"
                                  onClick={() => openInfo("Video QC analysis", [...QC_INFO_TEXT.videoQcAnalysis])}
                                />
                              </div>
                              {row.standard ? (
                                <>
                                  <p>Changed mean: {asNumber(videoAggregates?.changedPctTotalMean)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Outside leak mean: {asNumber(videoAggregates?.outsideLeakagePctMean)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>SSIM mean: {asNumber(videoAggregates?.ssimMean)?.toFixed(4) ?? "n/a"}</p>
                                  <p>PSNR mean: {asNumber(videoAggregates?.psnrMean)?.toFixed(2) ?? "n/a"}</p>
                                  <p>Drift mean abs: {asNumber((videoAggregates?.frameDrift as Record<string, unknown> | undefined)?.meanAbsDeltaFrames)?.toFixed(2) ?? "n/a"} frames</p>
                                  <p>Drift max abs: {asNumber((videoAggregates?.frameDrift as Record<string, unknown> | undefined)?.maxAbsDeltaFrames)?.toFixed(2) ?? "n/a"} frames</p>
                                  {typeof (videoAggregates?.alignment as Record<string, unknown> | undefined)?.sourceFrameOffset === "number" ? (
                                    <p>Alignment starts at original frame {String((videoAggregates?.alignment as Record<string, unknown>).sourceFrameOffset)}</p>
                                  ) : null}
                                </>
                              ) : (
                                <p>No video diff tests were selected for this report.</p>
                              )}
                            </div>
                            <div className="md:col-span-2">
                              <div className="flex items-center gap-2">
                                <p className="text-xs font-medium text-ink/70">Timeline graph</p>
                                <InfoButton
                                  label="Explain timeline graph"
                                  onClick={() => openInfo("Timeline graph", [...QC_INFO_TEXT.timelineGraph])}
                                />
                              </div>
                              {timelineGraphUrl ? (
                                <button type="button" className="block w-full" onClick={() => setReportGraphModal({ url: timelineGraphUrl, label: "Video QC timeline graph" })}>
                                  <img src={timelineGraphUrl} alt="Timeline graph" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                </button>
                              ) : (
                                <p className="text-xs text-ink/50">No timeline graph</p>
                              )}
                              {timelineCsvUrl ? (
                                <div className="mt-1 flex items-center gap-2">
                                  <a href={timelineCsvUrl} target="_blank" rel="noreferrer" className="inline-block text-xs text-ink underline">
                                    Download CSV
                                  </a>
                                  <InfoButton label="Explain timeline CSV" onClick={() => openInfo("Timeline CSV", [...QC_INFO_TEXT.timelineCsv])} />
                                </div>
                              ) : null}
                            </div>
                            <div className="md:col-span-2">
                              <div className="flex items-center gap-2">
                                <p className="text-xs font-medium text-ink/70">Diff video map</p>
                                <InfoButton
                                  label="Explain diff video map"
                                  onClick={() => openInfo("Diff video map", [...QC_INFO_TEXT.diffVideoMap])}
                                />
                              </div>
                              {diffVideoUrl ? (
                                <button type="button" className="block w-full" onClick={() => setVideoPreviewModal({ url: diffVideoUrl, label: "Video diff map" })}>
                                  <img src={diffVideoPosterUrl ?? row.editedStartFrameUrl ?? row.originalFrameUrl ?? ""} alt="Diff video map" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                </button>
                              ) : (
                                <p className="text-xs text-ink/50">No diff video map</p>
                              )}
                            </div>
                          </div>
                          {(row.standard?.selectedTests ?? []).includes("video_frame_evidence") && selectedFrames.length ? (
                            <div className="grid gap-3">
                              {selectedFrames.slice(0, 3).map((frame) => (
                                <div key={`video-frame-${rowLabel}-${frame.index}`} className="space-y-2 rounded border border-ink/10 bg-white p-3">
                                  <div className="flex items-center gap-2">
                                    <p className="text-xs font-medium text-ink/70">
                                      Evidence original frame {String(frame.sourceFrameIndex ?? frame.index)}
                                      {typeof frame.timeSec === "number" ? ` · source ${Number(frame.timeSec).toFixed(2)}s` : ""}
                                    </p>
                                    <InfoButton
                                      label={`Explain evidence frame ${String(frame.index)}`}
                                      onClick={() => openInfo("Video frame evidence", [...QC_INFO_TEXT.videoFrameEvidence])}
                                    />
                                  </div>
                                  <div className="grid gap-3 md:grid-cols-3">
                                    <div className="space-y-1">
                                      <p className="text-[11px] font-medium text-ink/60">Source frame</p>
                                      {frame.originalFrameUrl ? (
                                        <button
                                          type="button"
                                          className="block w-full"
                                          onClick={() => setImagePreviewModal({ url: frame.originalFrameUrl as string, label: `Source frame ${String(frame.sourceFrameIndex ?? frame.index)}` })}
                                        >
                                          <img src={frame.originalFrameUrl as string} alt="Source frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                        </button>
                                      ) : (
                                        <p className="text-xs text-ink/50">No source frame image</p>
                                      )}
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-[11px] font-medium text-ink/60">Matched generated frame</p>
                                      {frame.generatedFrameUrl ? (
                                        <button
                                          type="button"
                                          className="block w-full"
                                          onClick={() => setImagePreviewModal({ url: frame.generatedFrameUrl as string, label: `Generated frame ${String(frame.matchedGeneratedFrameIndex ?? frame.generatedFrameIndex ?? "n/a")}` })}
                                        >
                                          <img src={frame.generatedFrameUrl as string} alt="Generated frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                        </button>
                                      ) : (
                                        <p className="text-xs text-ink/50">No generated frame image</p>
                                      )}
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-[11px] font-medium text-ink/60">Overlay / diff evidence</p>
                                      {frame.overlayUrl ? (
                                        <button type="button" className="block w-full" onClick={() => setImagePreviewModal({ url: frame.overlayUrl as string, label: `Video evidence frame ${String(frame.index)}` })}>
                                          <img src={frame.overlayUrl as string} alt="Video evidence frame" className="aspect-video w-full rounded border border-ink/10 bg-white object-contain" />
                                        </button>
                                      ) : (
                                        <p className="text-xs text-ink/50">No evidence image</p>
                                      )}
                                    </div>
                                  </div>
                                  <p className="text-[11px] text-ink/50">
                                    Expected generated f{String(frame.generatedFrameIndex ?? "n/a")} · matched f{String(frame.matchedGeneratedFrameIndex ?? frame.generatedFrameIndex ?? "n/a")} · drift{" "}
                                    {typeof frame.frameDeltaDrift === "number" ? `${frame.frameDeltaDrift >= 0 ? "+" : ""}${frame.frameDeltaDrift} frames` : "n/a"} · starts at original frame{" "}
                                    {String(frame.sourceFrameOffset ?? 0)}
                                    {typeof frame.matchSimilarity === "number" ? ` · similarity ${Number(frame.matchSimilarity).toFixed(3)}` : ""}
                                  </p>
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

                {activeResult && activeReportMeta.reportType === "video_compare" ? (
                  <div className="space-y-4">
                    {(() => {
                      const comparison = (activeResult.videoCompare ?? null) as VideoCompareReport | null;
                      if (!comparison) {
                        return <p className="text-sm text-ink/60">No comparison data was produced for this report.</p>;
                      }
                      const generations = comparison.generations ?? [];
                      const samples = comparison.samples ?? [];
                      const generationLabel = (genId: string | undefined) => {
                        const entry = generations.find((generation) => generation.genId === genId);
                        return entry ? `${entry.model ?? "model"} / ${entry.modelSubsetting ?? "default"}` : genId ?? "generation";
                      };
                      const renderSampleGrid = (
                        sample: VideoCompareSample,
                        keyName: keyof Pick<VideoCompareItem, "frameUrl" | "diffUrl" | "zoomFrameUrl" | "zoomDiffUrl">,
                        title: string,
                      ) => (
                        <div key={`${title}-${sample.frameIndex}`} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold">
                              {title} - original frame {sample.sourceFrameIndex ?? sample.frameIndex ?? "n/a"}
                            </p>
                            <p className="text-xs text-ink/60">
                              {typeof sample.timeSec === "number" ? `Source ${sample.timeSec.toFixed(2)}s` : ""}
                              {typeof sample.comparisonFrameIndex === "number" ? ` · comparison point ${sample.comparisonFrameIndex}` : ""}
                            </p>
                            {keyName === "zoomFrameUrl" || keyName === "zoomDiffUrl" ? (
                              <p className="text-xs text-ink/60">
                                300% crop
                                {sample.zoomRegion
                                  ? ` · x${sample.zoomRegion.x}, y${sample.zoomRegion.y}, ${sample.zoomRegion.width}x${sample.zoomRegion.height}`
                                  : ""}
                              </p>
                            ) : null}
                          </div>
                          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
                            {keyName === "frameUrl" && sample.originalUrl ? (
                              <div className="space-y-1">
                                <PreviewableImage
                                  url={sample.originalUrl}
                                  alt="Original source frame"
                                  label={`Original source frame ${sample.frameIndex ?? ""}`}
                                  onPreview={setImagePreviewModal}
                                  className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                />
                                <p className="text-xs font-medium text-ink/70">Original source</p>
                                <p className="text-[11px] text-ink/50">
                                  Original f{sample.sourceFrameIndex ?? "n/a"} · starts at frame 0
                                </p>
                              </div>
                            ) : null}
                            {keyName === "zoomFrameUrl" && sample.originalZoomUrl ? (
                              <div className="space-y-1">
                                <PreviewableImage
                                  url={sample.originalZoomUrl}
                                  alt="Original source zoom"
                                  label={`Original source zoom ${sample.frameIndex ?? ""}`}
                                  onPreview={setImagePreviewModal}
                                  className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                />
                                <p className="text-xs font-medium text-ink/70">Original source zoom</p>
                                <p className="text-[11px] text-ink/50">
                                  Original f{sample.sourceFrameIndex ?? "n/a"} · starts at frame 0
                                </p>
                              </div>
                            ) : null}
                            {(sample.items ?? []).map((item) => {
                              const url = item[keyName];
                              return (
                                <div key={`${sample.frameIndex}:${item.genId}:${keyName}`} className="space-y-1">
                                  <PreviewableImage
                                    url={url}
                                    alt={`${title} ${item.genId ?? ""}`}
                                    label={`${title} - ${generationLabel(item.genId)} - frame ${sample.frameIndex ?? ""}`}
                                    onPreview={setImagePreviewModal}
                                    className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                  />
                                  <p className="text-xs font-medium text-ink/70">{generationLabel(item.genId)}</p>
                                  <p className="text-[11px] text-ink/50">
                                    Generated f{item.generatedFrameIndex ?? "n/a"} · starts at original frame {item.sourceFrameOffset ?? 0}
                                    {typeof item.expectedGeneratedFrameIndex === "number" && item.expectedGeneratedFrameIndex !== item.generatedFrameIndex
                                      ? ` · refined from f${item.expectedGeneratedFrameIndex}`
                                      : ""}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );

                      return (
                        <>
                          <div className="rounded-lg border border-ink/10 bg-bg/20 p-3">
                            <p className="text-sm font-semibold">Segment comparison</p>
                            <p className="text-xs text-ink/60">
                              Segment {comparison.segmentId ?? "n/a"} · source start f{comparison.segmentStartFrame ?? "n/a"} · source fps{" "}
                              {typeof comparison.sourceFps === "number" ? comparison.sourceFps.toFixed(3) : "n/a"}
                            </p>
                            {comparison.alignment ? (
                              <p className="mt-1 text-xs text-ink/60">
                                Temporal alignment: comparisons start at original frame {comparison.alignment.alignedStartFrame ?? 0} after scanning the first{" "}
                                {comparison.alignment.scanFrameCount ?? "n/a"} source frames against generated anchor frames{" "}
                                {(comparison.alignment.anchorFrames ?? []).join(", ") || "n/a"}. Each model is aligned independently before the common start is chosen.
                              </p>
                            ) : null}
                          </div>
                          <div className="overflow-x-auto rounded-lg border border-ink/10 bg-white">
                            <table className="min-w-full text-left text-xs">
                              <thead className="bg-bg text-ink/70">
                                <tr>
                                  <th className="px-3 py-2">Model</th>
                                  <th className="px-3 py-2">Model setting</th>
                                  <th className="px-3 py-2">Prompt</th>
                                  <th className="px-3 py-2">Sent to model</th>
                                  <th className="px-3 py-2">Returned</th>
                                  <th className="px-3 py-2">Aspect</th>
                                  <th className="px-3 py-2">Frames</th>
                                  <th className="px-3 py-2">FPS</th>
                                  <th className="px-3 py-2">Seconds</th>
                                  <th className="px-3 py-2">Frame offset</th>
                                </tr>
                              </thead>
                              <tbody>
                                {generations.map((generation) => (
                                  <tr key={generation.genId} className="border-t border-ink/10 align-top">
                                    <td className="px-3 py-2 font-medium">{generation.model ?? "n/a"}</td>
                                    <td className="px-3 py-2">{generation.modelSubsetting ?? "n/a"}</td>
                                    <td className="max-w-md px-3 py-2">{generation.prompt ?? "No prompt provided"}</td>
                                    <td className="px-3 py-2">{formatResolution(generation.inputResolution)}</td>
                                    <td className="px-3 py-2">
                                      {formatResolution(generation.outputResolution)}
                                      {generation.storedOutputResolution && !sameResolution(generation.outputResolution, generation.storedOutputResolution) ? (
                                        <span className="block text-[11px] text-ink/50">
                                          stored {formatResolution(generation.storedOutputResolution)}
                                        </span>
                                      ) : null}
                                    </td>
                                    <td className="px-3 py-2">{generation.aspectRatio ?? "n/a"}</td>
                                    <td className="px-3 py-2">{generation.frameCount ?? "n/a"}</td>
                                    <td className="px-3 py-2">{typeof generation.fps === "number" ? generation.fps.toFixed(3) : "n/a"}</td>
                                    <td className="px-3 py-2">{typeof generation.durationSec === "number" ? generation.durationSec.toFixed(2) : "n/a"}</td>
                                    <td className="px-3 py-2">
                                      starts at frame {generation.sourceFrameOffset ?? generation.alignment?.sourceFrameOffset ?? 0}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div className="space-y-3">
                            <h5 className="text-sm font-semibold">Generated frame comparison</h5>
                            {samples.map((sample) => renderSampleGrid(sample, "frameUrl", "Generated frames"))}
                          </div>
                          <div className="space-y-3">
                            <h5 className="text-sm font-semibold">Diff maps vs original source</h5>
                            {samples.map((sample) => renderSampleGrid(sample, "diffUrl", "Diff maps"))}
                          </div>
                          <div className="space-y-3">
                            <h5 className="text-sm font-semibold">300% zoomed generated frames</h5>
                            {samples.map((sample) => renderSampleGrid(sample, "zoomFrameUrl", "Zoomed generated frames"))}
                          </div>
                          <div className="space-y-3">
                            <h5 className="text-sm font-semibold">300% zoomed diff maps</h5>
                            {samples.map((sample) => renderSampleGrid(sample, "zoomDiffUrl", "Zoomed diff maps"))}
                          </div>
                          {activeResult.failures?.length ? (
                            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                              {activeResult.failures.length} comparison item(s) failed during report build.
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

      <ReportCreateModal
        isOpen={createModalMode !== null}
        title={
          createModalMode === "qc_frame"
            ? "Create Frame QC Report"
            : createModalMode === "video_compare"
              ? "Create Video Comparison Report"
              : "Create Video QC Report"
        }
        selectedCount={createModalMode === "qc_frame" ? selectedFrameRefs.length : selectedVideoRefs.length}
        reportName={reportName}
        setReportName={setReportName}
        tests={
          createModalMode === "qc_frame"
            ? FRAME_TEST_OPTIONS
            : createModalMode === "video_compare"
              ? VIDEO_COMPARE_TEST_OPTIONS
              : VIDEO_TEST_OPTIONS
        }
        selectedTests={selectedTests}
        toggleTest={toggleTest}
        onClose={closeCreateModal}
        onCreate={() => void createReport()}
        isPending={createCustomReportMutation.isPending}
      />
      <InfoModal state={infoModal} onClose={() => setInfoModal(null)} />
    </div>
  );
}

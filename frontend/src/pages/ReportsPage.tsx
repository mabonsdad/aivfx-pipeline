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

type InfoModalState = {
  title: string;
  lines: string[];
} | null;

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
    classification?: Record<string, unknown>;
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

const QC_INFO_TEXT = {
  frameQcAnalysis: [
    "This summary shows how much the edited frame differs from the original frame, and if a mask is present, how much of that change falls outside the intended edit area. It is the clearest high-level check for edit containment.",
    "Use Changed to understand how much of the frame was altered at all, Outside leakage to see how much change happened outside the intended region, and Boundary spill to check whether change is clustering just beyond the mask edge. Read this together with the Frame diff overlay, Boundary/Binary map, and Boundary spill analysis to see whether the numbers reflect harmless global change or problematic spread beyond the edit.",
  ],
  frameDiffHeatmap: [
    "This view shows the strength of pixel-level change between the original frame and the edited frame. Cooler colors indicate little change, while warmer colors indicate stronger visible difference.",
    "Read this as a direct where did the frame change map. Strong activity inside the intended edit area is usually expected. Strong activity outside the intended area is more concerning, especially if it lines up with high values in the Composite anomaly map or Boundary spill analysis. Use this together with the Frame diff overlay when you want to relate the heatmap back to the actual image content.",
  ],
  frameDiffOverlay: [
    "This overlays the frame difference heatmap on top of the edited image, making it easier to see exactly which parts of the picture changed. If a mask is present, the intended edit boundary is also shown.",
    "Use this when you want the most intuitive answer to what changed, and where did it happen in the final image. This is often the fastest artifact for checking whether the edit stayed on the intended subject. If you see strong change outside the mask here, compare it with the Boundary/Binary map for a simpler changed or not changed view and with the Boundary spill analysis to judge how serious the spill is.",
  ],
  boundaryBinaryMap: [
    "This is a simplified changed or not changed view of the frame. Instead of showing change strength, it highlights only the pixels that crossed the change threshold, so it acts like a clean containment map.",
    "Use this when you want a simple answer to whether the edit stayed inside the intended region. It is less nuanced than the heatmap, but often easier to interpret quickly. Compare it with the Frame diff heatmap if you want more detail on change strength, and with the Boundary spill analysis if you want a boundary-specific measure of how much change extended beyond the mask.",
  ],
  advancedQcAnalysis: [
    "This section groups the advanced QC artifacts, which are designed to highlight local inconsistency rather than just raw pixel change. These checks are stronger for prioritizing review than the standard diff outputs, but they should still be interpreted alongside the original and edited images.",
    "Use this section when the standard frame diff outputs show that change occurred, but you need more help understanding whether the changed regions look visually coherent, contained, and plausible. Start with the Composite anomaly map for the overall pattern, then use the more specific advanced artifacts to understand what kind of issue is being detected.",
  ],
  compositeAnomalyMap: [
    "This is a combined review map that blends several patch-level checks into one image, so you can quickly see which regions deserve closer attention. It highlights areas that look locally inconsistent based on multiple signals rather than just raw pixel change.",
    "Read this as a where should I look first map, not a literal truth score. Higher values inside the intended edit area may simply reflect the intended change. Higher values outside the intended area are more concerning, especially if they also show up in the Frame diff overlay or Boundary spill analysis. This is the best single artifact for prioritizing manual review, while the individual advanced maps help explain why an area was highlighted.",
  ],
  lpipsPatchMap: [
    "This view highlights patches where the edited frame differs most strongly from the original frame in overall appearance. It is designed to reflect visually meaningful local change rather than only binary changed pixels.",
    "Use this to judge where the edit changed the look of the image most noticeably. Strong activity inside the intended edit area is often expected. Strong activity outside that area suggests visible spill or collateral change. Compare it with the Frame diff heatmap to see whether those changes are also large at the pixel level, and with the Composite anomaly map to see whether the changed areas also look locally inconsistent.",
  ],
  boundarySpillAnalysis: [
    "This view focuses specifically on the area around the intended edit boundary. It helps show whether the edit remained concentrated inside the masked region or whether significant change and anomaly extend into the surrounding area.",
    "Use this as the most targeted containment check in the advanced QC set. A lower score usually means the edit is staying more cleanly inside the intended boundary. Higher outside activity means the surrounding pixels are being altered more than expected. Compare it with the Boundary/Binary map for a stricter changed or not changed view, and with the Composite anomaly map when you want to know whether the spill also looks locally inconsistent.",
  ],
  sharpnessConsistency: [
    "This map shows where the edited image has a different local sharpness or edge strength pattern from the original image, or where a patch stands out from the overall sharpness pattern of the edited frame.",
    "Use this when you want to see whether the edited area looks too sharp, too soft, or uneven compared with the rest of the image. High values inside the intended edit area may be acceptable if the edit adds or removes detail. High values outside the intended area are more concerning. Compare this with the Noise or microtexture map to separate edge crispness issues from fine-detail texture changes, and with the Composite anomaly map to see whether sharpness inconsistency is a major driver of the overall anomaly.",
  ],
  naturalnessMap: [
    "This map highlights areas in the edited frame that look statistically unusual compared with the rest of that same edited frame. Unlike most of the other artifacts, it does not compare against the original frame.",
    "Use this as an edited-frame-only anomaly check. It is best for spotting patches that stand out from their surroundings because they look unusually flat, noisy, or otherwise atypical within the final image. High values inside the intended edit region may simply reflect the changed content, so this view is strongest when used as supporting evidence. Compare it with the comparison-based artifacts, especially the Composite anomaly map and Noise or microtexture map, before drawing conclusions.",
  ],
  microtextureMap: [
    "This map highlights where the fine detail, grain, or local texture pattern changed between the original frame and the edited frame. It is useful for spotting areas that have become over-smoothed, over-sharpened, or texturally inconsistent.",
    "Use this when the overall structure looks plausible but the surface detail feels wrong. High values inside the intended edit region may be expected for a strong edit, but high values outside it are a stronger warning sign. Compare it with Focus or sharpness consistency to separate texture shifts from edge sharpness changes, and with the LPIPS patch map to see whether the textural change also corresponds to a more visible overall appearance change.",
  ],
  qcClassification: [
    "This is the overall pass, warn, or fail summary for the advanced QC checks. It is a rule-based result that gives a quick triage view of whether the edit appears contained and visually consistent enough to pass review.",
    "Use this as a summary, not as the only thing you rely on. When a frame is flagged, look at the Composite anomaly map first for the overall pattern, then use Boundary spill analysis and the standard diff artifacts to understand whether the issue is mainly leakage outside the intended edit area or broader local inconsistency. The classification is most useful for ranking and filtering, while the artifacts explain why the frame was flagged.",
  ],
  diffVideoMap: [
    "This video shows the moving difference between the original clip and the edited clip over time. It makes temporal change easy to spot, including drift, flicker, and any change appearing outside the intended edit region.",
    "Use this when a still frame is not enough and you want to see whether the edit remains stable throughout the shot. Bright or persistent activity outside the intended area is more concerning. Compare what you see here with the Timeline graph to find the specific moments where change or leakage spikes.",
  ],
  videoQcAnalysis: [
    "This summary shows how much the generated segment differs from the original segment over time, and if a start-frame mask exists, how much of that change appears to leak outside the intended edit region. It is the clearest high-level check for temporal edit containment.",
    "Use Changed mean to understand how much of the clip differs overall, Outside leak mean to see how much of that change falls beyond the intended region, and the similarity metrics to judge how close the generated segment stays to the original over time. Read this together with the Diff video map, Timeline graph, and Video frame evidence to decide whether the differences are acceptable or indicate drift, flicker, or spill.",
  ],
  timelineGraph: [
    "This graph shows how frame-level change and outside leakage vary over time across the clip. It helps identify whether problems are isolated to a few moments or persist throughout the segment.",
    "Use this as the fastest way to spot unstable edits. Peaks in total change show moments where the frame differs most from the original, while peaks in outside leakage suggest containment problems. If you see spikes, check the corresponding Video frame evidence and Diff video map to understand what happened visually at those times.",
  ],
  timelineCsv: [
    "This file contains the timeline data behind the video QC report in machine-readable form. It is useful for deeper inspection, debugging, filtering, or plotting outside the report UI.",
    "Use this when you want exact values rather than the summarized graph. It is especially helpful for correlating spikes in change or leakage with timestamps, or for comparing segments programmatically. Read it together with the Timeline graph and Video frame evidence for the clearest interpretation.",
  ],
  videoFrameEvidence: [
    "These are selected frames from the clip that best illustrate the strongest anomalies or the most representative midpoint. Each evidence frame includes the same still-frame diff artifacts used in frame QC.",
    "Use these as the bridge between the timeline-level summary and actual visible content. When the timeline shows spikes, these frames help explain what the clip looked like at those moments. Compare them with the Diff video map for temporal context and with the still-frame advanced maps when you want a more detailed local explanation of the issue.",
  ],
} as const;

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

function selectionMarker(checked: boolean): string {
  return checked ? "✓" : "";
}

function summarizeReport(report: CustomReportRecord, task: TaskDetail | undefined): string {
  const asset_refs = report.assetRefs ?? [];
  if (!task || !asset_refs.length) {
    return `${asset_refs.length} selected asset${asset_refs.length === 1 ? "" : "s"}`;
  }
  if (report.reportType === "qc_frame") {
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

function InfoButton(props: { onClick: () => void; label: string }) {
  const { onClick, label } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-ink/20 bg-white text-[10px] font-semibold text-ink/70"
    >
      i
    </button>
  );
}

function InfoModal(props: { state: InfoModalState; onClose: () => void }) {
  const { state, onClose } = props;
  if (!state) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-4xl rounded-2xl border border-ink/10 bg-card p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-semibold">{state.title}</h3>
          </div>
          <button type="button" className="text-sm text-ink/60 underline" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-5 space-y-4 text-base leading-7 text-ink/75">
          {state.lines.map((line, index) => (
            <p key={`${state.title}-${index}`}>{line}</p>
          ))}
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
  const [infoModal, setInfoModal] = useState<InfoModalState>(null);

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
            {!activeReportMeta ? (
              !reports.length ? (
                <p className="text-sm text-ink/60">No reports created yet.</p>
              ) : (
                <div className="space-y-2">
                  {reports.map((report) => (
                    <div key={report.reportId} className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-white p-3">
                      <button type="button" className="text-left" onClick={() => setActiveCustomReportId(report.reportId)}>
                        <p className="text-sm font-semibold">{report.name}</p>
                        <p className="text-xs text-ink/60">
                          {report.reportType === "qc_frame" ? "Frame QC" : "Video QC"} - {report.status}
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
                              {row.maskUrl ? <img src={row.maskUrl} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-black object-contain" /> : <p className="text-xs text-ink/50">No mask</p>}
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
                          {row.standard ? (
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
                                                ? [...QC_INFO_TEXT.lpipsPatchMap]
                                                : card.key === "boundary"
                                                  ? [...QC_INFO_TEXT.boundarySpillAnalysis]
                                                  : card.key === "sharpness"
                                                    ? [...QC_INFO_TEXT.sharpnessConsistency]
                                                    : card.key === "naturalness"
                                                      ? [...QC_INFO_TEXT.naturalnessMap]
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
                      const videoAggregates = row.standard?.aggregates;
                      const videoArtifacts = row.standard?.artifacts;
                      const timelineGraphUrl = videoArtifacts?.timelineGraphUrl as string | undefined;
                      const timelineCsvUrl = videoArtifacts?.timelineCsvUrl as string | undefined;
                      const diffVideoUrl = videoArtifacts?.diffVideoUrl as string | undefined;
                      const diffVideoPosterUrl = videoArtifacts?.diffVideoPosterUrl as string | undefined;
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
                              {row.maskUrl ? <img src={row.maskUrl} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-black object-contain" /> : <p className="text-xs text-ink/50">No mask</p>}
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
                            <div className="grid gap-3 md:grid-cols-3">
                              {selectedFrames.slice(0, 3).map((frame) => (
                                <div key={`video-frame-${row.genId}-${frame.index}`} className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <p className="text-xs font-medium text-ink/70">Evidence frame {String(frame.index)}</p>
                                    <InfoButton
                                      label={`Explain evidence frame ${String(frame.index)}`}
                                      onClick={() => openInfo("Video frame evidence", [...QC_INFO_TEXT.videoFrameEvidence])}
                                    />
                                  </div>
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
            )}
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
      <InfoModal state={infoModal} onClose={() => setInfoModal(null)} />
    </main>
  );
}

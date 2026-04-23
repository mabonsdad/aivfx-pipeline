import type { ReactNode } from "react";

export const FRAME_TEST_OPTIONS = [
  { id: "frame_diff", label: "Frame diff set", description: "Diff heatmap, overlay, binary/boundary map and standard still metrics." },
  { id: "frame_composite", label: "Composite anomaly map", description: "Combined anomaly overlay with top anomalous regions." },
  { id: "frame_perceptual", label: "Perceptual difference map", description: "Patchwise perceptual-difference proxy and local change scores." },
  { id: "frame_boundary", label: "Boundary spill analysis", description: "Inside/outside ring analysis for spill beyond the intended edit region." },
  { id: "frame_sharpness", label: "Frame sharpness consistency", description: "Focus and sharpness mismatch maps across the edited frame." },
  { id: "frame_naturalness", label: "Naturalness proxy", description: "Edited-frame anomaly proxy highlighting statistically unusual patches." },
  { id: "frame_texture", label: "Frame microtexture", description: "Noise and microtexture consistency map for over-smoothed or over-sharpened areas." },
] as const;

export const VIDEO_TEST_OPTIONS = [
  { id: "video_diff", label: "Video diff set", description: "Diff video, timeline graph/CSV and aggregate video QC metrics." },
  { id: "video_frame_evidence", label: "Video frame evidence", description: "Representative extracted frame QC evidence from the generated segment." },
] as const;

export const VIDEO_COMPARE_TEST_OPTIONS = [
  {
    id: "video_model_compare",
    label: "Model comparison grid",
    description: "Metadata table plus full-frame, diff-map and 300% zoom grids at frames 0, 60, 120 and 180 where available.",
  },
] as const;

export const QC_INFO_TEXT = {
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
  perceptualDifferenceMap: [
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
  naturalnessProxy: [
    "This map highlights areas in the edited frame that look statistically unusual compared with the rest of that same edited frame. Unlike most of the other artifacts, it does not compare against the original frame.",
    "Use this as an edited-frame-only anomaly check. It is best for spotting patches that stand out from their surroundings because they look unusually flat, noisy, or otherwise atypical within the final image. High values inside the intended edit region may simply reflect the changed content, so this view is strongest when used as supporting evidence. Compare it with the comparison-based artifacts, especially the Composite anomaly map and Noise or microtexture map, before drawing conclusions.",
  ],
  microtextureMap: [
    "This map highlights where the fine detail, grain, or local texture pattern changed between the original frame and the edited frame. It is useful for spotting areas that have become over-smoothed, over-sharpened, or texturally inconsistent.",
    "Use this when the overall structure looks plausible but the surface detail feels wrong. High values inside the intended edit region may be expected for a strong edit, but high values outside it are a stronger warning sign. Compare it with Focus or sharpness consistency to separate texture shifts from edge sharpness changes, and with the Perceptual difference map to see whether the textural change also corresponds to a more visible overall appearance change.",
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

export type InfoModalState = {
  title: string;
  lines: string[];
} | null;

export function ReportCreateModal(props: {
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

export function InfoButton(props: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ink/20 bg-white text-[10px] font-semibold text-ink/70"
    >
      i
    </button>
  );
}

export function HeatmapLegend(props: { label: string; description?: string }) {
  return (
    <div className="space-y-1 rounded border border-ink/10 bg-white px-3 py-2 text-left text-[11px] text-ink/65">
      <p className="font-medium text-ink/80">{props.label}</p>
      {props.description ? <p>{props.description}</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[#1e4fba]" />
          <span>Blue = lower</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[#ffd84d]" />
          <span>Yellow = moderate</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[#e22626]" />
          <span>Red = stronger</span>
        </span>
      </div>
    </div>
  );
}

export function InfoModal(props: { state: InfoModalState; onClose: () => void; footer?: ReactNode }) {
  const { state, onClose, footer } = props;
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
        {footer ? <div className="mt-5">{footer}</div> : null}
      </div>
    </div>
  );
}

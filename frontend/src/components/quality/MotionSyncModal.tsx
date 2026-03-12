import type { ExportRecord } from "../../types/api";

type MotionSyncModalProps = {
  isOpen: boolean;
  exportRecord: ExportRecord | null;
  onClose: () => void;
  onRun: (exportId: string) => void;
  isRunPending: boolean;
};

function recommendationLabel(value: string | undefined): string {
  if (value === "shift_later") return "Shift generated insert later";
  if (value === "shift_earlier") return "Shift generated insert earlier";
  if (value === "no_shift") return "No timing shift recommended";
  return "No recommendation available";
}

export default function MotionSyncModal({ isOpen, exportRecord, onClose, onRun, isRunPending }: MotionSyncModalProps) {
  if (!isOpen || !exportRecord) return null;
  const qc = exportRecord.motionSyncQc;
  const metrics = qc?.metrics;
  const artifacts = qc?.artifacts;
  const running = qc?.status === "queued" || qc?.status === "running";
  const canRun = !running && !isRunPending;

  return (
    <div className="fixed inset-0 z-[61] flex items-center justify-center bg-black/55 p-4">
      <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-ink/15 bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Motion Sync QA</h3>
            <p className="text-sm text-ink/70">
              Compare motion timing in this merged video against the original timeline and estimate whether start-time shift improves sync.
            </p>
            <p className="mt-1 text-xs text-ink/60">{exportRecord.exportId}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded border border-ink/20 bg-white px-3 py-1.5 text-sm">
            Close
          </button>
        </div>

        <div className="mt-4 rounded-lg border border-ink/10 bg-bg p-3">
          {qc?.status === "complete" ? (
            <p className="text-sm text-teal-700">Latest analysis complete{qc.analyzedAt ? ` · ${new Date(qc.analyzedAt).toLocaleString()}` : ""}</p>
          ) : qc?.status === "failed" ? (
            <p className="text-sm text-red-700">Analysis failed: {qc.error ?? "Unknown error"}</p>
          ) : running ? (
            <p className="text-sm text-amber-700">Analysis is running. The modal will update when task data refreshes.</p>
          ) : (
            <p className="text-sm text-ink/70">No motion sync analysis has run for this merged output yet.</p>
          )}
        </div>

        {metrics ? (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded border border-ink/10 bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-ink/50">Baseline corr</p>
              <p className="mt-1 text-lg font-semibold">{Number(metrics.baselineCorrelation ?? 0).toFixed(4)}</p>
            </div>
            <div className="rounded border border-ink/10 bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-ink/50">Best corr</p>
              <p className="mt-1 text-lg font-semibold">{Number(metrics.bestCorrelation ?? 0).toFixed(4)}</p>
            </div>
            <div className="rounded border border-ink/10 bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-ink/50">Gain</p>
              <p className="mt-1 text-lg font-semibold">{Number(metrics.correlationGain ?? 0).toFixed(4)}</p>
            </div>
            <div className="rounded border border-ink/10 bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-ink/50">Recommended shift</p>
              <p className="mt-1 text-lg font-semibold">
                {Number(metrics.recommendedShiftFrames ?? 0)}f ({Number(metrics.recommendedShiftSec ?? 0).toFixed(3)}s)
              </p>
            </div>
            <div className="rounded border border-ink/10 bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-ink/50">Offset at sample rate</p>
              <p className="mt-1 text-lg font-semibold">
                {Number(metrics.bestOffsetSamples ?? 0)} samples ({Number(metrics.bestOffsetSec ?? 0).toFixed(3)}s)
              </p>
            </div>
            <div className="rounded border border-ink/10 bg-white p-3">
              <p className="text-xs uppercase tracking-wide text-ink/50">Confidence</p>
              <p className="mt-1 text-lg font-semibold">{Math.round(Number(metrics.confidence ?? 0) * 100)}%</p>
            </div>
          </div>
        ) : null}

        {metrics ? (
          <p className="mt-3 text-sm font-medium text-ink">
            Recommendation: {recommendationLabel(typeof metrics.recommendation === "string" ? metrics.recommendation : undefined)}
          </p>
        ) : null}

        {artifacts?.timelineGraphUrl ? (
          <div className="mt-4 overflow-hidden rounded border border-ink/10 bg-white p-2">
            <img src={artifacts.timelineGraphUrl} alt="Motion sync timeline graph" className="w-full object-contain" />
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onRun(exportRecord.exportId)}
            disabled={!canRun}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunPending ? "Starting..." : qc?.status === "complete" ? "Re-run motion QA" : "Run motion QA"}
          </button>
          {artifacts?.timelineCsvUrl ? (
            <a href={artifacts.timelineCsvUrl} className="rounded border border-ink/20 bg-white px-3 py-2 text-sm text-ink">
              Download timeline CSV
            </a>
          ) : null}
          {artifacts?.reportJsonUrl ? (
            <a href={artifacts.reportJsonUrl} className="rounded border border-ink/20 bg-white px-3 py-2 text-sm text-ink">
              Download report JSON
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}


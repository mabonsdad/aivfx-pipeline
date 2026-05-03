import type { JobStatus } from "../../types/api";
import { Spinner } from "../../components/layout/UiFeedback";

export type JobsPanelCtx = {
  sortedJobs: JobStatus[];
  jobsVisible: number;
  setJobsVisible: (update: number | ((count: number) => number)) => void;
};

type JobsPanelProps = {
  ctx: JobsPanelCtx;
};

export default function JobsPanel({ ctx }: JobsPanelProps) {
  const { sortedJobs, jobsVisible, setJobsVisible } = ctx;

  return (
    <div className="rounded-2xl border border-ink/10 bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Jobs</h3>
      <div className="space-y-2 text-sm">
        {sortedJobs.length === 0 && <p className="text-ink/60">No jobs yet.</p>}
        {sortedJobs.slice(0, jobsVisible).map((job) => {
          return (
            <div
              key={job.jobId}
              className={`rounded border p-2 ${job.status === "failed" ? "border-red-200 bg-red-50" : "border-ink/10"}`}
            >
              <p className="font-medium">
                {job.jobId} <span className="text-ink/60">({job.type})</span>
              </p>
              <p className="inline-flex items-center gap-1.5 text-xs uppercase">
                {job.status === "queued" || job.status === "running" ? <Spinner className="h-3 w-3" /> : null}
                {job.status} - {job.progress}%
              </p>
              {job.error ? <p className="text-xs text-red-600">{job.error}</p> : null}
            </div>
          );
        })}
        {jobsVisible < sortedJobs.length ? (
          <button className="text-sm text-accent underline" onClick={() => setJobsVisible((count) => count + 6)}>
            More...
          </button>
        ) : null}
      </div>
    </div>
  );
}

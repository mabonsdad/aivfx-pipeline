type JobsPanelProps = {
  ctx: any;
};

export default function JobsPanel({ ctx }: JobsPanelProps) {
  const { sortedJobs, jobsVisible, setJobsVisible } = ctx as any;

  return (
    <div className="rounded-2xl border border-ink/10 bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Jobs</h3>
      <div className="space-y-2 text-sm">
        {sortedJobs.length === 0 && <p className="text-ink/60">No jobs yet.</p>}
        {sortedJobs.slice(0, jobsVisible).map((job: any) => {
          return (
            <div
              key={job.jobId}
              className={`rounded border p-2 ${job.status === "failed" ? "border-orange-400 bg-orange-50" : "border-ink/10"}`}
            >
              <p className="font-medium">
                {job.jobId} <span className="text-ink/60">({job.type})</span>
              </p>
              <p className="text-xs uppercase">
                {job.status} - {job.progress}%
              </p>
              {job.error ? <p className="text-xs text-red-600">{job.error}</p> : null}
            </div>
          );
        })}
        {jobsVisible < sortedJobs.length ? (
          <button className="text-sm text-accent underline" onClick={() => setJobsVisible((count: number) => count + 6)}>
            More...
          </button>
        ) : null}
      </div>
    </div>
  );
}

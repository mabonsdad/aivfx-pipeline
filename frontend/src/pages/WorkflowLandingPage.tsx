import FivefoldLogo from "../components/branding/FivefoldLogo";
import ProjectBadge from "../components/tasks/ProjectBadge";
import { getTaskWorkflowConfig, type TaskWorkflowId } from "../lib/taskWorkflows";

type WorkflowLandingPageProps = {
  workflowId: TaskWorkflowId;
  latestTaskId: string | null;
  latestTaskName: string | null;
  latestTaskProjectName: string | null;
  latestTaskThumbnailUrl: string | null;
  onSelectTask: (workflowId: TaskWorkflowId) => void;
  onOpenLatestTask: (taskId: string) => void;
  onNewTask: (workflowId: TaskWorkflowId) => void;
  onGoHome: () => void;
  onSignOut: () => void;
};

export default function WorkflowLandingPage({
  workflowId,
  latestTaskId,
  latestTaskName,
  latestTaskProjectName,
  latestTaskThumbnailUrl,
  onSelectTask,
  onOpenLatestTask,
  onNewTask,
  onGoHome,
  onSignOut,
}: WorkflowLandingPageProps) {
  const workflow = getTaskWorkflowConfig(workflowId);
  const isUserFacing = workflow.userFacing;

  return (
    <main className="min-h-screen bg-bg px-6 py-10 text-ink md:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex justify-between gap-4">
          <button type="button" onClick={onGoHome} className="text-xs text-accent underline">
            Back to workflows
          </button>
          <button type="button" onClick={onSignOut} className="text-xs text-ink/60 underline">
            Sign out
          </button>
        </div>
        <div className="flex flex-col items-center text-center">
          <FivefoldLogo className="h-auto w-[22rem] max-w-full" />
          <div className="mt-8 w-full max-w-2xl rounded-2xl border border-ink/10 bg-card p-8 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">Workflow</p>
            <h1 className="mt-2 text-3xl font-semibold text-ink">{workflow.label}</h1>
            <p className="mt-4 text-sm leading-6 text-ink/70">{workflow.description}</p>
            {!isUserFacing ? (
              <div className="mt-6 rounded-xl border border-dashed border-ink/15 bg-bg px-4 py-4 text-left">
                <p className="text-sm font-medium text-ink">This workflow is reserved for a separate canvas surface.</p>
                <p className="mt-2 text-sm leading-6 text-ink/65">
                  The shared app already recognises its tasks, auth, and asset metadata, but task creation and workflow-specific
                  editing are intentionally not exposed from this landing page.
                </p>
              </div>
            ) : null}
            {latestTaskId ? (
              <button
                type="button"
                className="mt-8 block w-full rounded-xl border border-ink/10 bg-bg px-4 py-3 text-left transition hover:border-accent/40 hover:bg-white"
                onClick={() => onOpenLatestTask(latestTaskId)}
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/45">Latest task</p>
                {latestTaskThumbnailUrl ? (
                  <img
                    src={latestTaskThumbnailUrl}
                    alt={latestTaskName ? `${latestTaskName} preview` : `${workflow.homeTitle} preview`}
                    className="mt-2 aspect-video w-full rounded-lg border border-ink/10 bg-white object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="text-sm text-ink/75">{latestTaskName}</p>
                  {latestTaskProjectName ? <ProjectBadge name={latestTaskProjectName} /> : null}
                </div>
              </button>
            ) : (
              <div className="mt-8 rounded-xl border border-ink/10 bg-bg px-4 py-3 text-left">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/45">Latest task</p>
                <p className="mt-2 text-sm text-ink/75">No task yet for this workflow.</p>
              </div>
            )}
            {isUserFacing ? (
              <>
                <div className="mt-8 flex items-center justify-center gap-4">
                  <button type="button" className="text-sm font-medium text-accent underline" onClick={() => onSelectTask(workflowId)}>
                    Select task
                  </button>
                  <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white" onClick={() => onNewTask(workflowId)}>
                    New task
                  </button>
                </div>
                {latestTaskId ? null : <p className="mt-4 text-xs text-ink/50">Create the first task in this workflow to start building a reusable library of outputs and references.</p>}
              </>
            ) : latestTaskId ? (
              <p className="mt-4 text-xs text-ink/50">Open an existing canvas task above to inspect shared assets and outputs.</p>
            ) : (
              <p className="mt-4 text-xs text-ink/50">Canvas tasks will appear here once they are created from the separate canvas surface.</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

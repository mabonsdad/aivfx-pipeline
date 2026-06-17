import FivefoldLogo from "../components/branding/FivefoldLogo";
import ProjectBadge from "../components/tasks/ProjectBadge";
import { getTaskWorkflowConfig, type TaskWorkflowId } from "../lib/taskWorkflows";

type WorkflowHomeCard = {
  workflowId: TaskWorkflowId;
  latestTaskId: string | null;
  latestTaskName: string | null;
  latestTaskProjectName: string | null;
  latestTaskThumbnailUrl: string | null;
};

type HomePageProps = {
  cards: WorkflowHomeCard[];
  onSelectTask: (workflowId: TaskWorkflowId) => void;
  onOpenLatestTask: (taskId: string) => void;
  onNewTask: (workflowId: TaskWorkflowId) => void;
  onSignOut: () => void;
};

export default function HomePage({ cards, onSelectTask, onOpenLatestTask, onNewTask, onSignOut }: HomePageProps) {
  return (
    <main className="min-h-screen bg-bg px-6 py-10 text-ink md:px-10">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex justify-end">
          <button type="button" onClick={onSignOut} className="text-xs text-ink/60 underline">
            Sign out
          </button>
        </div>
        <div className="mb-12 flex flex-col items-center text-center">
          <FivefoldLogo className="h-auto w-[22rem] max-w-full" />
          <p className="mt-4 text-sm uppercase tracking-[0.26em] text-ink/55">AI Workflows</p>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          {cards.map((card) => {
            const workflow = getTaskWorkflowConfig(card.workflowId);
            return (
              <section key={card.workflowId} className="flex min-h-[20rem] flex-col rounded-2xl border border-ink/10 bg-card p-6 shadow-sm">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-2xl font-semibold text-ink">{workflow.homeTitle}</p>
                    <p className="mt-2 text-sm leading-6 text-ink/70">{workflow.homeDescription}</p>
                  </div>
                </div>
                <div className="mt-auto space-y-4">
                  {card.latestTaskId ? (
                    <button
                      type="button"
                      className="block w-full rounded-xl border border-ink/10 bg-bg px-4 py-3 text-left transition hover:border-accent/40 hover:bg-white"
                      onClick={() => onOpenLatestTask(card.latestTaskId!)}
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/45">Latest task</p>
                      {card.latestTaskThumbnailUrl ? (
                        <img
                          src={card.latestTaskThumbnailUrl}
                          alt={card.latestTaskName ? `${card.latestTaskName} preview` : `${workflow.homeTitle} preview`}
                          className="mt-2 aspect-video w-full rounded-lg border border-ink/10 bg-white object-contain"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="text-sm text-ink/75">{card.latestTaskName}</p>
                        {card.latestTaskProjectName ? <ProjectBadge name={card.latestTaskProjectName} /> : null}
                      </div>
                    </button>
                  ) : (
                    <div className="rounded-xl border border-ink/10 bg-bg px-4 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/45">Latest task</p>
                      <p className="mt-2 text-sm text-ink/75">No task yet for this workflow.</p>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4">
                    <button type="button" className="text-sm font-medium text-accent underline" onClick={() => onSelectTask(card.workflowId)}>
                      Select task
                    </button>
                    <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white" onClick={() => onNewTask(card.workflowId)}>
                      New task
                    </button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}

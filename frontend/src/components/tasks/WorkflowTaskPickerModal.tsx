import { getTaskWorkflowConfig, type TaskWorkflowId } from "../../lib/taskWorkflows";
import type { TaskSummary } from "../../types/api";

type WorkflowTaskPickerModalProps = {
  workflowId: TaskWorkflowId | null;
  tasks: TaskSummary[];
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  onNewTask: (workflowId: TaskWorkflowId) => void;
};

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown update";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function WorkflowTaskPickerModal({
  workflowId,
  tasks,
  onClose,
  onSelectTask,
  onNewTask,
}: WorkflowTaskPickerModalProps) {
  if (!workflowId) return null;
  const workflow = getTaskWorkflowConfig(workflowId);

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl border border-ink/15 bg-white p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Select ${workflow.label} task`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Select task</p>
            <h2 className="mt-1 text-2xl font-semibold text-ink">{workflow.homeTitle}</h2>
            <p className="mt-2 text-sm text-ink/65">Choose an existing task for this workflow or start a new one.</p>
          </div>
          <button type="button" className="rounded border border-ink/15 px-3 py-1.5 text-xs text-ink/70" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mt-5 max-h-[26rem] space-y-2 overflow-y-auto pr-1">
          {tasks.length ? (
            tasks.map((task) => (
              <button
                key={task.taskId}
                type="button"
                className="flex w-full items-start justify-between gap-4 rounded-xl border border-ink/10 bg-bg px-4 py-3 text-left transition hover:border-accent/35 hover:bg-accent/5"
                onClick={() => onSelectTask(task.taskId)}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{task.name}</p>
                  <p className="mt-1 text-xs text-ink/55">Updated {formatUpdatedAt(task.updatedAt)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/45">{task.status}</p>
                </div>
              </button>
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-ink/15 bg-bg px-4 py-6 text-sm text-ink/65">
              No tasks yet for this workflow.
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-ink/10 pt-4">
          <p className="text-xs text-ink/50">Tasks are shown most recently updated first.</p>
          <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white" onClick={() => onNewTask(workflowId)}>
            New task
          </button>
        </div>
      </div>
    </div>
  );
}

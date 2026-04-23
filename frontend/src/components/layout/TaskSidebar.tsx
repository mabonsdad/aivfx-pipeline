import { useState } from "react";
import type { TaskSummary } from "../../types/api";

type TaskSidebarProps = {
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  onSignOut: () => void;
  onOpenNewTask: () => void;
  onOpenTaskReport: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenAssetLibrary: () => void;
  onOpenCustomQc: () => void;
  onOpenApiLogs: () => void;
};

export default function TaskSidebar({
  tasks,
  selectedTaskId,
  onSignOut,
  onOpenNewTask,
  onOpenTaskReport,
  onSelectTask,
  onDeleteTask,
  onOpenAssetLibrary,
  onOpenCustomQc,
  onOpenApiLogs,
}: TaskSidebarProps) {
  const [pendingDeleteTask, setPendingDeleteTask] = useState<TaskSummary | null>(null);

  return (
    <aside className="col-span-12 rounded-2xl border border-ink/10 bg-card p-3 md:col-span-2">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Tasks</h2>
        <button onClick={onSignOut} className="text-xs text-ink/60 underline">
          Sign out
        </button>
      </div>

      <button className="mb-3 w-full rounded-md bg-accent px-3 py-1.5 text-xs text-white" onClick={onOpenNewTask}>
        Add New Task
      </button>

      <div className="space-y-1.5">
        {tasks.map((taskItem) => (
          <div
            key={taskItem.taskId}
            className={`relative w-full rounded-md border px-2.5 py-1.5 text-left ${
              selectedTaskId === taskItem.taskId ? "border-accent bg-accent/10" : "border-ink/10 bg-white"
            }`}
          >
            <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-ink/20 bg-white text-[10px] font-semibold text-ink/70"
                title="Open task report"
                aria-label={`Open report for ${taskItem.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenTaskReport(taskItem.taskId);
                }}
              >
                i
              </button>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-ink/20 bg-white text-red-600"
                title="Delete task"
                aria-label={`Delete ${taskItem.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDeleteTask(taskItem);
                }}
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            </div>
            <button className="w-full pr-12 text-left" onClick={() => onSelectTask(taskItem.taskId)}>
              <p className="truncate text-sm font-medium leading-tight">{taskItem.name}</p>
              {taskItem.status === "error" ? <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600">ERROR</p> : null}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        <button className="block text-xs text-accent underline" onClick={onOpenAssetLibrary}>
          Open Asset Library
        </button>
        <button className="block text-xs text-accent underline" onClick={onOpenCustomQc}>
          Custom QC test
        </button>
        <button className="block text-xs text-accent underline" onClick={onOpenApiLogs}>
          API Logs
        </button>
      </div>

      {pendingDeleteTask ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-ink/15 bg-white p-4 shadow-xl">
            <p className="text-sm font-medium text-ink">Are you sure you want to delete this task?</p>
            <p className="mt-1 text-xs text-ink/70">{pendingDeleteTask.name}</p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded border border-ink/20 px-3 py-1.5 text-xs"
                onClick={() => setPendingDeleteTask(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white"
                onClick={() => {
                  onDeleteTask(pendingDeleteTask.taskId);
                  setPendingDeleteTask(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

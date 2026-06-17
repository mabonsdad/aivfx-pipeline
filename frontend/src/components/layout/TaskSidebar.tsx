import { useMemo, useState } from "react";
import FivefoldLogo from "../branding/FivefoldLogo";
import ProjectBadge from "../tasks/ProjectBadge";
import { getTaskWorkflowConfig, normalizeTaskWorkflowId, type TaskWorkflowId } from "../../lib/taskWorkflows";
import type { TaskSummary } from "../../types/api";

type TaskSidebarProps = {
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  currentWorkflowId: TaskWorkflowId | null;
  isAdmin: boolean;
  onSignOut: () => void;
  onGoHome: () => void;
  onOpenNewTask: () => void;
  onOpenTaskReport: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenAssetLibrary: () => void;
  onOpenAllAssetLibrary: () => void;
  onOpenCustomQc: () => void;
  onOpenApiLogs: () => void;
  onOpenAllApiLogs: () => void;
  onOpenAdmin: () => void;
};

export default function TaskSidebar({
  tasks,
  selectedTaskId,
  currentWorkflowId,
  isAdmin,
  onSignOut,
  onGoHome,
  onOpenNewTask,
  onOpenTaskReport,
  onSelectTask,
  onDeleteTask,
  onOpenAssetLibrary,
  onOpenAllAssetLibrary,
  onOpenCustomQc,
  onOpenApiLogs,
  onOpenAllApiLogs,
  onOpenAdmin,
}: TaskSidebarProps) {
  const [pendingDeleteTask, setPendingDeleteTask] = useState<TaskSummary | null>(null);
  const activeWorkflowId = currentWorkflowId ? normalizeTaskWorkflowId(currentWorkflowId) : null;
  const activeWorkflowLabel = activeWorkflowId ? getTaskWorkflowConfig(activeWorkflowId).homeTitle : null;
  const { currentWorkflowTasks, otherWorkflowTasks } = useMemo(() => {
    if (!activeWorkflowId) {
      return { currentWorkflowTasks: tasks, otherWorkflowTasks: [] as TaskSummary[] };
    }
    return {
      currentWorkflowTasks: tasks.filter((taskItem) => normalizeTaskWorkflowId(taskItem.workflowId) === activeWorkflowId),
      otherWorkflowTasks: tasks.filter((taskItem) => normalizeTaskWorkflowId(taskItem.workflowId) !== activeWorkflowId),
    };
  }, [activeWorkflowId, tasks]);

  function renderTaskCard(taskItem: TaskSummary) {
    return (
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
        <button type="button" className="w-full pr-12 text-left" onClick={() => onSelectTask(taskItem.taskId)}>
          <p className="truncate text-sm font-medium leading-tight">{taskItem.name}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-ink/45">
            {getTaskWorkflowConfig(taskItem.workflowId).shortLabel}
          </p>
          {taskItem.projectName ? (
            <div className="mt-1">
              <ProjectBadge name={taskItem.projectName} />
            </div>
          ) : null}
          {taskItem.status === "error" ? <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600">ERROR</p> : null}
        </button>
      </div>
    );
  }

  return (
    <aside className="col-span-12 rounded-2xl border border-ink/10 bg-card p-3 md:col-span-2">
      <button
        type="button"
        aria-label="Go to AIVFX home"
        className="mb-3 block rounded-lg border border-ink/10 bg-white px-3 py-2 transition hover:border-accent/40 hover:bg-accent/5"
        onClick={onGoHome}
      >
        <FivefoldLogo className="h-auto w-40 max-w-full" showProductTag />
      </button>

      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Tasks</h2>
          {isAdmin ? (
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
              Admin
            </span>
          ) : null}
        </div>
        <button type="button" onClick={onSignOut} className="text-xs text-ink/60 underline">
          Sign out
        </button>
      </div>

      <button type="button" className="w-full rounded-md bg-accent px-3 py-1.5 text-xs text-white" onClick={onOpenNewTask}>
        New task
      </button>
      {activeWorkflowLabel ? <p className="mb-3 mt-1 text-[11px] text-ink/55">Create in {activeWorkflowLabel}</p> : <div className="mb-3" />}

      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/45">
              {activeWorkflowLabel ? `${activeWorkflowLabel} tasks` : "Tasks"}
            </p>
            <span className="text-[10px] text-ink/45">{currentWorkflowTasks.length}</span>
          </div>
          <div className="space-y-1.5">
            {currentWorkflowTasks.length ? currentWorkflowTasks.map((taskItem) => renderTaskCard(taskItem)) : <p className="rounded-md border border-dashed border-ink/15 bg-white px-2.5 py-2 text-xs text-ink/55">No tasks in this workflow yet.</p>}
          </div>
        </div>
        {otherWorkflowTasks.length ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/45">Other tasks</p>
              <span className="text-[10px] text-ink/45">{otherWorkflowTasks.length}</span>
            </div>
            <div className="space-y-1.5">
              {otherWorkflowTasks.map((taskItem) => renderTaskCard(taskItem))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="mt-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/45">Workspace</p>
        <div className="space-y-2">
        <button type="button" className="block text-xs text-accent underline" onClick={onOpenAssetLibrary}>
          Open Asset Library
        </button>
        <button type="button" className="block text-xs text-accent underline" onClick={onOpenCustomQc}>
          Custom QC test
        </button>
        <button type="button" className="block text-xs text-accent underline" onClick={onOpenApiLogs}>
          API Logs
        </button>
        {isAdmin ? (
          <>
            <div className="pt-2">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/45">Admin Workspace</p>
              <div className="space-y-2">
                <button type="button" className="block text-xs text-accent underline" onClick={onOpenAllAssetLibrary}>
                  All assets
                </button>
                <button type="button" className="block text-xs text-accent underline" onClick={onOpenAllApiLogs}>
                  All API logs
                </button>
                <button type="button" className="block text-xs text-accent underline" onClick={onOpenAdmin}>
                  Admin
                </button>
              </div>
            </div>
          </>
        ) : null}
        </div>
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

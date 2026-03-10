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
}: TaskSidebarProps) {
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
            <button
              className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-ink/20 bg-white text-[10px] font-semibold text-ink/70"
              title="Open task report"
              aria-label={`Open report for ${taskItem.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenTaskReport(taskItem.taskId);
              }}
            >
              i
            </button>
            <button className="w-full pr-7 text-left" onClick={() => onSelectTask(taskItem.taskId)}>
              <p className="truncate text-sm font-medium leading-tight">{taskItem.name}</p>
              {taskItem.status === "error" ? <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600">ERROR</p> : null}
            </button>
            <button className="mt-0.5 text-[11px] text-red-600 underline" onClick={() => onDeleteTask(taskItem.taskId)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <button className="mt-3 text-xs text-accent underline" onClick={onOpenAssetLibrary}>
        Open Asset Library
      </button>
    </aside>
  );
}

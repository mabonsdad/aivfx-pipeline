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
    <aside className="col-span-12 rounded-2xl border border-ink/10 bg-card p-4 md:col-span-3">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Tasks</h2>
        <button onClick={onSignOut} className="text-sm text-ink/60 underline">
          Sign out
        </button>
      </div>

      <button className="mb-4 w-full rounded-md bg-accent px-3 py-2 text-sm text-white" onClick={onOpenNewTask}>
        Add New Task
      </button>

      <div className="space-y-2">
        {tasks.map((taskItem) => (
          <div
            key={taskItem.taskId}
            className={`relative w-full rounded-lg border px-3 py-2 text-left ${
              selectedTaskId === taskItem.taskId ? "border-accent bg-accent/10" : "border-ink/10 bg-white"
            }`}
          >
            <button
              className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-ink/20 bg-white text-xs font-semibold text-ink/70"
              title="Open task report"
              aria-label={`Open report for ${taskItem.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenTaskReport(taskItem.taskId);
              }}
            >
              i
            </button>
            <button className="w-full pr-8 text-left" onClick={() => onSelectTask(taskItem.taskId)}>
              <p className="font-medium">{taskItem.name}</p>
              <p
                className={`text-xs uppercase tracking-wide ${
                  taskItem.status === "error"
                    ? "text-red-600"
                    : taskItem.status === "ingesting"
                      ? "text-amber-600"
                      : "text-ink/60"
                }`}
              >
                {taskItem.status}
              </p>
            </button>
            <button className="mt-1 text-xs text-red-600 underline" onClick={() => onDeleteTask(taskItem.taskId)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <button className="mt-4 text-sm text-accent underline" onClick={onOpenAssetLibrary}>
        Open Asset Library
      </button>
    </aside>
  );
}

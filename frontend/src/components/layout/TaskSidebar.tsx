import { useState } from "react";
import type { TaskSummary } from "../../types/api";

const APP_HOME_URL = "https://www.shwsh.co.uk/experiments/aivfx/";

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
  onOpenAdmin: () => void;
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
  onOpenAdmin,
}: TaskSidebarProps) {
  const [pendingDeleteTask, setPendingDeleteTask] = useState<TaskSummary | null>(null);

  return (
    <aside className="col-span-12 rounded-2xl border border-ink/10 bg-card p-3 md:col-span-2">
      <a
        href={APP_HOME_URL}
        target="_self"
        aria-label="Go to AIVFX home"
        className="mb-3 block rounded-lg border border-ink/10 bg-white px-3 py-2 transition hover:border-accent/40 hover:bg-accent/5"
      >
        <svg preserveAspectRatio="xMidYMid meet" viewBox="0 0 1823.729 893.546" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Fivefold Studios logo" className="h-auto w-40 max-w-full">
          <g fill="#b85618">
            <path d="M644.215 386.267v6.765h56.255v30.195h-56.255v151.422H608.72V423.227h-19.186l-3.712-30.195h22.898v-5.705c0-42.356 33.85-76.813 75.45-76.813h20.003l-3.703 31.787h-11.594c-31.027 0-44.661 21.187-44.661 43.966" />
            <path d="M743.086 355.936a24.72 24.72 0 1 1 32.293-13.375 24.72 24.72 0 0 1-32.293 13.375m-8.304 37.096h35.495v181.617h-35.495Z" />
            <path d="m981.733 393.032-70.304 181.617h-39.128l-70.303-181.617h39.084l50.783 139.415 50.784-139.415Z" />
            <path d="m1142.651 518.32 27.657 18.6c-16.634 25.19-44.793 41.75-76.734 41.75-51.118-.005-92.55-42.41-92.55-94.728s40.905-94.732 92.022-94.732c51.11 0 90.959 42.413 90.959 94.732 0 5.533-.484 10.996-1.346 14.04h-143.985c6.791 26.952 27.938 46.252 55.428 46.252 31.017 0 48.55-25.915 48.55-25.915m4.231-48.418c-2.938-24.186-25.273-46.257-53.308-46.257-28.897 0-50.475 19.665-54.9 46.257Z" />
            <path d="M1265.744 386.267v6.765h56.255v30.195h-56.255v151.422h-35.495V423.227h-19.186l-3.712-30.195h22.898v-5.705c0-42.356 33.85-76.813 75.45-76.813h20.003L1322 342.301h-11.594c-31.026 0-44.661 21.187-44.661 43.966" />
            <path d="M1522.16 483.942c0 52.318-41.442 94.732-92.55 94.732-51.119 0-92.551-42.414-92.551-94.732s41.432-94.732 92.55-94.732 92.55 42.413 92.55 94.732m-35.495 0c0-32.667-25.599-59.233-57.056-59.233s-57.055 26.566-57.055 59.233c0 32.662 25.598 59.237 57.055 59.237s57.056-26.575 57.056-59.237" />
            <path d="M1597.926 297.799v276.85h-35.495V291.443Z" />
            <path d="M1823.729 297.799v276.85h-35.495v-28.37c-15.64 19.85-38.635 32.39-64.26 32.39-47.133 0-85.337-42.409-85.337-94.727s38.204-94.732 85.337-94.732c25.625 0 48.62 12.54 64.26 32.39V291.442Zm-35.495 186.143c0-32.663-25.59-59.237-57.055-59.237-31.458 0-57.047 26.574-57.047 59.237 0 32.666 25.59 59.232 57.047 59.232 31.465 0 57.055-26.566 57.055-59.232" />
            <path d="M665.481 633.912a186.96 186.96 0 0 1-182.494-184.201c-.015-.979-.037-1.955-.037-2.938 0-.982.022-1.958.037-2.937a187.38 187.38 0 0 1 108.69-167.064 186.3 186.3 0 0 1 72.935-17.114 3.12 3.12 0 0 0 3.015-2.634 225 225 0 0 0 2.533-33.637C670.16 100.014 570.146 0 446.773 0S223.387 100.014 223.387 223.387C100.014 223.387 0 323.4 0 446.773S100.014 670.16 223.387 670.16c0 123.373 100.013 223.386 223.386 223.386S670.16 793.533 670.16 670.16a225 225 0 0 0-2.664-34.497 2.08 2.08 0 0 0-2.015-1.751m-140.225-17.137a187.57 187.57 0 0 1-156.966 0 223.1 223.1 0 0 0 75.546-133.788c.978-.016 1.955-.038 2.937-.038s1.96.022 2.938.038a223.1 223.1 0 0 0 75.545 133.788m-248.483-25.098a225 225 0 0 0 25.097 25.097 185.8 185.8 0 0 1-37.877 12.78 185.8 185.8 0 0 1 12.78-37.877m-17.21-144.904a186.5 186.5 0 0 1 17.21-78.483 223.1 223.1 0 0 0 133.787 75.546c.015.979.037 1.955.037 2.937s-.022 1.96-.037 2.938a223.08 223.08 0 0 0-133.787 75.545 186.5 186.5 0 0 1-17.21-78.483m4.43-182.78a185.8 185.8 0 0 1 37.877 12.78 225 225 0 0 0-25.097 25.097 185.8 185.8 0 0 1-12.78-37.877m142.175 142.175a187.3 187.3 0 0 1-109.645-71.088 188.3 188.3 0 0 1 38.557-38.557 187.3 187.3 0 0 1 71.088 109.645M296.523 558.467a187.28 187.28 0 0 1 109.644-71.088 187.3 187.3 0 0 1-71.087 109.645 188.3 188.3 0 0 1-38.557-38.557M449.711 410.56c-.979.015-1.956.037-2.938.037s-1.959-.022-2.937-.037a223.1 223.1 0 0 0-75.546-133.788 187.57 187.57 0 0 1 156.966 0 223.1 223.1 0 0 0-75.545 133.788M259.563 223.387c0-103.393 83.817-187.21 187.21-187.21s187.21 83.817 187.21 187.21c0 .982-.021 1.959-.036 2.937a221.9 221.9 0 0 0-75.48 26.955 223.62 223.62 0 0 0-223.387 0 221.9 221.9 0 0 0-75.48-26.955c-.015-.978-.037-1.955-.037-2.937m-36.176 410.597c-103.394 0-187.21-83.817-187.21-187.21s83.816-187.211 187.21-187.211c.982 0 1.959.022 2.937.037a221.9 221.9 0 0 0 26.955 75.48 223.62 223.62 0 0 0 0 223.387 221.9 221.9 0 0 0-26.955 75.48c-.978.015-1.955.037-2.937.037m410.597 36.176c0 103.393-83.817 187.21-187.21 187.21s-187.211-83.817-187.211-187.21c0-.982.022-1.96.037-2.938a221.9 221.9 0 0 0 75.48-26.954 223.62 223.62 0 0 0 223.387 0 221.9 221.9 0 0 0 75.48 26.955c.015.978.037 1.955.037 2.937" />
          </g>
        </svg>
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/70">AIVFX</p>
      </a>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Videos</h2>
        <button type="button" onClick={onSignOut} className="text-xs text-ink/60 underline">
          Sign out
        </button>
      </div>

      <button type="button" className="mb-3 w-full rounded-md bg-accent px-3 py-1.5 text-xs text-white" onClick={onOpenNewTask}>
        Upload New Video
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
                title="Open video report"
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
                title="Delete video"
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
              {taskItem.status === "error" ? <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600">ERROR</p> : null}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        <button type="button" className="block text-xs text-accent underline" onClick={onOpenAssetLibrary}>
          Open Asset Library
        </button>
        <button type="button" className="block text-xs text-accent underline" onClick={onOpenCustomQc}>
          Custom QC test
        </button>
        <button type="button" className="block text-xs text-accent underline" onClick={onOpenApiLogs}>
          API Logs
        </button>
        <button type="button" className="block text-xs text-accent underline" onClick={onOpenAdmin}>
          Admin
        </button>
      </div>

      {pendingDeleteTask ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-ink/15 bg-white p-4 shadow-xl">
            <p className="text-sm font-medium text-ink">Are you sure you want to delete this video?</p>
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

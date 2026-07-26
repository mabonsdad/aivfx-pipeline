import type { ChangeEvent } from "react";
import { StatusNotice } from "../layout/UiFeedback";
import { isPrevizWorkflowId, type TaskWorkflowId } from "../../lib/taskWorkflows";

type NewTaskStage = "idle" | "creating" | "error";

type NewTaskModalProps = {
  isOpen: boolean;
  stage: NewTaskStage;
  taskName: string;
  workflowId: TaskWorkflowId;
  normalizedTaskName: string;
  showTaskNameExistsWarning: boolean;
  description: string;
  error: string | null;
  onClose: () => void;
  onTaskNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: () => void;
};

export default function NewTaskModal({
  isOpen,
  stage,
  taskName,
  workflowId,
  normalizedTaskName,
  showTaskNameExistsWarning,
  description,
  error,
  onClose,
  onTaskNameChange,
  onDescriptionChange,
  onSubmit,
}: NewTaskModalProps) {
  if (!isOpen) return null;

  const isBusy = stage === "creating";
  const isPrevizWorkflow = isPrevizWorkflowId(workflowId);
  const title = isPrevizWorkflow ? "Create New Previz Scene" : "Create New Task";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-ink/10 bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            type="button"
            className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onClose}
            disabled={isBusy}
          >
            Close
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">{isPrevizWorkflow ? "Scene name" : "Task name"}</label>
            <input
              value={taskName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onTaskNameChange(event.target.value)}
              maxLength={15}
              className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
              disabled={isBusy}
            />
            <p className="mt-1 text-xs text-ink/60">
              Final name: <span className="font-medium">{normalizedTaskName || "(invalid)"}</span> (max 15 chars)
            </p>
            {showTaskNameExistsWarning ? (
              <div className="mt-2">
                <StatusNotice variant="warning">
                  <p className="text-xs">Name already used by another task.</p>
                </StatusNotice>
              </div>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{isPrevizWorkflow ? "Scene description" : "Task description"}</label>
            <textarea
              value={description}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onDescriptionChange(event.target.value)}
              className="h-32 w-full rounded-md border border-ink/20 bg-white p-3 text-sm"
              placeholder={
                isPrevizWorkflow
                  ? "Describe the scene, mood, setting, characters, and action you want to develop in Previz."
                  : "Describe the intended task, creative goal, or edit you want to make."
              }
              disabled={isBusy}
            />
          </div>
          {error ? (
            <StatusNotice variant="error">
              <p className="text-sm">{error}</p>
            </StatusNotice>
          ) : null}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={onClose} disabled={isBusy}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isBusy || !taskName.trim() || !description.trim()}
              onClick={onSubmit}
            >
              {stage === "creating" ? "Creating..." : isPrevizWorkflow ? "Create scene task" : "Create task"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

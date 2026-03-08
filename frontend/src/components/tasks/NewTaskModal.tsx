import type { ChangeEvent } from "react";

type NewTaskStage = "idle" | "creating" | "uploading" | "ingesting" | "error";

type NewTaskModalProps = {
  isOpen: boolean;
  stage: NewTaskStage;
  taskName: string;
  normalizedTaskName: string;
  showTaskNameExistsWarning: boolean;
  taskNameAlreadyExists: boolean;
  uploadPercent: number;
  ingestProgress: number;
  ingestStatus: string;
  error: string | null;
  canSubmit: boolean;
  onClose: () => void;
  onTaskNameChange: (value: string) => void;
  onFileSelect: (file: File | null) => void;
  onSubmit: () => void;
};

export default function NewTaskModal({
  isOpen,
  stage,
  taskName,
  normalizedTaskName,
  showTaskNameExistsWarning,
  taskNameAlreadyExists,
  uploadPercent,
  ingestProgress,
  ingestStatus,
  error,
  canSubmit,
  onClose,
  onTaskNameChange,
  onFileSelect,
  onSubmit,
}: NewTaskModalProps) {
  if (!isOpen) return null;

  const isBusy = stage === "creating" || stage === "uploading" || stage === "ingesting";

  const submitLabel =
    stage === "creating"
      ? "Creating task..."
      : stage === "uploading"
        ? "Uploading..."
        : stage === "ingesting"
          ? "Ingesting..."
          : "Create Task and Ingest";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-ink/10 bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Create Task & Upload Video</h3>
          <button
            className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onClose}
            disabled={isBusy}
          >
            Close
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Task name</label>
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
            {showTaskNameExistsWarning ? <p className="text-xs text-red-600">Name already used by another task.</p> : null}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Video file</label>
            <input
              type="file"
              accept="video/*"
              onChange={(event: ChangeEvent<HTMLInputElement>) => onFileSelect(event.target.files?.[0] ?? null)}
              disabled={isBusy}
            />
          </div>
          {stage === "uploading" ? (
            <div>
              <p className="mb-1 text-sm text-ink/70">Uploading: {uploadPercent}%</p>
              <div className="h-2 w-full overflow-hidden rounded bg-ink/10">
                <div className="h-full bg-accent" style={{ width: `${uploadPercent}%` }} />
              </div>
            </div>
          ) : null}
          {stage === "ingesting" ? (
            <div>
              <p className="mb-1 text-sm text-ink/70">
                Ingesting: {ingestProgress}% ({ingestStatus})
              </p>
              <div className="h-2 w-full overflow-hidden rounded bg-ink/10">
                <div className="h-full bg-accent2" style={{ width: `${ingestProgress}%` }} />
              </div>
            </div>
          ) : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button
            className="w-full rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmit || taskNameAlreadyExists || isBusy}
            onClick={onSubmit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

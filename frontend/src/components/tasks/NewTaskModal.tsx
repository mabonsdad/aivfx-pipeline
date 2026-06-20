import type { ChangeEvent } from "react";
import { PendingButtonLabel, StatusNotice } from "../layout/UiFeedback";
import {
  getFixedCharacterAnimateModeForWorkflow,
  isCharacterAnimateWorkflowId,
  isPrevizWorkflowId,
  type TaskWorkflowId,
} from "../../lib/taskWorkflows";

type NewTaskStage = "idle" | "creating" | "uploading" | "ingesting" | "error";

type NewTaskModalProps = {
  isOpen: boolean;
  stage: NewTaskStage;
  taskName: string;
  workflowId: TaskWorkflowId;
  normalizedTaskName: string;
  showTaskNameExistsWarning: boolean;
  taskNameAlreadyExists: boolean;
  scenePrompt: string;
  uploadPercent: number;
  ingestProgress: number;
  ingestStatus: string;
  error: string | null;
  canSubmit: boolean;
  automationEnabled: boolean;
  automationStartPrompt: string;
  automationEndPrompt: string;
  automationVideoPrompt: string;
  automationVideoOptions: Array<{ id: string; label: string }>;
  automationSelectedVideoOptionIds: string[];
  onClose: () => void;
  onTaskNameChange: (value: string) => void;
  onScenePromptChange: (value: string) => void;
  onFileSelect: (file: File | null) => void;
  onAutomationEnabledChange: (value: boolean) => void;
  onAutomationStartPromptChange: (value: string) => void;
  onAutomationEndPromptChange: (value: string) => void;
  onAutomationVideoPromptChange: (value: string) => void;
  onAutomationVideoSelectionChange: (selectedIds: string[]) => void;
  onSubmit: () => void;
};

export default function NewTaskModal({
  isOpen,
  stage,
  taskName,
  workflowId,
  normalizedTaskName,
  showTaskNameExistsWarning,
  taskNameAlreadyExists,
  scenePrompt,
  uploadPercent,
  ingestProgress,
  ingestStatus,
  error,
  canSubmit,
  automationEnabled,
  automationStartPrompt,
  automationEndPrompt,
  automationVideoPrompt,
  automationVideoOptions,
  automationSelectedVideoOptionIds,
  onClose,
  onTaskNameChange,
  onScenePromptChange,
  onFileSelect,
  onAutomationEnabledChange,
  onAutomationStartPromptChange,
  onAutomationEndPromptChange,
  onAutomationVideoPromptChange,
  onAutomationVideoSelectionChange,
  onSubmit,
}: NewTaskModalProps) {
  if (!isOpen) return null;

  const isBusy = stage === "creating" || stage === "uploading" || stage === "ingesting";
  const isPrevizWorkflow = isPrevizWorkflowId(workflowId);
  const fixedCharacterMode = getFixedCharacterAnimateModeForWorkflow(workflowId);
  const isCharacterWorkflow = isCharacterAnimateWorkflowId(workflowId);

  const submitLabel =
    stage === "creating"
      ? isPrevizWorkflow
        ? "Creating scene task..."
        : "Creating video..."
      : stage === "uploading"
        ? "Uploading..."
        : stage === "ingesting"
          ? "Ingesting..."
          : isPrevizWorkflow
            ? "Create scene task"
            : "Upload Video";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-ink/10 bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            {isPrevizWorkflow
              ? "Create New Previz Scene"
              : fixedCharacterMode === "audio_driven"
                ? "Upload Source Audio"
                : isCharacterWorkflow
                  ? "Upload Source Video"
                  : "Upload New Video"}
          </h3>
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
            <label className="mb-1 block text-sm font-medium">
              {isPrevizWorkflow ? "Scene name" : "Video name"}
            </label>
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
                  <p className="text-xs">Name already used by another uploaded video.</p>
                </StatusNotice>
              </div>
            ) : null}
          </div>
          {isPrevizWorkflow ? (
            <div>
              <label className="mb-1 block text-sm font-medium">Scene description</label>
              <textarea
                value={scenePrompt}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onScenePromptChange(event.target.value)}
                className="h-32 w-full rounded-md border border-ink/20 bg-white p-3 text-sm"
                placeholder="Describe the scene, mood, setting, characters, and action you want to develop in Previz."
                disabled={isBusy}
              />
              <p className="mt-1 text-xs text-ink/60">
                This scene description is stored with the task and will seed the later Previz steps.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  {fixedCharacterMode === "audio_driven" ? "Audio file" : isCharacterWorkflow ? "Source video file" : "Video file"}
                </label>
                <input
                  type="file"
                  accept={fixedCharacterMode === "audio_driven" ? "audio/*" : "video/*"}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => onFileSelect(event.target.files?.[0] ?? null)}
                  disabled={isBusy}
                />
                {isCharacterWorkflow ? (
                  <p className="mt-1 text-xs text-ink/60">
                    {fixedCharacterMode === "audio_driven"
                      ? "This workflow expects an audio upload to drive lip sync and motion."
                      : "This workflow expects a driving video upload."}
                  </p>
                ) : null}
              </div>
              <details className="rounded-md border border-ink/15 bg-bg px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-ink">Automation Test (optional)</summary>
                <div className="mt-3 space-y-3">
                  <label className="flex items-start gap-2 text-xs text-ink/70">
                    <input
                      type="checkbox"
                      checked={automationEnabled}
                      onChange={(event) => onAutomationEnabledChange(event.target.checked)}
                      disabled={isBusy}
                    />
                    <span>
                      Run automated test - clip must be 5-10 sec. This will generate multiple videos without oversight - only use for
                      testing!
                    </span>
                  </label>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink/80">Start frame edit prompt</label>
                    <textarea
                      value={automationStartPrompt}
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onAutomationStartPromptChange(event.target.value)}
                      className="h-20 w-full rounded-md border border-ink/20 bg-white p-2 text-sm"
                      placeholder="Prompt used for automated start-frame edits (all image models)"
                      disabled={isBusy}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink/80">End frame edit prompt (optional)</label>
                    <textarea
                      value={automationEndPrompt}
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onAutomationEndPromptChange(event.target.value)}
                      className="h-16 w-full rounded-md border border-ink/20 bg-white p-2 text-sm"
                      placeholder="If set, automation also edits end frame across all image models"
                      disabled={isBusy}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink/80">Video prompt</label>
                    <textarea
                      value={automationVideoPrompt}
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onAutomationVideoPromptChange(event.target.value)}
                      className="h-16 w-full rounded-md border border-ink/20 bg-white p-2 text-sm"
                      placeholder="Prompt used for automated video generation runs"
                      disabled={isBusy}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink/80">Video models to run (multi-select)</label>
                    <select
                      multiple
                      value={automationSelectedVideoOptionIds}
                      onChange={(event) => {
                        const selectedIds = Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
                        onAutomationVideoSelectionChange(selectedIds);
                      }}
                      className="h-36 w-full rounded-md border border-ink/20 bg-white p-2 text-sm"
                      disabled={isBusy}
                    >
                      {automationVideoOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </details>
            </>
          )}
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
          {error ? (
            <StatusNotice variant="error">
              <p>{error}</p>
            </StatusNotice>
          ) : null}
          <button
            type="button"
            className="w-full rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmit || taskNameAlreadyExists || isBusy}
            onClick={onSubmit}
          >
            <PendingButtonLabel
              isPending={isBusy}
              idle={
                isPrevizWorkflow
                  ? "Create Scene Task"
                  : isCharacterWorkflow
                    ? fixedCharacterMode === "audio_driven"
                      ? "Upload Source Audio"
                      : "Upload Source Video"
                    : "Upload Video"
              }
              pending={submitLabel}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

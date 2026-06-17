import { useEffect, useState } from "react";

import type { ProjectSummary } from "../../types/api";

type TaskProjectAssignmentCardProps = {
  projects: ProjectSummary[];
  currentProjectId: string | null;
  isSaving: boolean;
  onAssignProject: (projectId: string | null) => Promise<void> | void;
};

export default function TaskProjectAssignmentCard({
  projects,
  currentProjectId,
  isSaving,
  onAssignProject,
}: TaskProjectAssignmentCardProps) {
  const [selectedProjectId, setSelectedProjectId] = useState(currentProjectId ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedProjectId(currentProjectId ?? "");
    setError(null);
  }, [currentProjectId]);

  return (
    <div className="rounded-xl border border-ink/15 bg-white p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-ink">Add to project</p>
          <p className="text-sm text-ink/70">Assign this task to a shared project. This will share assets with other users in that project.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedProjectId}
            disabled={isSaving}
            onChange={(event) => setSelectedProjectId(event.target.value)}
            className="rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">None</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSaving || selectedProjectId === (currentProjectId ?? "")}
            onClick={() => {
              setError(null);
              void Promise.resolve(onAssignProject(selectedProjectId || null)).catch((nextError) => {
                setError(nextError instanceof Error ? nextError.message : "Failed to update task project");
              });
            }}
          >
            {isSaving ? "Saving..." : "Set"}
          </button>
        </div>
      </div>
      {error ? <p className="mt-3 text-xs text-red-700">{error}</p> : null}
      {!projects.length ? <p className="mt-3 text-xs text-ink/55">No shared projects are available for this account yet.</p> : null}
    </div>
  );
}

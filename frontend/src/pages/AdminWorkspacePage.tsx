import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import { StatusNotice } from "../components/layout/UiFeedback";
import AdminPricingConfigPanel from "../components/admin/AdminPricingConfigPanel";
import AdminPromptWizardPage from "./AdminPromptWizardPage";

function summarizeToolCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  if (!entries.length) return "None yet";
  return entries
    .slice(0, 4)
    .map(([tool, count]) => `${tool} (${count})`)
    .join(", ");
}

export default function AdminWorkspacePage() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftMemberUserIds, setDraftMemberUserIds] = useState<string[]>([]);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => apiClient.listAdminUsers(),
    refetchOnWindowFocus: false,
  });
  const projectsQuery = useQuery({
    queryKey: ["admin", "projects"],
    queryFn: () => apiClient.listAdminProjects(),
    refetchOnWindowFocus: false,
  });

  const projects = useMemo(
    () => projectsQuery.data?.projects ?? usersQuery.data?.projects ?? [],
    [projectsQuery.data?.projects, usersQuery.data?.projects],
  );
  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data?.users]);
  const isCreatingProject = selectedProjectId == null;
  const selectedProject = useMemo(
    () => projects.find((project) => project.projectId === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  useEffect(() => {
    if (!selectedProject) {
      setDraftName("");
      setDraftDescription("");
      setDraftMemberUserIds([]);
      return;
    }
    setDraftName(selectedProject.name);
    setDraftDescription(selectedProject.description ?? "");
    setDraftMemberUserIds(selectedProject.memberUserIds);
  }, [selectedProject]);

  const saveProjectMutation = useMutation({
    mutationFn: async () => {
      if (!draftName.trim()) throw new Error("Project name is required");
      if (!draftMemberUserIds.length) throw new Error("Select at least one project member");
      const payload = {
        name: draftName.trim(),
        description: draftDescription.trim() || null,
        memberUserIds: draftMemberUserIds,
      };
      if (selectedProjectId) {
        return apiClient.updateAdminProject(selectedProjectId, payload);
      }
      return apiClient.createAdminProject(payload);
    },
    onSuccess: async (result) => {
      const nextProject = result.project;
      setSelectedProjectId(nextProject.projectId);
      setSaveMessage(`Saved project ${nextProject.name}.`);
      await queryClient.invalidateQueries({ queryKey: ["admin", "projects"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const selectableUsers = useMemo(
    () =>
      users.filter((user) => user.userId).map((user) => ({
        userId: String(user.userId),
        label: user.email || user.username || String(user.userId),
        subtitle: `${user.taskCount} task${user.taskCount === 1 ? "" : "s"} · ${user.projectIds.length} project${user.projectIds.length === 1 ? "" : "s"}`,
      })),
    [users],
  );

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-ink/10 bg-white p-4">
        <h2 className="text-base font-semibold">Admin Workspace</h2>
        <p className="mt-1 text-sm text-ink/65">
          Manage project sharing, review user activity, and maintain prompt and pricing configuration.
        </p>
      </div>

      {saveMessage ? (
        <StatusNotice variant="success">
          <p>{saveMessage}</p>
        </StatusNotice>
      ) : null}

      {projectsQuery.error ? (
        <StatusNotice variant="error">
          <p>Could not load projects: {projectsQuery.error.message}</p>
        </StatusNotice>
      ) : null}

      {usersQuery.error ? (
        <StatusNotice variant="error">
          <p>Could not load users: {usersQuery.error.message}</p>
        </StatusNotice>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="rounded-xl border border-ink/10 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Projects</h3>
            {!isCreatingProject ? (
              <button
                type="button"
                className="rounded border border-ink/20 bg-white px-3 py-1.5 text-xs"
                onClick={() => {
                  setSelectedProjectId(null);
                  setDraftName("");
                  setDraftDescription("");
                  setDraftMemberUserIds([]);
                  setSaveMessage(null);
                }}
              >
                New project
              </button>
            ) : null}
          </div>
          <div className="mt-3 space-y-2">
            {projectsQuery.isLoading ? <p className="text-sm text-ink/60">Loading projects...</p> : null}
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                className={`w-full rounded-lg border px-3 py-2 text-left ${selectedProjectId === project.projectId ? "border-accent bg-accent/5" : "border-ink/10 bg-bg"}`}
                onClick={() => {
                  setSelectedProjectId(project.projectId);
                  setSaveMessage(null);
                }}
              >
                <p className="text-sm font-medium text-ink">{project.name}</p>
                <p className="text-xs text-ink/60">{project.memberCount} member{project.memberCount === 1 ? "" : "s"}</p>
              </button>
            ))}
            {!projects.length && !projectsQuery.isLoading ? <p className="text-sm text-ink/60">No projects yet.</p> : null}
          </div>
        </div>

        <div className="rounded-xl border border-ink/10 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{selectedProjectId ? "Edit project" : "Create project"}</h3>
            {isCreatingProject ? <p className="text-xs text-ink/55">Fill in the form below to create a project.</p> : null}
            {saveProjectMutation.error ? <p className="text-xs text-red-700">{saveProjectMutation.error.message}</p> : null}
          </div>
          <div className="mt-4 grid gap-4">
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink/70">Name</span>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} className="w-full rounded border border-ink/20 px-3 py-2 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink/70">Description</span>
              <textarea value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} className="h-24 w-full rounded border border-ink/20 px-3 py-2 text-sm" />
            </label>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/70">Members</p>
              {!usersQuery.isLoading && !selectableUsers.length ? (
                <p className="text-sm text-ink/60">No users available yet.</p>
              ) : null}
              <div className="grid gap-2 md:grid-cols-2">
                {selectableUsers.map((user) => {
                  const checked = draftMemberUserIds.includes(user.userId);
                  return (
                    <label key={user.userId} className={`flex items-start gap-3 rounded-lg border p-3 ${checked ? "border-accent bg-accent/5" : "border-ink/10 bg-bg"}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setDraftMemberUserIds((previous) =>
                            previous.includes(user.userId) ? previous.filter((value) => value !== user.userId) : [...previous, user.userId],
                          )
                        }
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium text-ink">{user.label}</span>
                        <span className="block text-xs text-ink/60">{user.subtitle}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={saveProjectMutation.isPending || !selectableUsers.length}
                onClick={() => {
                  setSaveMessage(null);
                  void saveProjectMutation.mutateAsync();
                }}
              >
                {saveProjectMutation.isPending ? "Saving..." : selectedProjectId ? "Save project" : "Create project"}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-ink/10 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Users</h3>
          <p className="text-xs text-ink/60">Task counts and generation volume across shared storage.</p>
        </div>
        {usersQuery.isLoading ? <p className="mt-3 text-sm text-ink/60">Loading users...</p> : null}
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-ink/10 text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink/55">
                <th className="pb-2 pr-4 font-semibold">User</th>
                <th className="pb-2 pr-4 font-semibold">Tasks</th>
                <th className="pb-2 pr-4 font-semibold">Projects</th>
                <th className="pb-2 pr-4 font-semibold">Image gens</th>
                <th className="pb-2 pr-4 font-semibold">Video gens</th>
                <th className="pb-2 font-semibold">Tool mix</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {users.map((user) => (
                <tr key={`${user.userId ?? user.username ?? user.email}`} className="align-top">
                  <td className="py-3 pr-4">
                    <p className="font-medium text-ink">{user.email || user.username || user.userId}</p>
                    <p className="text-xs text-ink/55">{user.groups.join(", ") || user.status || "No groups"}</p>
                  </td>
                  <td className="py-3 pr-4 text-ink/75">{user.taskCount}</td>
                  <td className="py-3 pr-4 text-ink/75">{user.projectIds.length}</td>
                  <td className="py-3 pr-4 text-ink/75">{user.imageGenerationsTotal}</td>
                  <td className="py-3 pr-4 text-ink/75">{user.videoGenerationsTotal}</td>
                  <td className="py-3 text-xs text-ink/65">
                    <p>Images: {summarizeToolCounts(user.imageGenerationsByTool)}</p>
                    <p className="mt-1">Videos: {summarizeToolCounts(user.videoGenerationsByTool)}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="rounded-xl border border-ink/10 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink">Pricing Config</summary>
        <div className="mt-4">
          <AdminPricingConfigPanel />
        </div>
      </details>

      <details className="rounded-xl border border-ink/10 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink">Prompt Wizard Config</summary>
        <div className="mt-4">
          <AdminPromptWizardPage />
        </div>
      </details>
    </div>
  );
}

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

function formatUsd(value: number | null | undefined): string {
  const amount = Number.isFinite(value) ? Number(value) : 0;
  return `$${amount.toFixed(2)}`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function usageSummaryLine(usage: Record<string, unknown>): string {
  const entries = Object.entries(usage || {});
  if (!entries.length) return "No usage details";
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

export default function AdminWorkspacePage() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftMemberUserIds, setDraftMemberUserIds] = useState<string[]>([]);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [userProjectFilter, setUserProjectFilter] = useState("all");
  const [visibleUsersCount, setVisibleUsersCount] = useState(12);
  const [usageUserFilter, setUsageUserFilter] = useState("all");
  const [usageProjectFilter, setUsageProjectFilter] = useState("all");
  const [usageTypeFilter, setUsageTypeFilter] = useState("all");
  const [usageStatusFilter, setUsageStatusFilter] = useState("all");
  const [usageExcludeFailed, setUsageExcludeFailed] = useState(true);
  const [usageLimit, setUsageLimit] = useState(24);

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
  const usageSummaryQuery = useQuery({
    queryKey: ["admin", "usage-summary"],
    queryFn: () => apiClient.getAdminUsageSummary(),
    refetchOnWindowFocus: false,
  });
  const usageLogsQuery = useQuery({
    queryKey: [
      "admin",
      "usage-logs",
      usageLimit,
      usageUserFilter,
      usageProjectFilter,
      usageTypeFilter,
      usageStatusFilter,
      usageExcludeFailed,
    ],
    queryFn: () =>
      apiClient.getAdminUsageLogs({
        limit: usageLimit,
        userId: usageUserFilter !== "all" ? usageUserFilter : null,
        projectId: usageProjectFilter !== "all" ? usageProjectFilter : null,
        requestType: usageTypeFilter !== "all" ? usageTypeFilter : null,
        status: usageStatusFilter !== "all" ? usageStatusFilter : null,
        excludeFailed: usageExcludeFailed,
      }),
    refetchOnWindowFocus: false,
  });

  const projects = useMemo(
    () => projectsQuery.data?.projects ?? usersQuery.data?.projects ?? [],
    [projectsQuery.data?.projects, usersQuery.data?.projects],
  );
  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data?.users]);
  const usageTotals = usageSummaryQuery.data?.totals;
  const usageLogs = useMemo(() => usageLogsQuery.data?.records ?? [], [usageLogsQuery.data?.records]);
  const isCreatingProject = selectedProjectId == null;
  const selectedProject = useMemo(
    () => projects.find((project) => project.projectId === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.projectId, project])), [projects]);
  const usersById = useMemo(() => new Map(users.map((user) => [String(user.userId || ""), user])), [users]);

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

  useEffect(() => {
    setVisibleUsersCount(12);
  }, [userSearch, userProjectFilter]);

  useEffect(() => {
    setUsageLimit(24);
  }, [usageUserFilter, usageProjectFilter, usageTypeFilter, usageStatusFilter, usageExcludeFailed]);

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

  const filteredUsers = useMemo(() => {
    const search = userSearch.trim().toLowerCase();
    return users.filter((user) => {
      if (userProjectFilter !== "all" && !user.projectIds.includes(userProjectFilter)) return false;
      if (!search) return true;
      const haystacks = [user.email, user.username, user.userId]
        .map((value) => String(value || "").toLowerCase())
        .filter(Boolean);
      return haystacks.some((value) => value.includes(search));
    });
  }, [userProjectFilter, userSearch, users]);
  const visibleUsers = filteredUsers.slice(0, visibleUsersCount);

  const usageTypeOptions = useMemo(() => {
    const values = new Set<string>();
    for (const record of usageLogs) {
      const value = String(record.requestType || "").trim();
      if (value) values.add(value);
    }
    return Array.from(values).sort();
  }, [usageLogs]);

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

      {usageSummaryQuery.error ? (
        <StatusNotice variant="error">
          <p>Could not load usage summary: {usageSummaryQuery.error.message}</p>
        </StatusNotice>
      ) : null}

      {usageLogsQuery.error ? (
        <StatusNotice variant="error">
          <p>Could not load usage logs: {usageLogsQuery.error.message}</p>
        </StatusNotice>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="rounded-xl border border-ink/10 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Projects</h3>
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Users</h3>
            <p className="text-xs text-ink/60">Task counts, project access, and usage rollups.</p>
          </div>
          <p className="text-xs text-ink/55">
            Showing {visibleUsers.length} of {filteredUsers.length}
          </p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px] xl:grid-cols-[minmax(0,1fr)_220px_220px]">
          <input
            value={userSearch}
            onChange={(event) => setUserSearch(event.target.value)}
            placeholder="Filter by email, username or user ID"
            className="rounded border border-ink/20 px-3 py-2 text-sm"
          />
          <select value={userProjectFilter} onChange={(event) => setUserProjectFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        {usersQuery.isLoading ? <p className="mt-3 text-sm text-ink/60">Loading users...</p> : null}
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {visibleUsers.map((user) => (
            <article key={`${user.userId ?? user.username ?? user.email}`} className="rounded-lg border border-ink/10 bg-bg px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">{user.email || user.username || user.userId}</p>
                  <p className="text-xs text-ink/55">{user.groups.join(", ") || user.status || "No groups"}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-ink/55">Est. cost</p>
                  <p className="text-sm font-semibold text-ink">{formatUsd(user.estimatedCostUsd)}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-ink/70">
                <div className="rounded border border-ink/10 bg-white px-2 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-ink/50">Tasks</p>
                  <p className="mt-1 text-sm font-medium text-ink">{user.taskCount}</p>
                </div>
                <div className="rounded border border-ink/10 bg-white px-2 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-ink/50">Projects</p>
                  <p className="mt-1 text-sm font-medium text-ink">{user.projectIds.length}</p>
                </div>
                <div className="rounded border border-ink/10 bg-white px-2 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-ink/50">Images</p>
                  <p className="mt-1 text-sm font-medium text-ink">{user.imageGenerationsTotal}</p>
                </div>
                <div className="rounded border border-ink/10 bg-white px-2 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-ink/50">Videos</p>
                  <p className="mt-1 text-sm font-medium text-ink">{user.videoGenerationsTotal}</p>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-xs text-ink/65">
                <p>Images: {summarizeToolCounts(user.imageGenerationsByTool)}</p>
                <p>Videos: {summarizeToolCounts(user.videoGenerationsByTool)}</p>
                {user.recentUsageAt ? <p>Recent usage: {formatTimestamp(user.recentUsageAt)}</p> : null}
              </div>
            </article>
          ))}
        </div>
        {!filteredUsers.length && !usersQuery.isLoading ? <p className="mt-4 text-sm text-ink/60">No users match the current filter.</p> : null}
        {visibleUsersCount < filteredUsers.length ? (
          <div className="mt-4 flex justify-center">
            <button type="button" className="text-sm text-accent underline" onClick={() => setVisibleUsersCount((count) => count + 12)}>
              More...
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-ink/10 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Usage Summary</h3>
          <p className="text-xs text-ink/60">Estimated from the central pricing registry and recorded usage rows.</p>
        </div>
        {usageSummaryQuery.isLoading ? <p className="mt-3 text-sm text-ink/60">Loading usage summary...</p> : null}
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-ink/10 bg-bg px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-ink/55">Usage records</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{usageTotals?.usageRecordsTotal ?? 0}</p>
          </div>
          <div className="rounded-lg border border-ink/10 bg-bg px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-ink/55">Prompt rewrites</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{usageTotals?.promptRewriteTotal ?? 0}</p>
          </div>
          <div className="rounded-lg border border-ink/10 bg-bg px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-ink/55">Estimated cost</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{formatUsd(usageTotals?.estimatedCostUsd)}</p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-ink/10 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Recent Usage</h3>
            <p className="text-xs text-ink/60">Latest prompt rewrites and generation estimates recorded by the backend.</p>
          </div>
          <p className="text-xs text-ink/55">
            {usageLogsQuery.data?.total ?? 0} matching records
          </p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <select value={usageUserFilter} onChange={(event) => setUsageUserFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
            <option value="all">All users</option>
            {users.map((user) => (
              <option key={String(user.userId)} value={String(user.userId)}>
                {user.email || user.username || user.userId}
              </option>
            ))}
          </select>
          <select value={usageProjectFilter} onChange={(event) => setUsageProjectFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </select>
          <select value={usageTypeFilter} onChange={(event) => setUsageTypeFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
            <option value="all">All usage types</option>
            {usageTypeOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select value={usageStatusFilter} onChange={(event) => setUsageStatusFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
            <option value="all">All statuses</option>
            <option value="complete">Complete</option>
            <option value="failed">Failed</option>
          </select>
          <label className="flex items-center gap-2 rounded border border-ink/10 bg-bg px-3 py-2 text-sm text-ink/75">
            <input type="checkbox" checked={usageExcludeFailed} onChange={(event) => setUsageExcludeFailed(event.target.checked)} />
            Hide failed
          </label>
        </div>
        {usageLogsQuery.isLoading ? <p className="mt-3 text-sm text-ink/60">Loading usage logs...</p> : null}
        <div className="mt-4 space-y-3">
          {usageLogs.map((record) => {
            const user = usersById.get(String(record.userId || ""));
            const project = record.projectId ? projectsById.get(String(record.projectId)) : null;
            return (
              <article key={`${record.usageRecordId ?? "usage"}-${record.createdAt ?? ""}`} className="rounded-lg border border-ink/10 bg-bg px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-ink">{record.requestType || record.source || "Unknown"}</p>
                    <p className="text-xs text-ink/55">
                      {user?.email || user?.username || record.userId || "Unknown user"}
                      {project ? ` · ${project.name}` : ""}
                      {record.workflowId ? ` · ${record.workflowId}` : ""}
                    </p>
                    <p className="text-xs text-ink/60">{record.appModelId || record.providerModel || "Unknown model"}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-wide text-ink/55">{record.status || "unknown"}</p>
                    <p className="text-sm font-semibold text-ink">{formatUsd(record.estimatedCostUsd ?? 0)}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink/65">
                  <span>{formatTimestamp(record.createdAt)}</span>
                  {record.toolOrigin ? <span>{record.toolOrigin}</span> : null}
                  {record.pricingId ? <span>{record.pricingId}</span> : null}
                </div>
                <p className="mt-2 text-xs text-ink/65">{usageSummaryLine(record.usage || {})}</p>
              </article>
            );
          })}
          {!usageLogs.length && !usageLogsQuery.isLoading ? <p className="text-sm text-ink/60">No usage records match the current filter.</p> : null}
        </div>
        {usageLogsQuery.data?.hasMore ? (
          <div className="mt-4 flex justify-center">
            <button type="button" className="text-sm text-accent underline" onClick={() => setUsageLimit((value) => value + 24)}>
              More...
            </button>
          </div>
        ) : null}
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

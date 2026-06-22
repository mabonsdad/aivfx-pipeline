import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import { StatusNotice } from "../components/layout/UiFeedback";
import type { ApiRequestAssetRecord, ApiRequestRecord } from "../types/api";

function formatTimestamp(value: string | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${value.toFixed(1)}s`;
}

function apiRequestTitle(record: ApiRequestRecord): string {
  if (record.workflow === "image_edit_full") return "Full image edit";
  if (record.workflow === "image_edit_patch") return "Patch image edit";
  return "Reference video generation";
}

function assetEntries(record: Record<string, ApiRequestAssetRecord> | undefined): Array<[string, ApiRequestAssetRecord]> {
  return Object.entries(record ?? {}).filter((entry): entry is [string, ApiRequestAssetRecord] => Boolean(entry[1]));
}

function AssetPreview({ label, asset }: { label: string; asset: ApiRequestAssetRecord }) {
  if (!asset) return null;
  const url = typeof asset.url === "string" ? asset.url : "";
  const contentType = typeof asset.contentType === "string" ? asset.contentType : "";
  const isImage = contentType.startsWith("image/");
  const isVideo = contentType.startsWith("video/");

  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/70">{label}</p>
      {isImage && url ? <img src={url} alt={label} className="max-h-48 w-full rounded bg-bg object-contain" /> : null}
      {isVideo && url ? <video src={url} controls className="max-h-48 w-full rounded bg-black" preload="metadata" /> : null}
      {!isImage && !isVideo ? <p className="text-sm text-ink/60">No inline preview for {contentType || "this asset"}.</p> : null}
      <div className="mt-2 space-y-1 text-xs text-ink/70">
        {typeof asset.width === "number" && typeof asset.height === "number" ? <p>{asset.width} × {asset.height}</p> : null}
        {typeof asset.durationSec === "number" ? <p>{asset.durationSec.toFixed(2)}s</p> : null}
        {typeof asset.sizeBytes === "number" ? <p>{(asset.sizeBytes / (1024 * 1024)).toFixed(2)} MB</p> : null}
        {url ? (
          <a className="text-accent underline" href={url} target="_blank" rel="noreferrer">
            Open asset
          </a>
        ) : null}
      </div>
    </div>
  );
}

export default function ApiLogsPage({
  scope = "mine",
}: {
  scope?: "mine" | "all";
}) {
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [excludeFailed, setExcludeFailed] = useState(false);
  const [requestLimit, setRequestLimit] = useState(30);

  const adminUsersQuery = useQuery({
    queryKey: ["admin", "users", "api-logs"],
    queryFn: () => apiClient.listAdminUsers(),
    enabled: scope === "all",
    refetchOnWindowFocus: false,
  });

  const requestsQuery = useQuery({
    queryKey: ["api-requests", scope, statusFilter, workflowFilter, userFilter, excludeFailed, requestLimit],
    queryFn: async () =>
      apiClient.listApiRequests({
        limit: requestLimit,
        scope,
        status: statusFilter !== "all" ? statusFilter : undefined,
        workflow: workflowFilter !== "all" ? workflowFilter : undefined,
        userId: scope === "all" && userFilter !== "all" ? userFilter : null,
        excludeFailed,
      }),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  });

  const requests = useMemo(() => requestsQuery.data?.requests ?? [], [requestsQuery.data?.requests]);
  const selectedRequest = useMemo(
    () => requests.find((item) => item.requestId === selectedRequestId) ?? requests[0] ?? null,
    [requests, selectedRequestId],
  );

  useEffect(() => {
    setRequestLimit(30);
  }, [statusFilter, workflowFilter, userFilter, excludeFailed, scope]);

  useEffect(() => {
    if (selectedRequestId && requests.some((item) => item.requestId === selectedRequestId)) return;
    setSelectedRequestId(requests[0]?.requestId ?? null);
  }, [requests, selectedRequestId]);

  const detailQuery = useQuery({
    queryKey: ["api-request", scope, selectedRequest?.requestId],
    queryFn: () => apiClient.getApiRequest(selectedRequest!.requestId, { scope }),
    enabled: Boolean(selectedRequest?.requestId),
    refetchInterval: selectedRequest?.status === "queued" || selectedRequest?.status === "running" ? 5000 : false,
    refetchOnWindowFocus: false,
  });

  const detail = detailQuery.data ?? selectedRequest;
  const combinedLogs = useMemo(() => {
    const requestLogs = detail?.logs ?? [];
    const jobLogs = detail?.job?.logs ?? [];
    return [...requestLogs, ...jobLogs].sort((a, b) => a.at.localeCompare(b.at));
  }, [detail?.job?.logs, detail?.logs]);
  const workflowOptions = useMemo(() => {
    const values = new Set<string>();
    for (const item of requests) {
      const workflow = String(item.workflow || "").trim();
      if (workflow) values.add(workflow);
    }
    return Array.from(values).sort();
  }, [requests]);
  const adminUsers = adminUsersQuery.data?.users ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink/10 bg-white p-4">
        <h2 className="text-base font-semibold">API Logs</h2>
        <p className="mt-1 text-sm text-ink/65">
          {scope === "all"
            ? "Admin view across all users. This shows external API inputs, prepared media, outputs, timings, and failures."
            : "External API calls run outside the task storage flow. This view shows their inputs, prepared media, outputs, timings, and failures."}
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="rounded-xl border border-ink/10 bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">Requests</p>
              <p className="text-xs text-ink/55">{requestsQuery.data?.total ?? 0} matching</p>
            </div>
            <div className="mt-3 grid gap-2">
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
                <option value="all">All statuses</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="complete">Complete</option>
                <option value="failed">Failed</option>
              </select>
              <select value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
                <option value="all">All workflows</option>
                {workflowOptions.map((workflow) => (
                  <option key={workflow} value={workflow}>
                    {workflow}
                  </option>
                ))}
              </select>
              {scope === "all" ? (
                <select value={userFilter} onChange={(event) => setUserFilter(event.target.value)} className="rounded border border-ink/20 px-3 py-2 text-sm">
                  <option value="all">All users</option>
                  {adminUsers.map((user) => (
                    <option key={String(user.userId)} value={String(user.userId)}>
                      {user.email || user.username || user.userId}
                    </option>
                  ))}
                </select>
              ) : null}
              <label className="flex items-center gap-2 rounded border border-ink/10 bg-bg px-3 py-2 text-sm text-ink/75">
                <input type="checkbox" checked={excludeFailed} onChange={(event) => setExcludeFailed(event.target.checked)} />
                Hide failed
              </label>
            </div>
            {requestsQuery.isLoading ? (
              <div className="mt-2">
                <StatusNotice variant="loading">
                  <p>Loading API requests...</p>
                </StatusNotice>
              </div>
            ) : null}
            {requestsQuery.error ? (
              <div className="mt-2">
                <StatusNotice variant="error">
                  <p>{requestsQuery.error.message}</p>
                </StatusNotice>
              </div>
            ) : null}
            <div className="mt-3 space-y-2">
              {requests.map((item) => (
                <button
                  key={item.requestId}
                  type="button"
                  onClick={() => setSelectedRequestId(item.requestId)}
                  className={`w-full rounded-lg border px-3 py-2 text-left ${
                    item.requestId === (detail?.requestId ?? selectedRequest?.requestId)
                      ? "border-accent bg-accent/10"
                      : item.status === "failed"
                        ? "border-red-200 bg-red-50"
                        : "border-ink/10 bg-card"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{apiRequestTitle(item)}</p>
                      <p className="text-xs text-ink/60">{item.model}</p>
                      {scope === "all" ? <p className="text-[11px] text-ink/55">{item.userEmail || item.username || item.userId}</p> : null}
                    </div>
                    <p className="text-[11px] uppercase tracking-wide text-ink/70">{item.status}</p>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink/55">
                    <span>{formatDuration(item.processingDurationSec)}</span>
                    <span>{formatTimestamp(item.updatedAt)}</span>
                  </div>
                </button>
              ))}
              {!requests.length && !requestsQuery.isLoading ? <p className="text-sm text-ink/60">No API requests match the current filter.</p> : null}
            </div>
            {requestsQuery.data?.hasMore ? (
              <div className="mt-4 flex justify-center">
                <button type="button" className="text-sm text-accent underline" onClick={() => setRequestLimit((value) => value + 30)}>
                  More...
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          {!detail ? (
            <div className="rounded-xl border border-ink/10 bg-white p-4 text-sm text-ink/60">Select an API request to inspect it.</div>
          ) : (
            <>
              {detailQuery.isPending ? (
                <StatusNotice variant="loading">
                  <p>Loading request details...</p>
                </StatusNotice>
              ) : null}
              <div className="rounded-xl border border-ink/10 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{apiRequestTitle(detail)}</h3>
                    <p className="text-sm text-ink/60">
                      {detail.requestId} · {detail.provider ?? "provider unknown"} · {detail.model}
                    </p>
                    {scope === "all" ? (
                      <p className="text-xs text-ink/55">Owner: {detail.userEmail || detail.username || detail.userId}</p>
                    ) : null}
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-medium uppercase tracking-wide text-ink/80">{detail.status}</p>
                    <p className="text-ink/60">{formatDuration(detail.processingDurationSec)}</p>
                  </div>
                </div>
                {detail.error ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {typeof detail.error === "string" ? detail.error : detail.error.message || "Request failed"}
                  </div>
                ) : null}
                {detail.request?.prompt ? (
                  <div className="mt-3 rounded-lg bg-bg p-3 text-sm text-ink/80">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink/60">Prompt</p>
                    <p>{String(detail.request.prompt)}</p>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-ink/10 bg-white p-4">
                <p className="mb-3 text-sm font-semibold">Assets</p>
                <div className="space-y-4">
                  {assetEntries(detail.inputAssets).length ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Incoming</p>
                      <div className="grid gap-3 md:grid-cols-2">
                        {assetEntries(detail.inputAssets).map(([label, asset]) => (
                          <AssetPreview key={`input:${label}`} label={label} asset={asset} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {assetEntries(detail.preparedAssets).length ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Prepared For Provider</p>
                      <div className="grid gap-3 md:grid-cols-2">
                        {assetEntries(detail.preparedAssets).map(([label, asset]) => (
                          <AssetPreview key={`prepared:${label}`} label={label} asset={asset} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {assetEntries(detail.outputAssets).length ? (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Output</p>
                      <div className="grid gap-3 md:grid-cols-2">
                        {assetEntries(detail.outputAssets).map(([label, asset]) => (
                          <AssetPreview key={`output:${label}`} label={label} asset={asset} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-ink/10 bg-white p-4">
                  <p className="mb-2 text-sm font-semibold">Normalization</p>
                  <pre className="overflow-x-auto rounded bg-bg p-3 text-xs text-ink/80">
                    {JSON.stringify(detail.normalization ?? {}, null, 2)}
                  </pre>
                </div>
                <div className="rounded-xl border border-ink/10 bg-white p-4">
                  <p className="mb-2 text-sm font-semibold">Logs</p>
                  {combinedLogs.length ? (
                    <div className="max-h-80 space-y-2 overflow-y-auto rounded bg-bg p-3 text-xs text-ink/80">
                      {combinedLogs.map((entry, index) => (
                        <div key={`${entry.at}:${index}`}>
                          <p className="font-medium text-ink/65">{formatTimestamp(entry.at)}</p>
                          <p>{entry.message}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-ink/60">No logs yet.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

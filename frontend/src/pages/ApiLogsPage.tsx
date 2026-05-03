import { useMemo, useState } from "react";
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

export default function ApiLogsPage() {
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const requestsQuery = useQuery({
    queryKey: ["api-requests"],
    queryFn: async () => (await apiClient.listApiRequests({ limit: 100 })).requests,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  });

  const requests = requestsQuery.data ?? [];
  const selectedRequest = useMemo(
    () => requests.find((item) => item.requestId === selectedRequestId) ?? requests[0] ?? null,
    [requests, selectedRequestId],
  );

  const detailQuery = useQuery({
    queryKey: ["api-request", selectedRequest?.requestId],
    queryFn: () => apiClient.getApiRequest(selectedRequest!.requestId),
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

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink/10 bg-white p-4">
        <h2 className="text-base font-semibold">API Logs</h2>
        <p className="mt-1 text-sm text-ink/65">
          External API calls run outside the task storage flow. This view shows their inputs, prepared media, outputs, timings, and failures.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="rounded-xl border border-ink/10 bg-white p-3">
            <p className="text-sm font-semibold">Requests</p>
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
                  <p className="text-sm font-medium">{apiRequestTitle(item)}</p>
                  <p className="text-xs text-ink/60">{item.model}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-ink/70">
                    {item.status} · {formatDuration(item.processingDurationSec)}
                  </p>
                  <p className="mt-1 text-[11px] text-ink/55">{formatTimestamp(item.updatedAt)}</p>
                </button>
              ))}
              {!requests.length && !requestsQuery.isLoading ? <p className="text-sm text-ink/60">No API requests yet.</p> : null}
            </div>
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

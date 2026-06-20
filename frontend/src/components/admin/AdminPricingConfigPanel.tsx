import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiClient } from "../../api/client";
import { StatusNotice } from "../layout/UiFeedback";
import type { PricingAdminConfig, PricingConfigEntry } from "../../lib/pricingConfig";

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseEntriesJson(raw: string): PricingConfigEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Entries JSON must be an array.");
  }
  return parsed as PricingConfigEntry[];
}

export default function AdminPricingConfigPanel() {
  const [pinInput, setPinInput] = useState("");
  const [activePin, setActivePin] = useState<string | undefined>(undefined);
  const [entriesJsonDraft, setEntriesJsonDraft] = useState("[]");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ["admin", "pricing-config", activePin ?? "owner"],
    queryFn: () => apiClient.getPricingAdminConfig(activePin),
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    const config = configQuery.data?.config;
    if (!config) return;
    setEntriesJsonDraft(prettyJson(config.entries || []));
    setSaveMessage(null);
    setLocalError(null);
  }, [configQuery.data?.config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const entries = parseEntriesJson(entriesJsonDraft);
      const payload: PricingAdminConfig = {
        schemaVersion: 1,
        entries,
      };
      return apiClient.updatePricingAdminConfig(payload, activePin);
    },
    onSuccess: (result) => {
      setEntriesJsonDraft(prettyJson(result.config.entries || []));
      setLocalError(null);
      setSaveMessage(`Saved ${result.config.updatedAt ? `at ${new Date(result.config.updatedAt).toLocaleString()}` : "successfully"}.`);
    },
    onError: (error) => {
      setSaveMessage(null);
      setLocalError(error instanceof Error ? error.message : "Failed to save config");
    },
  });

  const accessLabel = useMemo(() => {
    const access = configQuery.data?.access;
    if (!access) return null;
    if (access.isAdmin) return "Admin access";
    if (access.viaPin) return "PIN access";
    return null;
  }, [configQuery.data?.access]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink/10 bg-white p-4">
        <h2 className="text-base font-semibold">Admin: Pricing Config</h2>
        <p className="mt-1 text-sm text-ink/65">
          Edit centralized API pricing constants used for cost estimation across prompt and generation surfaces.
        </p>
      </div>

      <div className="rounded-xl border border-ink/10 bg-white p-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/70">Admin PIN (optional if your user is not in an admin group)</label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={pinInput}
            onChange={(event) => setPinInput(event.target.value)}
            placeholder="Enter PIN"
            className="rounded border border-ink/20 px-3 py-2 text-sm"
          />
          <button
            type="button"
            className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
            onClick={() => {
              setActivePin(pinInput.trim() || undefined);
              setSaveMessage(null);
              setLocalError(null);
              void configQuery.refetch();
            }}
          >
            Unlock
          </button>
          <button
            type="button"
            className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
            onClick={() => {
              setActivePin(undefined);
              setPinInput("");
              setSaveMessage(null);
              setLocalError(null);
              void configQuery.refetch();
            }}
          >
            Use owner auth only
          </button>
          {accessLabel ? <span className="text-xs text-ink/70">{accessLabel}</span> : null}
        </div>
      </div>

      {configQuery.isLoading ? (
        <StatusNotice variant="loading">
          <p>Loading pricing config...</p>
        </StatusNotice>
      ) : null}

      {configQuery.error ? (
        <StatusNotice variant="error">
          <p>{configQuery.error.message}</p>
        </StatusNotice>
      ) : null}

      {localError ? (
        <StatusNotice variant="error">
          <p>{localError}</p>
        </StatusNotice>
      ) : null}

      {saveMessage ? (
        <StatusNotice variant="success">
          <p>{saveMessage}</p>
        </StatusNotice>
      ) : null}

      {configQuery.data ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-ink/10 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Pricing registry (JSON)</p>
              <p className="text-xs text-ink/60">
                Last update: {configQuery.data.config.updatedAt ? new Date(configQuery.data.config.updatedAt).toLocaleString() : "never"}
              </p>
            </div>
            <textarea
              value={entriesJsonDraft}
              onChange={(event) => setEntriesJsonDraft(event.target.value)}
              className="h-[38rem] w-full rounded border border-ink/20 p-2 font-mono text-xs"
              spellCheck={false}
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
              onClick={() => {
                const config = configQuery.data?.config;
                if (!config) return;
                setEntriesJsonDraft(prettyJson(config.entries || []));
                setLocalError(null);
                setSaveMessage(null);
              }}
            >
              Revert local edits
            </button>
            <button
              type="button"
              className="rounded bg-accent px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={saveMutation.isPending}
              onClick={() => {
                setLocalError(null);
                setSaveMessage(null);
                void saveMutation.mutateAsync();
              }}
            >
              {saveMutation.isPending ? "Saving..." : "Save config"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

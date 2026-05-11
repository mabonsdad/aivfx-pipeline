import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import { StatusNotice } from "../components/layout/UiFeedback";
import type { PromptWizardAdminConfig, PromptWizardAdminModelConfig } from "../lib/promptWizardConfig";

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseModelsJson(raw: string): PromptWizardAdminModelConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Models JSON must be an array.");
  }
  return parsed as PromptWizardAdminModelConfig[];
}

export default function AdminPromptWizardPage() {
  const [pinInput, setPinInput] = useState("");
  const [activePin, setActivePin] = useState<string | undefined>(undefined);
  const [systemPromptDraft, setSystemPromptDraft] = useState("");
  const [modelsJsonDraft, setModelsJsonDraft] = useState("[]");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ["admin", "prompt-wizard-config", activePin ?? "owner"],
    queryFn: () => apiClient.getPromptWizardAdminConfig(activePin),
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    const config = configQuery.data?.config;
    if (!config) return;
    setSystemPromptDraft(config.systemPrompt || "");
    setModelsJsonDraft(prettyJson(config.models || []));
    setSaveMessage(null);
    setLocalError(null);
  }, [configQuery.data?.config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const models = parseModelsJson(modelsJsonDraft);
      const payload: PromptWizardAdminConfig = {
        schemaVersion: 1,
        systemPrompt: systemPromptDraft,
        models,
      };
      return apiClient.updatePromptWizardAdminConfig(payload, activePin);
    },
    onSuccess: (result) => {
      setSystemPromptDraft(result.config.systemPrompt || "");
      setModelsJsonDraft(prettyJson(result.config.models || []));
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
    if (access.isOwner) return "Owner access";
    if (access.viaPin) return "PIN access";
    return null;
  }, [configQuery.data?.access]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink/10 bg-white p-4">
        <h2 className="text-base font-semibold">Admin: Prompt Wizard Config</h2>
        <p className="mt-1 text-sm text-ink/65">
          Edit centralized Prompt Wizard model registry data and the system prompt used by the backend.
        </p>
      </div>

      <div className="rounded-xl border border-ink/10 bg-white p-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/70">Admin PIN (optional if owner account)</label>
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
          <p>Loading admin config...</p>
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
              <p className="text-sm font-semibold">System Prompt</p>
              <p className="text-xs text-ink/60">
                Last update: {configQuery.data.config.updatedAt ? new Date(configQuery.data.config.updatedAt).toLocaleString() : "never"}
              </p>
            </div>
            <textarea
              value={systemPromptDraft}
              onChange={(event) => setSystemPromptDraft(event.target.value)}
              className="h-64 w-full rounded border border-ink/20 p-2 text-xs"
              spellCheck={false}
            />
          </div>

          <div className="rounded-xl border border-ink/10 bg-white p-4">
            <p className="mb-2 text-sm font-semibold">Model Registry (JSON)</p>
            <textarea
              value={modelsJsonDraft}
              onChange={(event) => setModelsJsonDraft(event.target.value)}
              className="h-96 w-full rounded border border-ink/20 p-2 font-mono text-xs"
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
                setSystemPromptDraft(config.systemPrompt || "");
                setModelsJsonDraft(prettyJson(config.models || []));
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

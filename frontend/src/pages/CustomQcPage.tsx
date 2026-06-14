import { useEffect, useMemo, useState } from "react";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import { StatusNotice } from "../components/layout/UiFeedback";
import { FRAME_TEST_OPTIONS, ReportCreateModal } from "../components/reports/QcReportShared";
import type { CustomReportTypeId } from "../lib/generated/apiContracts";
import type { CustomReportOutputRef, CustomReportRecord, TaskDetail } from "../types/api";

type CustomQcPageProps = {
  task: TaskDetail | undefined;
  taskId: string | null;
  taskQuery: UseQueryResult<TaskDetail, Error>;
  createCustomReportMutation: UseMutationResult<
    { reportId: string },
    Error,
    {
      taskId: string;
      reportType: CustomReportTypeId;
      tests: string[];
      outputRefs: CustomReportOutputRef[];
      name?: string;
    },
    unknown
  >;
  deleteCustomReportMutation: UseMutationResult<{ ok: true }, Error, { taskId: string; reportId: string }, unknown>;
  openReport: (taskId: string, reportId: string) => void;
  formatAssetDate: (iso: string) => string;
};

type UploadSelection = {
  file: File | null;
  previewUrl: string | null;
};

type ExternalQcMode = "image" | "video";

const VIDEO_CUSTOM_TEST_OPTIONS = [
  ...FRAME_TEST_OPTIONS,
  { id: "video_diff", label: "Video diff comparison", description: "Diff video comparing the uploaded clips over time." },
] as const;

function isExternalQcReport(report: CustomReportRecord): boolean {
  return report.assetRefs.some((ref) => ref.assetType === "external_frame_pair");
}

export default function CustomQcPage({
  task,
  taskId,
  taskQuery,
  createCustomReportMutation,
  deleteCustomReportMutation,
  openReport,
  formatAssetDate,
}: CustomQcPageProps) {
  const [mode, setMode] = useState<ExternalQcMode>("image");
  const [originalSelection, setOriginalSelection] = useState<UploadSelection>({ file: null, previewUrl: null });
  const [editedSelection, setEditedSelection] = useState<UploadSelection>({ file: null, previewUrl: null });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [reportName, setReportName] = useState("");
  const [selectedTests, setSelectedTests] = useState<string[]>(["frame_diff", "frame_composite"]);

  const customReports = useMemo(
    () =>
      [...(task?.customReports ?? [])]
        .filter(isExternalQcReport)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [task?.customReports],
  );

  useEffect(() => {
    if (!customReports.some((report) => report.status === "queued" || report.status === "running")) return;
    const timer = window.setInterval(() => {
      void taskQuery.refetch();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [customReports, taskQuery]);

  useEffect(() => {
    setSelectedTests(mode === "video" ? ["frame_diff", "frame_composite", "video_diff"] : ["frame_diff", "frame_composite"]);
    if (originalSelection.previewUrl) URL.revokeObjectURL(originalSelection.previewUrl);
    if (editedSelection.previewUrl) URL.revokeObjectURL(editedSelection.previewUrl);
    setOriginalSelection({ file: null, previewUrl: null });
    setEditedSelection({ file: null, previewUrl: null });
  }, [mode]);

  function updateSelection(current: UploadSelection, setter: (value: UploadSelection) => void, file: File | null) {
    if (current.previewUrl) URL.revokeObjectURL(current.previewUrl);
    setter(file ? { file, previewUrl: URL.createObjectURL(file) } : { file: null, previewUrl: null });
  }

  function toggleTest(id: string) {
    setSelectedTests((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));
  }

  async function createReport() {
    if (!taskId || !originalSelection.file || !editedSelection.file) return;
    const uploadInit = await apiClient.createExternalQcPairUpload(taskId, {
      originalFilename: originalSelection.file.name,
      originalContentType: originalSelection.file.type || "image/png",
      editedFilename: editedSelection.file.name,
      editedContentType: editedSelection.file.type || "image/png",
    });
    await Promise.all([
      fetch(uploadInit.originalUploadUrl, {
        method: "PUT",
        headers: { "content-type": originalSelection.file.type || "image/png" },
        body: originalSelection.file,
      }).then((response) => {
        if (!response.ok) throw new Error(`Original upload failed: ${response.status}`);
      }),
      fetch(uploadInit.editedUploadUrl, {
        method: "PUT",
        headers: { "content-type": editedSelection.file.type || "image/png" },
        body: editedSelection.file,
      }).then((response) => {
        if (!response.ok) throw new Error(`Edited upload failed: ${response.status}`);
      }),
    ]);

    const result = await createCustomReportMutation.mutateAsync({
      taskId,
      reportType: "qc_frame",
      tests: selectedTests,
      outputRefs: [{ assetType: "external_frame_pair", pairId: uploadInit.pairId }],
      name: reportName.trim() || undefined,
    });
    setCreateModalOpen(false);
    setReportName("");
    setSelectedTests(["frame_diff", "frame_composite"]);
    await taskQuery.refetch();
    openReport(taskId, result.reportId);
  }

  async function deleteReport(reportId: string, reportNameValue: string) {
    if (!taskId) return;
    const ok = window.confirm(`Delete report "${reportNameValue}"?`);
    if (!ok) return;
    await deleteCustomReportMutation.mutateAsync({ taskId, reportId });
    await taskQuery.refetch();
  }

  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-2xl border border-ink/10 bg-card p-4">
        <div>
          <h2 className="text-lg font-semibold">Custom QC test</h2>
          <p className="text-sm text-ink/60">
            {mode === "video"
              ? "Upload two videos. The report will compare frame 0 and then a frame every 2 seconds, with optional diff-video output."
              : "Upload two frames, then run the same QC comparisons used elsewhere in the app."}
          </p>
        </div>
        <div className="inline-flex rounded-xl border border-ink/10 bg-white p-1">
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm ${mode === "image" ? "bg-ink text-white" : "text-ink/70"}`}
            onClick={() => setMode("image")}
          >
            Two frames
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm ${mode === "video" ? "bg-ink text-white" : "text-ink/70"}`}
            onClick={() => setMode("video")}
          >
            Two videos
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-ink/10 bg-white p-3">
            <p className="text-sm font-semibold">{mode === "video" ? "Original video" : "Original frame"}</p>
            <label className="inline-flex cursor-pointer rounded border border-ink/20 bg-white px-3 py-2 text-sm">
              <input
                type="file"
                accept={mode === "video" ? "video/*" : "image/*"}
                className="sr-only"
                onChange={(event) => updateSelection(originalSelection, setOriginalSelection, event.target.files?.[0] ?? null)}
              />
              {mode === "video" ? "Upload original video" : "Upload original frame"}
            </label>
            {originalSelection.previewUrl ? (
              mode === "video" ? (
                <video src={originalSelection.previewUrl} controls muted className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
              ) : (
                <img src={originalSelection.previewUrl} alt="Original frame preview" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
              )
            ) : (
              <div className="flex aspect-video items-center justify-center rounded border border-dashed border-ink/15 bg-bg/40 text-sm text-ink/45">
                {mode === "video" ? "No video selected" : "No image selected"}
              </div>
            )}
          </div>
          <div className="space-y-2 rounded-xl border border-ink/10 bg-white p-3">
            <p className="text-sm font-semibold">{mode === "video" ? "Edited video" : "Edited frame"}</p>
            <label className="inline-flex cursor-pointer rounded border border-ink/20 bg-white px-3 py-2 text-sm">
              <input
                type="file"
                accept={mode === "video" ? "video/*" : "image/*"}
                className="sr-only"
                onChange={(event) => updateSelection(editedSelection, setEditedSelection, event.target.files?.[0] ?? null)}
              />
              {mode === "video" ? "Upload edited video" : "Upload edited frame"}
            </label>
            {editedSelection.previewUrl ? (
              mode === "video" ? (
                <video src={editedSelection.previewUrl} controls muted className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
              ) : (
                <img src={editedSelection.previewUrl} alt="Edited frame preview" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
              )
            ) : (
              <div className="flex aspect-video items-center justify-center rounded border border-dashed border-ink/15 bg-bg/40 text-sm text-ink/45">
                {mode === "video" ? "No video selected" : "No image selected"}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end">
          <button
            type="button"
            className="rounded bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!originalSelection.file || !editedSelection.file}
            onClick={() => setCreateModalOpen(true)}
          >
            Create QC Report
          </button>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">Past custom QC reports</h3>
          <button type="button" className="rounded border border-ink/20 bg-white px-3 py-1.5 text-sm" onClick={() => void taskQuery.refetch()}>
            Refresh
          </button>
        </div>
        {taskQuery.error ? (
          <StatusNotice variant="error">
            <p>{taskQuery.error.message}</p>
          </StatusNotice>
        ) : null}
        {createCustomReportMutation.error ? (
          <StatusNotice variant="error">
            <p>{createCustomReportMutation.error.message}</p>
          </StatusNotice>
        ) : null}
        {deleteCustomReportMutation.error ? (
          <StatusNotice variant="error">
            <p>{deleteCustomReportMutation.error.message}</p>
          </StatusNotice>
        ) : null}
        {!customReports.length ? (
          <p className="text-sm text-ink/60">No custom QC reports created yet.</p>
        ) : (
          <div className="space-y-2">
            {customReports.map((report) => (
              <div key={report.reportId} className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-white p-3">
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{report.name}</p>
                  <p className="text-xs text-ink/60">{report.status} · {formatAssetDate(report.updatedAt)}</p>
                  <p className="text-xs text-ink/50">Tests: {report.tests.join(", ")}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" className="rounded border border-ink/20 bg-white px-3 py-1 text-sm" onClick={() => taskId && openReport(taskId, report.reportId)}>
                    Open
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-200 bg-white px-3 py-1 text-sm text-red-700"
                    onClick={() => void deleteReport(report.reportId, report.name)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ReportCreateModal
        isOpen={createModalOpen}
        title="Create QC Report"
        selectedCount={originalSelection.file && editedSelection.file ? 1 : 0}
        reportName={reportName}
        setReportName={setReportName}
        tests={mode === "video" ? VIDEO_CUSTOM_TEST_OPTIONS : FRAME_TEST_OPTIONS}
        selectedTests={selectedTests}
        toggleTest={toggleTest}
        onClose={() => setCreateModalOpen(false)}
        onCreate={() => void createReport()}
        isPending={createCustomReportMutation.isPending}
      />
    </div>
  );
}

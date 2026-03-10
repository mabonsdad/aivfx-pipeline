import type { ReactNode } from "react";

import type { CustomReportOutputRef, CustomReportRecord, TaskDetail } from "../../types/api";

type LibraryAsset = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  mediaType: "image" | "video";
  customReportRef?: CustomReportOutputRef;
  deletePayload:
    | { assetType: "upload" }
    | { assetType: "frame_capture"; frameId: string }
    | { assetType: "frame_variant"; frameId: string; variantId: string }
    | { assetType: "segment_generation"; genId: string }
    | { assetType: "export"; exportId: string };
};

export type AssetsTabCtx = {
  selectedTaskId: string | null;
  task: TaskDetail | undefined;
  renderCustomReportBox: (taskId: string | null, reports: CustomReportRecord[] | undefined) => ReactNode;
  assetsLoading: boolean;
  uploadAssets: LibraryAsset[];
  uploadAssetsVisible: number;
  formatAssetDate: (iso: string) => string;
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  handleDeleteAsset: (item: LibraryAsset) => Promise<void>;
  setUploadAssetsVisible: (update: number | ((count: number) => number)) => void;
  frameAssets: LibraryAsset[];
  frameAssetsVisible: number;
  setFrameAssetsVisible: (update: number | ((count: number) => number)) => void;
  outputVideoAssets: LibraryAsset[];
  videoAssetsVisible: number;
  setVideoAssetsVisible: (update: number | ((count: number) => number)) => void;
};

type AssetsTabProps = {
  ctx: AssetsTabCtx;
};

function PreviewIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m6 6 1 14h10l1-14" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function AssetActions({
  item,
  selectedReportOutputs,
  reportOutputRefKey,
  toggleCustomReportOutput,
  handleDeleteAsset,
}: {
  item: LibraryAsset;
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  handleDeleteAsset: (item: LibraryAsset) => Promise<void>;
}) {
  const canSelectForQc = Boolean(item.customReportRef);
  const checked = canSelectForQc
    ? Boolean(selectedReportOutputs[`${item.taskId}:${reportOutputRefKey(item.customReportRef as CustomReportOutputRef)}`])
    : false;
  return (
    <div className="flex items-center gap-2 text-sm">
      <label
        className={`flex items-center gap-1 rounded border px-2 py-1 text-xs ${
          canSelectForQc ? "border-ink/20 bg-white text-ink/70" : "border-ink/10 bg-bg text-ink/40"
        }`}
        title={canSelectForQc ? "Include in custom QC report" : "QC selection is available for edited frames and generated videos"}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!canSelectForQc}
          onChange={() => {
            if (!canSelectForQc || !item.customReportRef) return;
            toggleCustomReportOutput(item.taskId, item.customReportRef);
          }}
        />
        QC
      </label>
      <a
        href={item.previewUrl}
        target="_blank"
        rel="noreferrer"
        title="Preview"
        className="rounded border border-ink/20 bg-white p-2 text-xs"
      >
        <PreviewIcon />
      </a>
      <a
        href={item.downloadUrl}
        target="_blank"
        rel="noreferrer"
        download
        title="Download"
        className="rounded border border-ink/20 bg-white p-2 text-xs"
      >
        <DownloadIcon />
      </a>
      <button
        onClick={() => handleDeleteAsset(item)}
        title="Delete"
        className="rounded border border-red-200 bg-white p-2 text-xs text-red-700"
      >
        <DeleteIcon />
      </button>
    </div>
  );
}

export default function AssetsTab({ ctx }: AssetsTabProps) {
  const {
    selectedTaskId,
    task,
    renderCustomReportBox,
    assetsLoading,
    uploadAssets,
    uploadAssetsVisible,
    formatAssetDate,
    selectedReportOutputs,
    reportOutputRefKey,
    toggleCustomReportOutput,
    handleDeleteAsset,
    setUploadAssetsVisible,
    frameAssets,
    frameAssetsVisible,
    setFrameAssetsVisible,
    outputVideoAssets,
    videoAssetsVisible,
    setVideoAssetsVisible,
  } = ctx;

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold">Download Assets</h3>
      {renderCustomReportBox(selectedTaskId, task?.customReports ?? [])}
      {assetsLoading ? <p className="text-sm text-ink/60">Loading assets...</p> : null}
      <div className="space-y-3 rounded-lg border border-ink/10 p-3">
        <p className="font-medium">Uploads</p>
        {uploadAssets.length === 0 ? (
          <p className="text-sm text-ink/60">No uploads found.</p>
        ) : (
          <div className="space-y-2">
            {uploadAssets.slice(0, uploadAssetsVisible).map((item, index) => (
              <div
                key={item.id}
                className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                  index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                }`}
              >
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt={item.title} className="max-h-20 w-full rounded bg-bg object-contain" />
                ) : (
                  <div className="flex max-h-20 min-h-20 w-full items-center justify-center rounded border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                    Video
                  </div>
                )}
                <div>
                  <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                  <p className="text-xs text-ink/60">{item.subtitle}</p>
                  <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                </div>
                <AssetActions
                  item={item}
                  selectedReportOutputs={selectedReportOutputs}
                  reportOutputRefKey={reportOutputRefKey}
                  toggleCustomReportOutput={toggleCustomReportOutput}
                  handleDeleteAsset={handleDeleteAsset}
                />
              </div>
            ))}
            {uploadAssetsVisible < uploadAssets.length ? (
              <button className="text-sm text-accent underline" onClick={() => setUploadAssetsVisible((count) => count + 6)}>
                More...
              </button>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-ink/10 p-3">
        <p className="font-medium">Output Frames & Edits</p>
        {frameAssets.length === 0 ? (
          <p className="text-sm text-ink/60">No frame assets found.</p>
        ) : (
          <div className="space-y-2">
            {frameAssets.slice(0, frameAssetsVisible).map((item, index) => (
              <div
                key={item.id}
                className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                  index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                }`}
              >
                <img src={item.previewUrl} className="max-h-20 w-full rounded bg-bg object-contain" />
                <div>
                  <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                  <p className="text-xs text-ink/60">{item.subtitle}</p>
                  <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                </div>
                <AssetActions
                  item={item}
                  selectedReportOutputs={selectedReportOutputs}
                  reportOutputRefKey={reportOutputRefKey}
                  toggleCustomReportOutput={toggleCustomReportOutput}
                  handleDeleteAsset={handleDeleteAsset}
                />
              </div>
            ))}
            {frameAssetsVisible < frameAssets.length ? (
              <button className="text-sm text-accent underline" onClick={() => setFrameAssetsVisible((count) => count + 6)}>
                More...
              </button>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-ink/10 p-3">
        <p className="font-medium">Output Videos</p>
        {outputVideoAssets.length === 0 ? (
          <p className="text-sm text-ink/60">No output videos found.</p>
        ) : (
          <div className="space-y-2">
            {outputVideoAssets.slice(0, videoAssetsVisible).map((item, index) => (
              <div
                key={item.id}
                className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                  index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                }`}
              >
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt={item.title} className="max-h-20 w-full rounded bg-bg object-contain" />
                ) : (
                  <div className="flex max-h-20 min-h-20 w-full items-center justify-center rounded border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                    Video
                  </div>
                )}
                <div>
                  <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                  <p className="text-xs text-ink/60">{item.subtitle}</p>
                  <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                </div>
                <AssetActions
                  item={item}
                  selectedReportOutputs={selectedReportOutputs}
                  reportOutputRefKey={reportOutputRefKey}
                  toggleCustomReportOutput={toggleCustomReportOutput}
                  handleDeleteAsset={handleDeleteAsset}
                />
              </div>
            ))}
            {videoAssetsVisible < outputVideoAssets.length ? (
              <button className="text-sm text-accent underline" onClick={() => setVideoAssetsVisible((count) => count + 6)}>
                More...
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

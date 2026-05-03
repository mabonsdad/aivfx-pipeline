import type { ReactNode } from "react";

import { DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
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
      <IconActionButton href={item.previewUrl} title="Preview">
        <PreviewIcon />
      </IconActionButton>
      <IconActionButton href={item.downloadUrl} download title="Download">
        <DownloadIcon />
      </IconActionButton>
      <IconActionButton onClick={() => handleDeleteAsset(item)} title="Delete" tone="danger">
        <DeleteIcon />
      </IconActionButton>
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
                  <img src={item.thumbnailUrl} alt={item.title} className="max-h-20 w-full rounded bg-bg object-contain" loading="lazy" decoding="async" />
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
                <img src={item.previewUrl} className="max-h-20 w-full rounded bg-bg object-contain" loading="lazy" decoding="async" />
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
                  <img src={item.thumbnailUrl} alt={item.title} className="max-h-20 w-full rounded bg-bg object-contain" loading="lazy" decoding="async" />
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

import type { CustomReportOutputRef } from "../../types/api";

type AssetsTabProps = {
  ctx: any;
};

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
  } = ctx as any;

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
            {uploadAssets.slice(0, uploadAssetsVisible).map((item: any, index: number) => (
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
                <div className="flex items-center gap-2 text-sm">
                  {item.customReportRef ? (
                    <label className="flex items-center gap-1 text-xs text-ink/70">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedReportOutputs[`${item.taskId}:${reportOutputRefKey(item.customReportRef)}`])}
                        onChange={() => toggleCustomReportOutput(item.taskId, item.customReportRef as CustomReportOutputRef)}
                      />
                      QC
                    </label>
                  ) : null}
                  <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                    👁
                  </a>
                  <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                    ⬇
                  </a>
                  <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                    🗑
                  </button>
                </div>
              </div>
            ))}
            {uploadAssetsVisible < uploadAssets.length ? (
              <button className="text-sm text-accent underline" onClick={() => setUploadAssetsVisible((count: number) => count + 6)}>
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
            {frameAssets.slice(0, frameAssetsVisible).map((item: any, index: number) => (
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
                <div className="flex items-center gap-2 text-sm">
                  {item.customReportRef ? (
                    <label className="flex items-center gap-1 text-xs text-ink/70">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedReportOutputs[`${item.taskId}:${reportOutputRefKey(item.customReportRef)}`])}
                        onChange={() => toggleCustomReportOutput(item.taskId, item.customReportRef as CustomReportOutputRef)}
                      />
                      QC
                    </label>
                  ) : null}
                  <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                    👁
                  </a>
                  <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                    ⬇
                  </a>
                  <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                    🗑
                  </button>
                </div>
              </div>
            ))}
            {frameAssetsVisible < frameAssets.length ? (
              <button className="text-sm text-accent underline" onClick={() => setFrameAssetsVisible((count: number) => count + 6)}>
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
            {outputVideoAssets.slice(0, videoAssetsVisible).map((item: any, index: number) => (
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
                <div className="flex items-center gap-2 text-sm">
                  {item.customReportRef ? (
                    <label className="flex items-center gap-1 text-xs text-ink/70">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedReportOutputs[`${item.taskId}:${reportOutputRefKey(item.customReportRef)}`])}
                        onChange={() => toggleCustomReportOutput(item.taskId, item.customReportRef as CustomReportOutputRef)}
                      />
                      QC
                    </label>
                  ) : null}
                  <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                    👁
                  </a>
                  <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                    ⬇
                  </a>
                  <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                    🗑
                  </button>
                </div>
              </div>
            ))}
            {videoAssetsVisible < outputVideoAssets.length ? (
              <button className="text-sm text-accent underline" onClick={() => setVideoAssetsVisible((count: number) => count + 6)}>
                More...
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

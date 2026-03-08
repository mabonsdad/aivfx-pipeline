import { ReactCompareSlider } from "react-compare-slider";

type GenerateTabProps = {
  ctx: any;
};

export default function GenerateTab({ ctx }: GenerateTabProps) {
  const {
    setGenerationInputMode,
    setLumaModel,
    generationModelByInput,
    generationInputMode,
    selectedSegment,
    describeSegment,
    lumaModel,
    setGenerationModelByInput,
    generationModelOptions,
    advancedMode,
    setAdvancedMode,
    lumaPrompt,
    setLumaPrompt,
    generationInputNote,
    generationHelp,
    selectedSegmentOverLimit,
    lumaHardLimitSeconds,
    selectedSegmentId,
    generateSegmentMutation,
    segmentWindow,
    originalSegmentPreviewUrl,
    selectedPreviewGeneration,
    task,
    compareOriginalRef,
    keepOriginalWithinSegment,
    compareVariantRef,
    syncOriginalToGenerated,
    selectedSegmentGenerations,
    generationCardsVisible,
    truncateIdentifier,
    selectSegmentGeneration,
    describeGeneration,
    generationThumbnailUrl,
    formatCompactTimestamp,
    setVideoPreviewModal,
    handleDeleteAsset,
    setGenerationCardsVisible,
  } = ctx as any;

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Generate Video</h3>
      <div className="rounded-xl border border-ink/15 bg-white">
        <div className="flex items-end gap-1 border-b border-ink/15 px-2 pt-2">
          {[
            { id: "start_video" as const, label: "start frame + video" },
            { id: "start_end" as const, label: "start frame + end frame" },
            { id: "start_only" as const, label: "start frame only" },
          ].map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setGenerationInputMode(entry.id);
                setLumaModel(generationModelByInput[entry.id]);
              }}
              className={`rounded-t-md border px-3 py-2 text-xs ${
                generationInputMode === entry.id
                  ? "-mb-px border-ink/25 border-b-white bg-white font-semibold text-ink"
                  : "border-ink/10 bg-bg text-ink/65"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 p-3 lg:grid-cols-[1.65fr_1fr]">
          <div className="space-y-3">
            <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/70">
              Segment in use: {selectedSegment ? describeSegment(selectedSegment) : "No segment selected. Go to Pick Frame first."}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <select
                value={lumaModel}
                onChange={(e) => {
                  const nextModel = e.target.value as any;
                  setGenerationModelByInput((previous: Record<string, string>) => ({ ...previous, [generationInputMode]: nextModel }));
                  setLumaModel(nextModel);
                }}
                className="rounded-md border border-ink/20 px-3 py-2"
              >
                {generationModelOptions.map((option: { value: string; label: string }) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {lumaModel === "ray-2" || lumaModel === "ray-flash-2" ? (
                <select value={advancedMode} onChange={(e) => setAdvancedMode(e.target.value)} className="rounded-md border border-ink/20 px-3 py-2">
                  {[
                    "adhere_1",
                    "adhere_2",
                    "adhere_3",
                    "flex_1",
                    "flex_2",
                    "flex_3",
                    "reimagine_1",
                    "reimagine_2",
                    "reimagine_3",
                  ].map((mode) => (
                    <option key={mode} value={mode}>
                      mode: {mode}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                  Mode dropdown is only used by Luma models.
                </div>
              )}
            </div>
            {lumaModel === "wan2.2-animate" ? (
              <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                Text prompt is unavailable for Wan2.2 Animate in this flow. Generation uses the selected start frame plus source segment motion.
              </div>
            ) : (
              <textarea
                value={lumaPrompt}
                onChange={(e) => setLumaPrompt(e.target.value)}
                placeholder="Optional generation prompt"
                className="h-20 w-full rounded-md border border-ink/20 p-2"
              />
            )}
            <p className="text-xs text-ink/60">{generationInputNote}</p>
          </div>
          <div className="rounded-lg border border-ink/15 bg-bg p-3">
            <p className="text-sm font-semibold">{generationHelp.title}</p>
            <div className="mt-2 space-y-2 text-xs text-ink/70">
              {generationHelp.lines.map((line: string) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        </div>
      </div>

      {selectedSegmentOverLimit ? (
        <p className="text-xs text-red-600">
          Selected segment is {selectedSegment?.durationSec.toFixed(2)}s, exceeding the {lumaModel} limit of {lumaHardLimitSeconds}s.
        </p>
      ) : null}

      <button
        className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!selectedSegmentId || selectedSegmentOverLimit}
        onClick={() => generateSegmentMutation.mutate()}
      >
        Generate Segment Variant
      </button>

      <div className="space-y-2 rounded-lg border border-ink/10 p-3">
        <p className="font-medium">Video Comparison</p>
        {segmentWindow ? (
          <p className="text-xs text-ink/70">Showing selected segment only: {segmentWindow.startLabel}s to {segmentWindow.endLabel}s.</p>
        ) : null}
        {originalSegmentPreviewUrl && selectedPreviewGeneration?.downloadUrl ? (
          <div
            className="overflow-hidden rounded-md border border-ink/10 bg-bg"
            style={{
              aspectRatio:
                task?.video?.editSource?.width && task?.video?.editSource?.height
                  ? `${task.video.editSource.width} / ${task.video.editSource.height}`
                  : undefined,
            }}
          >
            <ReactCompareSlider
              className="h-full w-full"
              itemOne={
                <video
                  ref={compareOriginalRef}
                  src={originalSegmentPreviewUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-contain"
                  onLoadedMetadata={(e) => {
                    if (segmentWindow) {
                      e.currentTarget.currentTime = segmentWindow.startSec;
                    }
                  }}
                  onTimeUpdate={(e) => keepOriginalWithinSegment(e.currentTarget)}
                />
              }
              itemTwo={
                <video
                  ref={compareVariantRef}
                  src={selectedPreviewGeneration.downloadUrl}
                  controls
                  playsInline
                  preload="none"
                  className="h-full w-full object-contain"
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = 0;
                    syncOriginalToGenerated(e.currentTarget);
                  }}
                  onTimeUpdate={(e) => syncOriginalToGenerated(e.currentTarget)}
                  onSeeking={(e) => syncOriginalToGenerated(e.currentTarget)}
                  onPlay={(e) => {
                    syncOriginalToGenerated(e.currentTarget);
                    compareOriginalRef.current?.play().catch(() => undefined);
                  }}
                  onPause={() => {
                    compareOriginalRef.current?.pause();
                  }}
                />
              }
            />
          </div>
        ) : (
          <p className="text-sm text-ink/60">Select a segment and generated variant to compare.</p>
        )}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {selectedSegmentGenerations.slice(0, generationCardsVisible).map((gen: any, index: number) => (
            <div
              key={gen.genId}
              className={`rounded border p-2 ${
                gen.status === "failed"
                  ? "border-orange-400 bg-orange-50"
                  : selectedPreviewGeneration?.genId === gen.genId
                    ? "border-teal-500 bg-teal-50"
                    : "border-ink/10"
              }`}
            >
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className={`uppercase text-ink/60 ${index === 0 ? "font-semibold" : ""}`}>{gen.status}</span>
                <span className="text-[11px] text-ink/50">{truncateIdentifier(gen.genId, 14)}</span>
              </div>
              <button
                type="button"
                className="block w-full disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!gen.downloadUrl}
                onClick={() => selectSegmentGeneration(gen.genId)}
                title={gen.downloadUrl ? `Use ${describeGeneration(gen)}` : "Video unavailable"}
              >
                {generationThumbnailUrl(gen) ? (
                  <img
                    src={generationThumbnailUrl(gen) as string}
                    alt={describeGeneration(gen)}
                    className="aspect-video w-full rounded-md bg-bg object-contain"
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                    Video thumbnail unavailable
                  </div>
                )}
              </button>
              <p className="mt-2 text-xs font-medium text-ink/80">{gen.luma.model} / {gen.luma.mode}</p>
              <p className="text-[11px] text-ink/60">{formatCompactTimestamp(gen.createdAt)}</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded border border-ink/20 bg-white p-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!gen.downloadUrl}
                  title="Preview"
                  onClick={() => {
                    if (!gen.downloadUrl) return;
                    setVideoPreviewModal({ url: gen.downloadUrl, label: describeGeneration(gen) });
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                {gen.downloadUrl ? (
                  <a
                    href={gen.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    download
                    className="rounded border border-ink/20 bg-white p-2 text-xs"
                    title="Download full quality video"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 3v12" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M4 21h16" />
                    </svg>
                  </a>
                ) : null}
                <button
                  type="button"
                  className="rounded border border-red-200 bg-white p-2 text-xs text-red-700"
                  title="Delete generated video"
                  disabled={!task?.taskId}
                  onClick={() =>
                    handleDeleteAsset({
                      id: `generation:${task?.taskId ?? ""}:${gen.genId}`,
                      taskId: task?.taskId ?? "",
                      title: describeGeneration(gen),
                      subtitle: `${gen.luma.model}/${gen.luma.mode}`,
                      createdAt: gen.createdAt,
                      previewUrl: gen.downloadUrl ?? "",
                      downloadUrl: gen.downloadUrl ?? "",
                      mediaType: "video",
                      deletePayload: { assetType: "segment_generation", genId: gen.genId },
                    })
                  }
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="m6 6 1 14h10l1-14" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
        {generationCardsVisible < selectedSegmentGenerations.length ? (
          <button className="text-sm text-accent underline" onClick={() => setGenerationCardsVisible((count: number) => count + 6)}>
            More...
          </button>
        ) : null}
        {selectedSegmentGenerations.length === 0 ? <p className="text-sm text-ink/60">No generated variants for this segment yet.</p> : null}
      </div>
    </div>
  );
}

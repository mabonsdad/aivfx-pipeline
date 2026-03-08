type ReportsPageProps = {
  ctx: any;
};

type VideoGenerationGroup = "start_video" | "start_end" | "start_only";

export default function ReportsPage({ ctx }: ReportsPageProps) {
  const {
    reportTask,
    reportTaskId,
    sortedJobs,
    selectedOutputRefsByTask,
    reportOutputRefKey,
    reportView,
    setReportView,
    setActiveCustomReportId,
    activeCustomReport,
    setSelectedTaskId,
    setTab,
    logout,
    formatAssetDate,
    truncateIdentifier,
    reportTaskQuery,
    runQcMutation,
    renderCustomReportBox,
    reportCustomReports,
    reportOutputCards,
    toggleCustomReportOutput,
    setVideoPreviewModal,
    setImagePreviewModal,
    formatCompactTimestamp,
    qcFrameRows,
    frameQcForVariant,
    hasFrameQcArtifacts,
    asNumber,
    qcVideoRowsByGroup,
    describeSegment,
    fpsValue,
    reportGraphModal,
    setReportGraphModal,
  } = ctx as any;

  const reportPlaybackUrl = reportTask?.video?.editSource?.downloadUrl ?? reportTask?.video?.original?.downloadUrl ?? null;
  const latestQcJob =
    sortedJobs.find((job: any) => job.type === "qc_analysis" && (!reportTaskId || job.taskId === reportTaskId)) ?? null;
  const selectedRefKeys = new Set(
    reportTaskId ? (selectedOutputRefsByTask[reportTaskId] ?? []).map((ref: any) => reportOutputRefKey(ref)) : [],
  );
  const qcVideoGroupLabels: Record<VideoGenerationGroup, string> = {
    start_video: "Start Frame + Source Video",
    start_end: "Start Frame + End Frame",
    start_only: "Start Frame Only",
  };

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto w-full max-w-[1700px] space-y-4 p-4 md:p-6">
        <div className="flex items-center justify-between rounded-2xl border border-ink/10 bg-card p-4">
          <div>
            <h2 className="text-xl font-semibold">Task Report: {reportTask?.name ?? reportTaskId ?? "Task"}</h2>
            {reportTask ? <p className="text-sm text-ink/60">Updated {formatAssetDate(reportTask.updatedAt)}</p> : null}
            {activeCustomReport ? (
              <p className="text-xs text-ink/60">
                Custom: {activeCustomReport.name} ({activeCustomReport.reportType === "qc_frame" ? "QC Frame" : "QC Video"})
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
              onClick={() => {
                if (reportTaskId) setSelectedTaskId(reportTaskId);
                setTab("timeline");
              }}
            >
              Back to Task
            </button>
            <button onClick={() => logout()} className="text-sm text-ink/60 underline">
              Sign out
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ink/10 bg-card p-3">
          <button
            className={`rounded px-3 py-2 text-sm ${reportView === "outputs" ? "bg-ink text-white" : "bg-ink/10"}`}
            onClick={() => {
              setReportView("outputs");
              setActiveCustomReportId(null);
            }}
          >
            Output Report
          </button>
          <button
            className={`rounded px-3 py-2 text-sm ${reportView === "qc_frame" ? "bg-ink text-white" : "bg-ink/10"}`}
            onClick={() => {
              setReportView("qc_frame");
              if (!activeCustomReport || activeCustomReport.reportType !== "qc_frame") {
                setActiveCustomReportId(null);
              }
            }}
          >
            QC Frame Report
          </button>
          <button
            className={`rounded px-3 py-2 text-sm ${reportView === "qc_video" ? "bg-ink text-white" : "bg-ink/10"}`}
            onClick={() => {
              setReportView("qc_video");
              if (!activeCustomReport || activeCustomReport.reportType !== "qc_video") {
                setActiveCustomReportId(null);
              }
            }}
          >
            QC Video Report
          </button>
        </div>
        {latestQcJob ? (
          <p className="text-xs text-ink/70">
            Latest QC job {truncateIdentifier(latestQcJob.jobId, 12)}: {latestQcJob.status} ({latestQcJob.progress}%)
          </p>
        ) : null}

        {reportTaskQuery.isPending ? <p className="text-sm text-ink/60">Loading report...</p> : null}
        {reportTaskQuery.error ? <p className="text-sm text-red-600">{(reportTaskQuery.error as Error).message}</p> : null}
        {runQcMutation.error ? <p className="text-sm text-red-600">{runQcMutation.error.message}</p> : null}

        {reportTask ? (
          <>
            {renderCustomReportBox(reportTask.taskId, reportCustomReports)}

            {reportView === "outputs" ? (
              <>
                <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                  <h3 className="text-lg font-semibold">Task Playback</h3>
                  {reportPlaybackUrl ? (
                    <video
                      src={reportPlaybackUrl}
                      controls
                      preload="metadata"
                      className="w-full rounded border border-ink/10 bg-bg object-contain"
                    />
                  ) : (
                    <p className="text-sm text-ink/60">Original video not available.</p>
                  )}
                </section>
                {[
                  { title: "Video Generations", items: reportOutputCards.videoGenerations },
                  { title: "Start Frames", items: reportOutputCards.startFrames },
                  { title: "End Frames", items: reportOutputCards.endFrames },
                ].map((section) => (
                  <section key={section.title} className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
                    <h3 className="text-lg font-semibold">{section.title}</h3>
                    {section.items.length === 0 ? (
                      <p className="text-sm text-ink/60">No outputs in this section yet.</p>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {section.items.map((card: any) => (
                          <article key={card.id} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                            <label className="flex items-center gap-2 text-xs text-ink/70">
                              <input
                                type="checkbox"
                                checked={selectedRefKeys.has(reportOutputRefKey(card.selectionRef))}
                                onChange={() => toggleCustomReportOutput(card.taskId, card.selectionRef)}
                              />
                              QC
                            </label>
                            {card.imageUrl ? (
                              <button
                                type="button"
                                className="block w-full"
                                onClick={() => {
                                  if (card.videoUrl) {
                                    setVideoPreviewModal({ url: card.videoUrl, label: card.title });
                                  } else {
                                    setImagePreviewModal({ url: card.imageUrl as string, label: card.title });
                                  }
                                }}
                              >
                                <img
                                  src={card.imageUrl}
                                  alt={card.title}
                                  className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                />
                              </button>
                            ) : card.videoUrl ? (
                              <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                                Preview unavailable
                              </div>
                            ) : (
                              <div className="rounded border border-dashed border-ink/20 p-4 text-sm text-ink/50">
                                Preview unavailable
                              </div>
                            )}
                            <div className="space-y-1">
                              <p className="text-sm font-semibold">{card.title}</p>
                              <p className="text-xs text-ink/70">{card.subtitle}</p>
                              <p className="text-xs text-ink/70">Model: {card.modelLabel}</p>
                              <p className="text-xs text-ink/70">Prompt: {card.promptLabel}</p>
                              <p className="text-[11px] text-ink/50">{formatCompactTimestamp(card.createdAt)}</p>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </>
            ) : null}

            {reportView === "qc_frame" ? (
              <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">QC Frame Report</h3>
                {qcFrameRows.length === 0 ? (
                  <p className="text-sm text-ink/60">No frame edits available for this report scope.</p>
                ) : (
                  <div className="space-y-3">
                    {qcFrameRows.map((row: any) => {
                      const frameQc = row.qcGeneration ? frameQcForVariant(row.qcGeneration.generation, row.variant.variantId) : null;
                      const frameMetrics = frameQc?.metrics as Record<string, unknown> | undefined;
                      const frameArtifacts = frameQc?.artifacts as Record<string, unknown> | undefined;
                      const boundaryOverlayUrl =
                        (frameArtifacts?.boundaryOverlayUrl as string | undefined) ??
                        (frameArtifacts?.binaryChangeUrl as string | undefined);
                      const frameHeatmapUrl = frameArtifacts?.heatmapUrl as string | undefined;
                      const frameOverlayUrl = frameArtifacts?.overlayUrl as string | undefined;
                      const frameBinaryUrl = frameArtifacts?.binaryChangeUrl as string | undefined;
                      const variantPrompt =
                        (row.variant.generationSettings?.prompt as string | undefined) ??
                        row.qcGeneration?.generation.luma.prompt ??
                        `Prompt hash ${truncateIdentifier(row.variant.promptHash, 16)}`;
                      const qcStatus = row.qcGeneration?.generation.qc?.status ?? "not_run";
                      const hasFrameQc = qcStatus === "complete" && hasFrameQcArtifacts(frameQc);
                      return (
                        <article key={row.id} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold">
                              {row.role === "start" ? "Start" : row.role === "end" ? "End" : "Unlinked"} frame edit · frame {row.frame.frameIndex}
                            </p>
                            <label className="flex items-center gap-2 text-xs text-ink/70">
                              <input
                                type="checkbox"
                                checked={selectedRefKeys.has(
                                  reportOutputRefKey({ assetType: "frame_variant", frameId: row.frame.frameId, variantId: row.variant.variantId }),
                                )}
                                onChange={() =>
                                  toggleCustomReportOutput(reportTask.taskId, {
                                    assetType: "frame_variant",
                                    frameId: row.frame.frameId,
                                    variantId: row.variant.variantId,
                                  })
                                }
                              />
                              QC
                            </label>
                          </div>
                          <div className="grid gap-3 md:grid-cols-4">
                            <div>
                              <p className="text-xs font-medium text-ink/70">Original frame</p>
                              {row.frame.imageUrl ? (
                                <img src={row.frame.imageUrl} alt="Original frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <p className="text-xs text-ink/50">Unavailable</p>
                              )}
                              <p className="mt-1 text-[11px] text-ink/70">Model: {row.variant.model} ({row.variant.type})</p>
                              <p className="text-[11px] text-ink/70">Prompt: {variantPrompt}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Mask edit</p>
                              {(row.variant.patchMeta?.maskUrl as string | undefined) ? (
                                <img src={row.variant.patchMeta?.maskUrl as string} alt="Mask" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <p className="text-xs text-ink/50">No mask</p>
                              )}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-ink/70">Edited frame</p>
                              {row.variant.imageUrl ? (
                                <img src={row.variant.imageUrl} alt="Edited frame" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <p className="text-xs text-ink/50">Unavailable</p>
                              )}
                            </div>
                            <div className="rounded border border-ink/10 bg-bg/40 p-2 text-xs text-ink/70">
                              <p className="font-semibold text-ink/90">Frame QC analysis</p>
                              {hasFrameQc ? (
                                <>
                                  <p>Changed: {asNumber(frameMetrics?.changedPctTotal)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Outside leakage: {asNumber(frameMetrics?.outsideLeakagePct)?.toFixed(2) ?? "n/a"}%</p>
                                  <p>Boundary spill: {asNumber(frameMetrics?.boundarySpillPct)?.toFixed(2) ?? "n/a"}%</p>
                                  {boundaryOverlayUrl ? (
                                    <button
                                      type="button"
                                      className="mt-2 underline"
                                      onClick={() => setImagePreviewModal({ url: boundaryOverlayUrl, label: "Frame QC boundary overlay" })}
                                    >
                                      Open boundary overlay
                                    </button>
                                  ) : null}
                                </>
                              ) : (
                                <p>
                                  {qcStatus === "running"
                                    ? "QC is running..."
                                    : qcStatus === "failed"
                                      ? `QC failed: ${row.qcGeneration?.generation.qc?.error ?? "unknown"}`
                                      : "No frame QC evidence for this edit frame yet."}
                                </p>
                              )}
                            </div>
                          </div>
                          {hasFrameQc ? (
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Frame diff heatmap</p>
                                {frameHeatmapUrl ? (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    onClick={() => setImagePreviewModal({ url: frameHeatmapUrl, label: "Frame QC heatmap" })}
                                  >
                                    <img src={frameHeatmapUrl} alt="Frame diff heatmap" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No heatmap</p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Frame diff overlay</p>
                                {frameOverlayUrl ? (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    onClick={() => setImagePreviewModal({ url: frameOverlayUrl, label: "Frame QC overlay" })}
                                  >
                                    <img src={frameOverlayUrl} alt="Frame diff overlay" className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain" />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No overlay</p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-ink/70">Boundary/Binary map</p>
                                {boundaryOverlayUrl || frameBinaryUrl ? (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    onClick={() =>
                                      setImagePreviewModal({
                                        url: (boundaryOverlayUrl ?? frameBinaryUrl) as string,
                                        label: "Frame QC boundary/binary map",
                                      })
                                    }
                                  >
                                    <img
                                      src={(boundaryOverlayUrl ?? frameBinaryUrl) as string}
                                      alt="Frame QC boundary or binary map"
                                      className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                    />
                                  </button>
                                ) : (
                                  <p className="text-xs text-ink/50">No boundary or binary map</p>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}

            {reportView === "qc_video" ? (
              <section className="space-y-3 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">QC Video Report</h3>
                {(["start_video", "start_end", "start_only"] as VideoGenerationGroup[]).map((group) => {
                  const rows = qcVideoRowsByGroup[group];
                  return (
                    <div key={group} className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                      <h4 className="text-base font-semibold">{qcVideoGroupLabels[group]}</h4>
                      {rows.length === 0 ? (
                        <p className="text-sm text-ink/60">No generations in this category.</p>
                      ) : (
                        <div className="space-y-3">
                          {rows.map((row: any) => {
                            const videoAggregates = row.generation.qc?.video?.aggregates as Record<string, unknown> | undefined;
                            const videoArtifacts = row.generation.qc?.video?.artifacts;
                            const qcStatus = row.generation.qc?.status ?? "not_run";
                            const firstFrameMetrics = (videoAggregates?.firstFrame as Record<string, unknown> | undefined) ?? undefined;
                            const lastFrameMetrics = (videoAggregates?.lastFrame as Record<string, unknown> | undefined) ?? undefined;
                            const timelineGraphUrl = videoArtifacts?.timelineGraphUrl as string | undefined;
                            const timelineCsvUrl = videoArtifacts?.timelineCsvUrl as string | undefined;
                            const reportJsonUrl = videoArtifacts?.reportJsonUrl as string | undefined;
                            const diffVideoUrl = videoArtifacts?.diffVideoUrl as string | undefined;
                            const selectedFrames = (row.generation.qc?.video?.selectedFrames ?? []).slice(0, 6);
                            const fps = Math.max(1, fpsValue(reportTask));
                            const startCaptureMismatch =
                              row.startFrame?.captureKey &&
                              row.generation.sourceFirstFrameCaptureKey &&
                              row.startFrame.captureKey !== row.generation.sourceFirstFrameCaptureKey;
                            const endCaptureMismatch =
                              row.endFrame?.captureKey &&
                              row.generation.sourceLastFrameCaptureKey &&
                              row.endFrame.captureKey !== row.generation.sourceLastFrameCaptureKey;
                            return (
                              <article key={row.generation.genId} className="space-y-2 rounded border border-ink/10 bg-bg/30 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-sm font-semibold">
                                    {row.segment ? `${row.segment.segmentId} · ${describeSegment(row.segment)}` : row.generation.segmentId}
                                  </p>
                                  <label className="flex items-center gap-2 text-xs text-ink/70">
                                    <input
                                      type="checkbox"
                                      checked={selectedRefKeys.has(reportOutputRefKey({ assetType: "segment_generation", genId: row.generation.genId }))}
                                      onChange={() =>
                                        toggleCustomReportOutput(reportTask.taskId, {
                                          assetType: "segment_generation",
                                          genId: row.generation.genId,
                                        })
                                      }
                                    />
                                    QC
                                  </label>
                                </div>
                                <p className="text-xs text-ink/60">
                                  Relationships: generation {truncateIdentifier(row.generation.genId, 12)} · start frame{" "}
                                  {row.startFrame ? `${row.startFrame.frameId}` : "n/a"} · end frame {row.endFrame ? `${row.endFrame.frameId}` : "n/a"}
                                </p>
                                {startCaptureMismatch || endCaptureMismatch ? (
                                  <p className="text-xs text-red-600">
                                    Relationship warning: source capture keys differ from current segment boundary frames.
                                  </p>
                                ) : null}
                                <div className="grid gap-3 lg:grid-cols-2">
                                  <div>
                                    <p className="text-xs font-medium text-ink/70">Original segment video</p>
                                    {row.segment && reportPlaybackUrl ? (
                                      <video
                                        src={`${reportPlaybackUrl}#t=${(row.segment.startFrame / fps).toFixed(3)},${(row.segment.endFrameExclusive / fps).toFixed(3)}`}
                                        controls
                                        preload="none"
                                        className="w-full rounded border border-ink/10 bg-bg object-contain"
                                      />
                                    ) : (
                                      <p className="text-xs text-ink/50">Unavailable</p>
                                    )}
                                  </div>
                                  <div>
                                    <p className="text-xs font-medium text-ink/70">Generated segment video</p>
                                    {row.generatedVideoUrl ? (
                                      <video
                                        src={row.generatedVideoUrl}
                                        controls
                                        preload="none"
                                        className="w-full rounded border border-ink/10 bg-bg object-contain"
                                      />
                                    ) : (
                                      <p className="text-xs text-ink/50">Unavailable</p>
                                    )}
                                  </div>
                                </div>
                                <div className="grid gap-2 md:grid-cols-2">
                                  <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                                    <p className="font-semibold text-ink/90">Video QC analysis</p>
                                    {qcStatus === "complete" ? (
                                      <>
                                        <p>Changed mean: {asNumber(videoAggregates?.changedPctTotalMean)?.toFixed(2) ?? "n/a"}%</p>
                                        <p>Outside mean: {asNumber(videoAggregates?.outsideLeakagePctMean)?.toFixed(2) ?? "n/a"}%</p>
                                        <p>SSIM: {asNumber(videoAggregates?.ssimMean)?.toFixed(4) ?? "n/a"}</p>
                                        <p>PSNR: {asNumber(videoAggregates?.psnrMean)?.toFixed(2) ?? "n/a"} dB</p>
                                      </>
                                    ) : (
                                      <p>
                                        {qcStatus === "running"
                                          ? "QC analysis running..."
                                          : qcStatus === "failed"
                                            ? `QC failed: ${row.generation.qc?.error ?? "unknown"}`
                                            : "No QC data yet."}
                                      </p>
                                    )}
                                  </div>
                                  <div className="rounded border border-ink/10 bg-white p-2 text-xs text-ink/70">
                                    <p className="font-semibold text-ink/90">First/Last frame comparison</p>
                                    <p>
                                      First:{" "}
                                      {firstFrameMetrics
                                        ? `${asNumber(firstFrameMetrics.changedPctTotal)?.toFixed(2) ?? "n/a"}% changed`
                                        : "n/a"}
                                    </p>
                                    <p>
                                      Last:{" "}
                                      {lastFrameMetrics
                                        ? `${asNumber(lastFrameMetrics.changedPctTotal)?.toFixed(2) ?? "n/a"}% changed`
                                        : "n/a"}
                                    </p>
                                    {timelineGraphUrl ? (
                                      <button
                                        type="button"
                                        className="mt-2 underline"
                                        onClick={() =>
                                          setReportGraphModal({ url: timelineGraphUrl, label: `QC timeline: ${row.generation.genId}` })
                                        }
                                      >
                                        Open timeline graph
                                      </button>
                                    ) : null}
                                    {timelineCsvUrl ? (
                                      <a href={timelineCsvUrl} target="_blank" rel="noreferrer" className="mt-1 block underline">
                                        Download timeline CSV
                                      </a>
                                    ) : null}
                                    {reportJsonUrl ? (
                                      <a href={reportJsonUrl} target="_blank" rel="noreferrer" className="mt-1 block underline">
                                        Open full QC report JSON
                                      </a>
                                    ) : null}
                                    {diffVideoUrl ? (
                                      <button
                                        type="button"
                                        className="mt-1 block underline"
                                        onClick={() => setVideoPreviewModal({ url: diffVideoUrl, label: `Diff video ${row.generation.genId}` })}
                                      >
                                        Open diff video
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                  <div className="space-y-1">
                                    <p className="text-xs font-medium text-ink/70">Timeline graph</p>
                                    {timelineGraphUrl ? (
                                      <button
                                        type="button"
                                        className="block w-full"
                                        onClick={() => setReportGraphModal({ url: timelineGraphUrl, label: `QC timeline: ${row.generation.genId}` })}
                                      >
                                        <img
                                          src={timelineGraphUrl}
                                          alt="QC timeline graph"
                                          className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                        />
                                      </button>
                                    ) : (
                                      <p className="text-xs text-ink/50">No timeline graph</p>
                                    )}
                                  </div>
                                  <div className="space-y-1">
                                    <p className="text-xs font-medium text-ink/70">Diff map video</p>
                                    {diffVideoUrl ? (
                                      <video
                                        src={diffVideoUrl}
                                        controls
                                        preload="none"
                                        className="w-full rounded border border-ink/10 bg-bg object-contain"
                                      />
                                    ) : (
                                      <p className="text-xs text-ink/50">No diff map video</p>
                                    )}
                                  </div>
                                </div>
                                {selectedFrames.length ? (
                                  <div className="space-y-2">
                                    <p className="text-xs font-medium text-ink/70">Selected frame diff artifacts</p>
                                    <div className="grid gap-3 md:grid-cols-3">
                                      {selectedFrames.map((frame: any) => {
                                        const frameOverlayUrl =
                                          (frame.overlayUrl as string | undefined) ??
                                          ((frame as Record<string, unknown>).boundaryOverlayUrl as string | undefined);
                                        return (
                                          <div key={`${row.generation.genId}:selected:${frame.index}`} className="space-y-1 rounded border border-ink/10 bg-white p-2">
                                            <p className="text-[11px] text-ink/60">
                                              f{frame.index} · t={frame.timeSec}s
                                            </p>
                                            {frameOverlayUrl ? (
                                              <button
                                                type="button"
                                                className="block w-full"
                                                onClick={() => setImagePreviewModal({ url: frameOverlayUrl, label: `Overlay frame ${frame.index}` })}
                                              >
                                                <img
                                                  src={frameOverlayUrl}
                                                  alt={`Frame ${frame.index} diff overlay`}
                                                  className="aspect-video w-full rounded border border-ink/10 bg-bg object-contain"
                                                />
                                              </button>
                                            ) : (
                                              <p className="text-xs text-ink/50">Overlay unavailable</p>
                                            )}
                                            <div className="flex flex-wrap gap-2 text-[11px] text-ink/70">
                                              {frame.heatmapUrl ? (
                                                <a href={frame.heatmapUrl} target="_blank" rel="noreferrer" className="underline">
                                                  Heatmap
                                                </a>
                                              ) : null}
                                              {frameOverlayUrl ? (
                                                <a href={frameOverlayUrl} target="_blank" rel="noreferrer" className="underline">
                                                  Overlay
                                                </a>
                                              ) : null}
                                              {frame.binaryChangeUrl ? (
                                                <a href={frame.binaryChangeUrl} target="_blank" rel="noreferrer" className="underline">
                                                  Binary
                                                </a>
                                              ) : null}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
      {reportGraphModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setReportGraphModal(null)}>
          <div className="relative w-[92vw] max-w-6xl rounded-lg border border-ink/20 bg-white p-3" onClick={(event) => event.stopPropagation()}>
            <button className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={() => setReportGraphModal(null)}>
              x
            </button>
            <img src={reportGraphModal.url} alt={reportGraphModal.label} className="w-full rounded object-contain" />
          </div>
        </div>
      ) : null}
    </main>
  );
}

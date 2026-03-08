type PickFrameTabProps = {
  ctx: any;
};

export default function PickFrameTab({ ctx }: PickFrameTabProps) {
  const {
    timelinePlaybackUrl,
    timelineVideoRef,
    frameCount,
    task,
    fpsValue,
    currentFrameIndex,
    setCurrentFrameIndex,
    FrameSelectCard,
    firstFrame,
    captureCurrentFrameFor,
    setFirstFrameId,
    timelineDelta,
    hasHardDurationLimit,
    lumaHardLimitFrames,
    lumaHardLimitSeconds,
    lastFrame,
    setLastFrameId,
    selectedRange,
    lumaModel,
    selectedSegmentId,
    setSelectedSegmentId,
  } = ctx as any;

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Pick Frame & Segment Selection</h3>
      <div className="grid gap-3 lg:grid-cols-[1fr_180px]">
        {timelinePlaybackUrl ? (
          <div className="w-fit max-w-full">
            <video
              ref={timelineVideoRef}
              className="max-h-[360px] max-w-full rounded-lg border border-ink/10"
              src={timelinePlaybackUrl}
              controls
              preload="metadata"
              onTimeUpdate={(e) => {
                const totalFrames = frameCount(task);
                if (!totalFrames) return;
                const fps = fpsValue(task);
                const nextFrame = Math.max(0, Math.min(totalFrames - 1, Math.round(e.currentTarget.currentTime * fps)));
                if (nextFrame !== currentFrameIndex) {
                  setCurrentFrameIndex(nextFrame);
                }
              }}
            />
          </div>
        ) : (
          <p className="text-sm text-ink/70">Ingest must complete before timeline is available.</p>
        )}
        <div className="rounded-lg border border-ink/15 bg-bg p-3 text-xs text-ink/70 whitespace-pre-line">
          {
            "To select the segment of video that you want AI to edit or add effects to:\n\nPlay and pause the video or use the slider to pick the start frame, then click the Select Start Frame button\n\nDo the same but for the End Frame\n\nMoving to the next step saves the segment."
          }
        </div>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium">Current frame: {currentFrameIndex}</label>
        <input
          type="range"
          min={0}
          max={Math.max(0, frameCount(task) - 1)}
          value={currentFrameIndex}
          onChange={(e) => setCurrentFrameIndex(Number(e.target.value))}
          className="w-full"
        />
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
        <FrameSelectCard
          title="Start Frame"
          frame={firstFrame}
          selectLabel="Select Start Frame"
          onSelect={() => captureCurrentFrameFor("first")}
          onClear={() => setFirstFrameId(null)}
        />

        <div className="flex w-24 flex-col items-center justify-center text-center">
          <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>{timelineDelta.frames} frames</p>
          <p className="my-1 text-xl text-ink/70">→</p>
          <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>{timelineDelta.seconds.toFixed(2)}s</p>
          <p className="mt-1 text-[10px] text-ink/50">
            {hasHardDurationLimit ? `limit ${lumaHardLimitFrames}f / ${lumaHardLimitSeconds}s` : "Runway input constrained by 64MB"}
          </p>
        </div>

        <FrameSelectCard
          title="End Frame"
          frame={lastFrame}
          selectLabel="Select End Frame"
          onSelect={() => captureCurrentFrameFor("last")}
          onClear={() => setLastFrameId(null)}
        />
      </div>

      {selectedRange ? (
        <div className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
          <p className={`text-xs ${selectedRange.overLimit ? "text-red-600" : "text-ink/70"}`}>
            Selected range: {selectedRange.startFrame} {"->"} {selectedRange.endFrameInclusive} ({selectedRange.durationFrames} frames /{" "}
            {selectedRange.durationSec.toFixed(2)}s)
          </p>
          {selectedRange.overLimit ? (
            <p className="text-xs text-red-600">
              This exceeds the current model limit ({lumaHardLimitSeconds}s for {lumaModel}). You can still save the segment, but generation will be
              blocked until under the hard limit.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2">
        <p className="text-sm font-medium text-ink/80">Available segments - click to reuse a segment</p>
        {task?.segments.map((seg: any) => (
          <button
            key={seg.segmentId}
            onClick={() => {
              setSelectedSegmentId(seg.segmentId);
              setCurrentFrameIndex(seg.startFrame);
              setFirstFrameId(seg.startFrameId);
              setLastFrameId(seg.endFrameId);
            }}
            className={`rounded-lg border p-3 text-left ${seg.segmentId === selectedSegmentId ? "border-accent bg-accent/10" : "border-ink/10"}`}
          >
            <p className="font-medium">{seg.segmentId}</p>
            <p className="text-sm text-ink/70">
              {seg.startFrame} {"->"} {seg.endFrameExclusive} ({seg.durationSec}s)
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

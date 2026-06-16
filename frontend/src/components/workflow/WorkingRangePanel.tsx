import type { ReactNode } from "react";

import type { SegmentRecord } from "../../types/api";
import WaveformPreview from "./WaveformPreview";

type WorkingRangeNoticeTone = "neutral" | "warning";

export function WorkingRangeNotice({
  title,
  body,
  tone = "neutral",
  actions,
}: {
  title: string;
  body: ReactNode;
  tone?: WorkingRangeNoticeTone;
  actions?: ReactNode;
}) {
  const toneClass =
    tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-950"
      : "border-ink/15 bg-bg text-ink";
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-1 text-sm opacity-80">{body}</div>
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function WorkingRangeSummary({
  label,
  value,
  warning,
}: {
  label: string;
  value: ReactNode;
  warning?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/70">
        <span className="font-medium text-ink/80">{label}</span> {value}
      </div>
      {warning ? <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{warning}</div> : null}
    </div>
  );
}

export function WorkingRangeOptionCard({
  title,
  subtitle,
  note,
  selected,
  badge,
  onClick,
}: {
  title: string;
  subtitle: ReactNode;
  note?: ReactNode;
  selected?: boolean;
  badge?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition ${
        selected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white hover:border-ink/20"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-ink">{title}</p>
        {badge ? <div className="flex items-center gap-2 text-xs font-semibold">{badge}</div> : null}
      </div>
      <div className="mt-1 text-sm text-ink/70">{subtitle}</div>
      {note ? <div className="mt-1 text-xs text-amber-700">{note}</div> : null}
    </button>
  );
}

export function segmentRangeLabel(segment: SegmentRecord) {
  return `${segment.startFrame} -> ${Math.max(segment.endFrameExclusive - 1, segment.startFrame)} (${segment.durationSec.toFixed(2)}s)`;
}

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.00";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  const wholeSeconds = Math.floor(remaining);
  const hundredths = Math.round((remaining - wholeSeconds) * 100);
  const normalizedHundredths = hundredths === 100 ? 0 : hundredths;
  const normalizedWholeSeconds = hundredths === 100 ? wholeSeconds + 1 : wholeSeconds;
  const finalMinutes = normalizedWholeSeconds === 60 ? minutes + 1 : minutes;
  const finalSeconds = normalizedWholeSeconds === 60 ? 0 : normalizedWholeSeconds;
  return `${String(finalMinutes).padStart(2, "0")}:${String(finalSeconds).padStart(2, "0")}.${String(normalizedHundredths).padStart(2, "0")}`;
}

type WorkingReferenceAsset = {
  label: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  posterUrl?: string | null;
  audioUrl?: string | null;
  waveformUrl?: string | null;
  rangeStartRatio?: number | null;
  rangeEndRatio?: number | null;
  rangeStartLabel?: string | null;
  rangeEndLabel?: string | null;
  actionLabel?: string;
  actionId?: string;
  actions?: Array<{
    label: string;
    actionId: string;
    disabled?: boolean;
  }>;
  selected?: boolean;
};

export function CurrentWorkingReferencePanel({
  title = "Current working references",
  segment,
  startFrameImageUrl,
  endFrameImageUrl,
  warning,
  assets,
  sourceMediaKind = "video",
  sourceFrameCount,
  sourceFps,
  headerAction,
  onPreviewImage,
  onPreviewVideo,
  onPreviewAudio,
  onAssetAction,
}: {
  title?: string;
  segment: SegmentRecord | null;
  startFrameImageUrl?: string | null;
  endFrameImageUrl?: string | null;
  warning?: ReactNode;
  assets?: WorkingReferenceAsset[];
  sourceMediaKind?: "video" | "audio" | "scene";
  sourceFrameCount?: number | null;
  sourceFps?: number | null;
  headerAction?: ReactNode;
  onPreviewImage?: (payload: { url: string; label: string }) => void;
  onPreviewVideo?: (payload: { url: string; label: string }) => void;
  onPreviewAudio?: (payload: { url: string; label: string; waveformUrl?: string | null }) => void;
  onAssetAction?: (asset: WorkingReferenceAsset) => void;
}) {
  const isSceneOnly = sourceMediaKind === "scene";
  const visibleAssets = (assets ?? []).filter((asset) => asset.imageUrl || asset.videoUrl || asset.audioUrl);

  if (isSceneOnly && !segment) {
    return (
      <div className="rounded-lg border border-ink/10 bg-white p-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-4">
          <div className="flex min-h-[7.25rem] min-w-[4.4rem] items-center self-start">
            <div className="flex flex-col text-sm font-semibold leading-tight text-ink">
              <span>Current</span>
              <span>Working</span>
              <span>References</span>
            </div>
          </div>
          {visibleAssets.length ? (
            visibleAssets.map((asset) => {
              const thumbClass = "h-[4.5rem] w-[6.7rem] rounded border border-ink/10 bg-bg object-contain";
              const cardClass = "min-w-[6.7rem]";
              return (
                <div key={asset.label} className={cardClass}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-xs font-medium text-ink/65">{asset.label}</p>
                      {asset.selected ? <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-teal-700">Current</span> : null}
                    </div>
                    {asset.actionLabel && onAssetAction ? (
                      <button
                        type="button"
                        className="shrink-0 text-xs font-medium text-ink/65 underline decoration-ink/30 underline-offset-2 transition hover:text-ink"
                        onClick={() => onAssetAction(asset)}
                      >
                        {asset.actionLabel}
                      </button>
                    ) : null}
                  </div>
                  {asset.imageUrl ? (
                    <button type="button" className="block" onClick={() => onPreviewImage?.({ url: asset.imageUrl!, label: asset.label })}>
                      <img src={asset.imageUrl} alt={asset.label} className={thumbClass} loading="lazy" decoding="async" />
                    </button>
                  ) : asset.videoUrl ? (
                    <button type="button" className="block" onClick={() => onPreviewVideo?.({ url: asset.videoUrl!, label: asset.label })}>
                      <video src={asset.videoUrl} poster={asset.posterUrl ?? undefined} className={`${thumbClass} bg-black`} preload="metadata" muted playsInline />
                    </button>
                  ) : null}
                  {asset.actions?.length && onAssetAction ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {asset.actions.map((action) => (
                        <button
                          key={action.actionId}
                          type="button"
                          disabled={Boolean(action.disabled)}
                          className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => onAssetAction({ ...asset, actionId: action.actionId })}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="flex min-h-[7.25rem] items-center">
              <p className="text-sm text-ink/60">No working references selected.</p>
            </div>
          )}
          {headerAction ? <div className="flex min-h-[7.25rem] shrink-0 items-center self-start">{headerAction}</div> : null}
        </div>
        {warning ? <div className="mt-3 text-xs text-amber-700">{warning}</div> : null}
      </div>
    );
  }

  if (!segment) {
    return (
      <div className="rounded-lg border border-ink/10 bg-white p-3">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-2 text-sm text-ink/60">No working range selected.</p>
      </div>
    );
  }

  const endFrame = Math.max(segment.endFrameExclusive - 1, segment.startFrame);
  const primaryAudioAsset = sourceMediaKind === "audio" ? visibleAssets.find((asset) => asset.audioUrl) ?? null : null;
  const nonAudioAssets = sourceMediaKind === "audio" ? visibleAssets.filter((asset) => asset !== primaryAudioAsset) : visibleAssets;
  const thumbClass = "h-[4.5rem] w-[6.7rem] rounded border border-ink/10 bg-bg object-contain";
  const audioThumbClass = "h-[4.5rem] w-[16rem] rounded border border-ink/10 bg-bg object-contain";
  const cardClass = "min-w-[6.7rem]";
  const startLabel = sourceMediaKind === "audio" ? `Start ${segment.startTimecode}` : `Start f${segment.startFrame}`;
  const endLabel = sourceMediaKind === "audio" ? `End ${segment.endTimecode}` : `End f${endFrame}`;
  const startPreviewLabel = sourceMediaKind === "audio" ? `Start point ${segment.startTimecode}` : `Start frame f${segment.startFrame}`;
  const endPreviewLabel = sourceMediaKind === "audio" ? `End point ${segment.endTimecode}` : `End frame f${endFrame}`;
  const selectedRangeStartRatio =
    sourceMediaKind === "audio" && sourceFrameCount && sourceFrameCount > 0 ? segment.startFrame / sourceFrameCount : null;
  const selectedRangeEndRatio =
    sourceMediaKind === "audio" && sourceFrameCount && sourceFrameCount > 0 ? segment.endFrameExclusive / sourceFrameCount : null;
  const audioStartLabel =
    sourceMediaKind === "audio" && sourceFps && sourceFps > 0 ? formatAudioTime(segment.startFrame / sourceFps) : segment.startTimecode;
  const audioEndLabel =
    sourceMediaKind === "audio" && sourceFps && sourceFps > 0 ? formatAudioTime(segment.endFrameExclusive / sourceFps) : segment.endTimecode;

  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-[4.4rem] flex-col pt-1 text-sm font-semibold leading-tight text-ink">
          <span>Current</span>
          <span>Working</span>
          <span>References</span>
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        {isSceneOnly ? null : sourceMediaKind === "audio" ? (
          <div className="w-[16rem] max-w-full">
            <p className="mb-1 text-xs font-medium text-ink/65">Audio range</p>
            {startFrameImageUrl ? (
              <button
                type="button"
                className="block max-w-full"
                onClick={() => {
                  if (primaryAudioAsset?.audioUrl) {
                    onPreviewAudio?.({
                      url: primaryAudioAsset.audioUrl,
                      label: "Audio range",
                      waveformUrl: primaryAudioAsset.waveformUrl ?? startFrameImageUrl ?? endFrameImageUrl ?? null,
                    });
                    return;
                  }
                  onPreviewImage?.({ url: startFrameImageUrl, label: startPreviewLabel });
                }}
              >
                <div className="relative">
                  <WaveformPreview
                    src={startFrameImageUrl}
                    alt="Audio range"
                    className={audioThumbClass}
                    imageClassName={audioThumbClass}
                    rangeStartRatio={primaryAudioAsset?.rangeStartRatio ?? selectedRangeStartRatio}
                    rangeEndRatio={primaryAudioAsset?.rangeEndRatio ?? selectedRangeEndRatio}
                    rangeStartLabel={primaryAudioAsset?.rangeStartLabel ?? audioStartLabel}
                    rangeEndLabel={primaryAudioAsset?.rangeEndLabel ?? audioEndLabel}
                  />
                  <div className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center">
                    <span className="rounded border border-teal-200 bg-white px-2 py-1 text-xs font-semibold text-teal-700 shadow-sm">
                      {segment.durationSec.toFixed(2)}s
                    </span>
                  </div>
                </div>
              </button>
            ) : (
              <div className={`flex ${audioThumbClass} items-center justify-center text-xs text-ink/45`}>No preview</div>
            )}
          </div>
        ) : (
          <>
            <div className={cardClass}>
              <p className="mb-1 text-xs font-medium text-ink/65">{startLabel}</p>
              {startFrameImageUrl ? (
                <button type="button" className="block" onClick={() => onPreviewImage?.({ url: startFrameImageUrl, label: startPreviewLabel })}>
                  <img
                    src={startFrameImageUrl}
                    alt={startLabel}
                    className={thumbClass}
                    loading="lazy"
                    decoding="async"
                  />
                </button>
              ) : (
                <div className={`flex ${thumbClass} items-center justify-center text-xs text-ink/45`}>No preview</div>
              )}
            </div>
            <div className="flex min-w-[5.1rem] flex-col items-center justify-center px-0 pt-5 text-center text-xs text-ink/65">
              <p>{`${segment.durationFrames} frames`}</p>
              <div className="my-1.5 text-sm text-ink/45">→</div>
              <p>{segment.durationSec.toFixed(2)}s</p>
            </div>
            <div className={cardClass}>
              <p className="mb-1 text-xs font-medium text-ink/65">{endLabel}</p>
              {endFrameImageUrl ? (
                <button type="button" className="block" onClick={() => onPreviewImage?.({ url: endFrameImageUrl, label: endPreviewLabel })}>
                  <img
                    src={endFrameImageUrl}
                    alt={endLabel}
                    className={thumbClass}
                    loading="lazy"
                    decoding="async"
                  />
                </button>
              ) : (
                <div className={`flex ${thumbClass} items-center justify-center text-xs text-ink/45`}>No preview</div>
              )}
            </div>
          </>
        )}
        {!isSceneOnly && nonAudioAssets.length ? <div className="h-[4.5rem] w-px self-end bg-ink/10" /> : null}
        {nonAudioAssets.map((asset) => (
          <div key={asset.label} className={cardClass}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-xs font-medium text-ink/65">{asset.label}</p>
                {asset.selected ? <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-teal-700">Current</span> : null}
              </div>
              {asset.actionLabel && onAssetAction ? (
                <button
                  type="button"
                  className="shrink-0 text-xs font-medium text-ink/65 underline decoration-ink/30 underline-offset-2 transition hover:text-ink"
                  onClick={() => onAssetAction(asset)}
                >
                  {asset.actionLabel}
                </button>
              ) : null}
            </div>
            {asset.videoUrl ? (
              <button type="button" className="block" onClick={() => onPreviewVideo?.({ url: asset.videoUrl!, label: asset.label })}>
                <video
                  src={asset.videoUrl}
                  poster={asset.posterUrl ?? undefined}
                  className={`${thumbClass} bg-black`}
                  preload="metadata"
                  muted
                  playsInline
                />
              </button>
            ) : asset.audioUrl ? (
              <button
                type="button"
                className="block"
                onClick={() => onPreviewAudio?.({ url: asset.audioUrl!, label: asset.label, waveformUrl: asset.waveformUrl ?? asset.imageUrl ?? null })}
              >
                {asset.waveformUrl || asset.imageUrl ? (
                  <WaveformPreview
                    src={(asset.waveformUrl ?? asset.imageUrl) as string}
                    alt={asset.label}
                    className={thumbClass}
                    imageClassName={thumbClass}
                    rangeStartRatio={asset.rangeStartRatio ?? selectedRangeStartRatio}
                    rangeEndRatio={asset.rangeEndRatio ?? selectedRangeEndRatio}
                    rangeStartLabel={asset.rangeStartLabel ?? segment.startTimecode}
                    rangeEndLabel={asset.rangeEndLabel ?? segment.endTimecode}
                  />
                ) : (
                  <div className={`flex ${thumbClass} items-center justify-center text-xs text-ink/45`}>Audio</div>
                )}
              </button>
            ) : asset.imageUrl ? (
              <button type="button" className="block" onClick={() => onPreviewImage?.({ url: asset.imageUrl!, label: asset.label })}>
                <img
                  src={asset.imageUrl}
                  alt={asset.label}
                  className={thumbClass}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ) : null}
            {asset.actions?.length && onAssetAction ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {asset.actions.map((action) => (
                  <button
                    key={action.actionId}
                    type="button"
                    disabled={Boolean(action.disabled)}
                    className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px] text-ink/70 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => onAssetAction({ ...asset, actionId: action.actionId })}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {warning ? <div className="mt-3 text-xs text-amber-700">{warning}</div> : null}
    </div>
  );
}

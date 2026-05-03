import type { ReactNode } from "react";

import type { SegmentRecord } from "../../types/api";

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

type WorkingReferenceAsset = {
  label: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  posterUrl?: string | null;
};

export function CurrentWorkingReferencePanel({
  title = "Current Work References",
  segment,
  startFrameImageUrl,
  endFrameImageUrl,
  warning,
  assets,
  onPreviewImage,
  onPreviewVideo,
}: {
  title?: string;
  segment: SegmentRecord | null;
  startFrameImageUrl?: string | null;
  endFrameImageUrl?: string | null;
  warning?: ReactNode;
  assets?: WorkingReferenceAsset[];
  onPreviewImage?: (payload: { url: string; label: string }) => void;
  onPreviewVideo?: (payload: { url: string; label: string }) => void;
}) {
  if (!segment) {
    return (
      <div className="rounded-lg border border-ink/10 bg-white p-3">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-2 text-sm text-ink/60">No working range selected.</p>
      </div>
    );
  }

  const endFrame = Math.max(segment.endFrameExclusive - 1, segment.startFrame);
  const visibleAssets = (assets ?? []).filter((asset) => asset.imageUrl || asset.videoUrl);
  const thumbClass = "h-20 w-32 rounded border border-ink/10 bg-bg object-contain";
  const cardClass = "min-w-[8rem]";

  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-[4.25rem] flex-col pt-1 text-sm font-semibold leading-tight text-ink">
          <span>Current</span>
          <span>Work</span>
          <span>References</span>
        </div>
        <div className={cardClass}>
          <p className="mb-1 text-xs font-medium text-ink/65">Start f{segment.startFrame}</p>
          {startFrameImageUrl ? (
            <button type="button" className="block" onClick={() => onPreviewImage?.({ url: startFrameImageUrl, label: `Start frame f${segment.startFrame}` })}>
              <img
                src={startFrameImageUrl}
                alt={`Start frame ${segment.startFrame}`}
                className={thumbClass}
                loading="lazy"
                decoding="async"
              />
            </button>
          ) : (
            <div className={`flex ${thumbClass} items-center justify-center text-xs text-ink/45`}>No preview</div>
          )}
        </div>
        <div className="flex min-w-[6.5rem] flex-col items-center justify-center px-0 pt-6 text-center text-xs text-ink/65">
          <p>{segment.durationFrames} frames</p>
          <div className="my-2 text-sm text-ink/45">→</div>
          <p>{segment.durationSec.toFixed(2)}s</p>
        </div>
        <div className={cardClass}>
          <p className="mb-1 text-xs font-medium text-ink/65">End f{endFrame}</p>
          {endFrameImageUrl ? (
            <button type="button" className="block" onClick={() => onPreviewImage?.({ url: endFrameImageUrl, label: `End frame f${endFrame}` })}>
              <img
                src={endFrameImageUrl}
                alt={`End frame ${endFrame}`}
                className={thumbClass}
                loading="lazy"
                decoding="async"
              />
            </button>
          ) : (
            <div className={`flex ${thumbClass} items-center justify-center text-xs text-ink/45`}>No preview</div>
          )}
        </div>
        {visibleAssets.length ? <div className="h-20 w-px self-end bg-ink/10" /> : null}
        {visibleAssets.map((asset) => (
          <div key={asset.label} className={cardClass}>
            <p className="mb-1 text-xs font-medium text-ink/65">{asset.label}</p>
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
          </div>
        ))}
      </div>
      {warning ? <div className="mt-3 text-xs text-amber-700">{warning}</div> : null}
    </div>
  );
}

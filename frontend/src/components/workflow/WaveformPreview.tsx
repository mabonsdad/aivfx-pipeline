type WaveformPreviewProps = {
  src: string;
  alt: string;
  className?: string;
  imageClassName?: string;
  markerRatio?: number | null;
  markerLabel?: string | null;
  rangeStartRatio?: number | null;
  rangeEndRatio?: number | null;
  rangeStartLabel?: string | null;
  rangeEndLabel?: string | null;
};

function clampRatio(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, Number(value)));
}

export default function WaveformPreview({
  src,
  alt,
  className = "",
  imageClassName = "",
  markerRatio,
  markerLabel,
  rangeStartRatio,
  rangeEndRatio,
  rangeStartLabel,
  rangeEndLabel,
}: WaveformPreviewProps) {
  const marker = clampRatio(markerRatio);
  const start = clampRatio(rangeStartRatio);
  const end = clampRatio(rangeEndRatio);
  const hasRange = start !== null && end !== null && end >= start;

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <img src={src} alt={alt} className={imageClassName} loading="lazy" decoding="async" />
      {hasRange ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/18" style={{ width: `${start * 100}%` }} />
          <div className="pointer-events-none absolute inset-y-0 bg-teal-500/14" style={{ left: `${start * 100}%`, width: `${Math.max(0, end - start) * 100}%` }} />
          <div className="pointer-events-none absolute inset-y-0 bg-black/18" style={{ left: `${end * 100}%`, right: 0 }} />
          <div className="pointer-events-none absolute inset-y-0 border-l-2 border-r-2 border-teal-500/85" style={{ left: `${start * 100}%`, width: `${Math.max(0, end - start) * 100}%` }} />
        </>
      ) : null}
      {marker !== null ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 border-l-2 border-amber-500/90" style={{ left: `${marker * 100}%` }} />
          {markerLabel ? (
            <div
              className="pointer-events-none absolute top-1 -translate-x-1/2 rounded bg-amber-500/95 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm"
              style={{ left: `${marker * 100}%` }}
            >
              {markerLabel}
            </div>
          ) : null}
        </>
      ) : null}
      {hasRange && rangeStartLabel ? (
        <div
          className="pointer-events-none absolute bottom-1 -translate-x-1/2 rounded bg-teal-600/95 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm"
          style={{ left: `${start * 100}%` }}
        >
          {rangeStartLabel}
        </div>
      ) : null}
      {hasRange && rangeEndLabel ? (
        <div
          className="pointer-events-none absolute bottom-1 -translate-x-1/2 rounded bg-teal-600/95 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm"
          style={{ left: `${end * 100}%` }}
        >
          {rangeEndLabel}
        </div>
      ) : null}
    </div>
  );
}

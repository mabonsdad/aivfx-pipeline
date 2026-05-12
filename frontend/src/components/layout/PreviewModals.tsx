import { useEffect, useRef, useState } from "react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";

type ImagePreviewState = { url: string; label: string } | null;
type VideoPreviewState = { url: string; label: string } | null;
type ImageCompareState = { originalUrl: string; compareUrl: string; label: string } | null;
type VideoCompareState = {
  originalUrl: string;
  compareUrl: string;
  label: string;
  posterUrl?: string | null;
  segmentStartSec?: number;
  originalIsSegmentClip?: boolean;
} | null;

type PreviewModalsProps = {
  imagePreview: ImagePreviewState;
  videoPreview: VideoPreviewState;
  imageCompare: ImageCompareState;
  videoCompare: VideoCompareState;
  onCloseImage: () => void;
  onCloseVideo: () => void;
  onCloseImageCompare: () => void;
  onCloseVideoCompare: () => void;
  onMediaError?: () => void;
};

export default function PreviewModals({
  imagePreview,
  videoPreview,
  imageCompare,
  videoCompare,
  onCloseImage,
  onCloseVideo,
  onCloseImageCompare,
  onCloseVideoCompare,
  onMediaError,
}: PreviewModalsProps) {
  const compareOriginalRef = useRef<HTMLVideoElement | null>(null);
  const compareVariantRef = useRef<HTMLVideoElement | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const [videoCompareReady, setVideoCompareReady] = useState({ original: false, generated: false });
  const [videoCompareLoadTimedOut, setVideoCompareLoadTimedOut] = useState(false);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current !== null) {
        window.clearInterval(syncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!videoCompare) {
      setVideoCompareReady({ original: false, generated: false });
      setVideoCompareLoadTimedOut(false);
      return;
    }
    setVideoCompareReady({ original: false, generated: false });
    setVideoCompareLoadTimedOut(false);
  }, [videoCompare, videoCompare?.originalUrl, videoCompare?.compareUrl]);

  useEffect(() => {
    if (!videoCompare) return;
    const timeoutHandle = window.setTimeout(() => {
      setVideoCompareLoadTimedOut(true);
    }, 12000);
    return () => {
      window.clearTimeout(timeoutHandle);
    };
  }, [videoCompare, videoCompare?.originalUrl, videoCompare?.compareUrl]);

  useEffect(() => {
    if (!videoCompare) return;
    const original = compareOriginalRef.current;
    const generated = compareVariantRef.current;
    if (original?.readyState && original.readyState >= 1) {
      setVideoCompareReady((previous) => ({ ...previous, original: true }));
    }
    if (generated?.readyState && generated.readyState >= 1) {
      setVideoCompareReady((previous) => ({ ...previous, generated: true }));
    }
  }, [videoCompare]);

  useEffect(() => {
    if (!videoCompare || !videoCompareReady.generated) return;
    const generated = compareVariantRef.current;
    const original = compareOriginalRef.current;
    if (!generated) return;

    const stopSyncLoop = () => {
      if (syncTimerRef.current !== null) {
        window.clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };

    const syncOriginal = (forceSeek = false) => {
      if (!original || original.readyState < 1) return;
      const baseTime = videoCompare.originalIsSegmentClip ? 0 : videoCompare.segmentStartSec ?? 0;
      const maxOriginalTime = Math.max(0, (original.duration || 0) - 0.001);
      const targetTime = Math.max(0, Math.min(maxOriginalTime, baseTime + generated.currentTime));
      const drift = Math.abs((original.currentTime || 0) - targetTime);
      if (forceSeek || drift > 0.08) {
        try {
          original.currentTime = targetTime;
        } catch {
          // ignore seek failures before metadata is ready
        }
      }
    };

    const startSync = () => {
      syncOriginal(true);
      if (original && original.readyState >= 1) {
        original.playbackRate = generated.playbackRate || 1;
        if (original.paused) {
          original.play().catch(() => undefined);
        }
      }
      if (syncTimerRef.current === null) {
        syncTimerRef.current = window.setInterval(() => {
          if (generated.paused || generated.ended) {
            stopSyncLoop();
            return;
          }
          if (original && original.readyState >= 1) {
            original.playbackRate = generated.playbackRate || 1;
          }
          syncOriginal(false);
        }, 200);
      }
    };

    const pauseSync = () => {
      stopSyncLoop();
      original?.pause();
    };

    const seekSync = () => {
      syncOriginal(true);
    };

    const onRateChange = () => {
      if (original && original.readyState >= 1) {
        original.playbackRate = generated.playbackRate || 1;
      }
      syncOriginal(true);
    };

    pauseSync();
    try {
      generated.currentTime = 0;
      if (original && original.readyState >= 1) {
        const originalStart = videoCompare.originalIsSegmentClip ? 0 : videoCompare.segmentStartSec ?? 0;
        const maxOriginalStart = Math.max(0, (original.duration || 0) - 0.001);
        original.currentTime = Math.max(0, Math.min(maxOriginalStart, originalStart));
      }
    } catch {
      // ignore early seeks
    }
    if (original && original.readyState >= 1) {
      original.playbackRate = generated.playbackRate || 1;
    }

    generated.addEventListener("play", startSync);
    generated.addEventListener("playing", startSync);
    generated.addEventListener("pause", pauseSync);
    generated.addEventListener("ended", pauseSync);
    generated.addEventListener("seeking", seekSync);
    generated.addEventListener("seeked", seekSync);
    generated.addEventListener("ratechange", onRateChange);

    return () => {
      generated.removeEventListener("play", startSync);
      generated.removeEventListener("playing", startSync);
      generated.removeEventListener("pause", pauseSync);
      generated.removeEventListener("ended", pauseSync);
      generated.removeEventListener("seeking", seekSync);
      generated.removeEventListener("seeked", seekSync);
      generated.removeEventListener("ratechange", onRateChange);
      stopSyncLoop();
      original?.pause();
      generated.pause();
    };
  }, [videoCompare, videoCompareReady.generated]);

  useEffect(() => {
    if (!videoCompare || !videoCompareReady.generated) return;
    const generated = compareVariantRef.current;
    if (!generated) return;
    generated.play().catch(() => undefined);
  }, [videoCompare, videoCompareReady.generated]);

  return (
    <>
      {imagePreview ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onClick={onCloseImage}>
          <div className="relative flex h-[90vh] w-[90vw] items-center justify-center">
            <button type="button" className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseImage}>
              x
            </button>
            <img
              src={imagePreview.url}
              alt={imagePreview.label}
              className="h-full w-full object-contain"
              onClick={onCloseImage}
              onError={onMediaError}
            />
          </div>
        </div>
      ) : null}

      {videoPreview ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onClick={onCloseVideo}>
          <div className="relative w-[90vw] max-w-6xl rounded-lg border border-ink/20 bg-black p-3" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseVideo}>
              x
            </button>
            <video
              src={videoPreview.url}
              controls
              autoPlay
              preload="metadata"
              className="h-[80vh] w-full rounded object-contain"
              onError={onMediaError}
            />
          </div>
        </div>
      ) : null}

      {imageCompare ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onClick={onCloseImageCompare}>
          <div className="relative w-[90vw] max-w-6xl rounded-lg border border-ink/20 bg-black p-3" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="absolute right-2 top-2 z-10 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseImageCompare}>
              x
            </button>
            <div className="overflow-hidden rounded">
              <ReactCompareSlider
                className="h-[80vh] w-full"
                itemOne={<ReactCompareSliderImage src={imageCompare.originalUrl} alt={`${imageCompare.label} original`} style={{ height: "100%", width: "100%", objectFit: "contain" }} />}
                itemTwo={<ReactCompareSliderImage src={imageCompare.compareUrl} alt={imageCompare.label} style={{ height: "100%", width: "100%", objectFit: "contain" }} />}
              />
            </div>
          </div>
        </div>
      ) : null}

      {videoCompare ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onClick={onCloseVideoCompare}>
          <div className="relative w-[90vw] max-w-6xl rounded-lg border border-ink/20 bg-black p-3" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="absolute right-2 top-2 z-10 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseVideoCompare}>
              x
            </button>
            <div className="relative overflow-hidden rounded bg-black">
              <div
                className={
                  !videoCompareReady.generated || (!videoCompareReady.original && !videoCompareLoadTimedOut)
                    ? "pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/85"
                    : "sr-only"
                }
              >
                <div className="flex flex-col items-center gap-3 px-6 text-center text-white">
                  <span className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  <p className="text-sm font-medium">Preparing compare preview...</p>
                  <p className="text-xs text-white/70">Source video can take longer to load on first open.</p>
                </div>
              </div>
              <ReactCompareSlider
                className="h-[80vh] w-full"
                itemOne={
                  <div className="relative h-full w-full bg-black">
                    <video
                      key={`compare-original:${videoCompare.originalUrl}`}
                      ref={compareOriginalRef}
                      src={videoCompare.originalUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      preload="metadata"
                      className="h-full w-full object-contain"
                      onLoadedMetadata={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                      onLoadedData={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                      onCanPlay={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                      onError={onMediaError}
                    />
                    <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/65 px-2 py-1 text-xs font-medium tracking-wide text-white/90">
                      Source
                    </div>
                  </div>
                }
                itemTwo={
                  <div className="relative h-full w-full bg-black">
                    <video
                      key={`compare-generated:${videoCompare.compareUrl}`}
                      ref={compareVariantRef}
                      src={videoCompare.compareUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      preload="metadata"
                      poster={videoCompare.posterUrl ?? undefined}
                      className="h-full w-full object-contain"
                      onLoadedMetadata={() => setVideoCompareReady((previous) => ({ ...previous, generated: true }))}
                      onLoadedData={() => setVideoCompareReady((previous) => ({ ...previous, generated: true }))}
                      onCanPlay={() => setVideoCompareReady((previous) => ({ ...previous, generated: true }))}
                      onError={onMediaError}
                    />
                    <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/65 px-2 py-1 text-xs font-medium tracking-wide text-white/90">
                      Generated
                    </div>
                  </div>
                }
              />
            </div>
            {videoCompareLoadTimedOut && !videoCompareReady.original ? (
              <div className="mt-3 rounded border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
                Source preview is still loading, but compare playback will continue and sync as soon as source metadata is ready.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

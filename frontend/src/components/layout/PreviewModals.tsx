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

function hasBufferedAhead(video: HTMLVideoElement, minimumSeconds: number): boolean {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return false;
  const targetTime = video.currentTime || 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (targetTime >= start && end - targetTime >= minimumSeconds) {
      return true;
    }
  }
  return false;
}

const VIDEO_OBJECT_URL_CACHE_LIMIT = 3;
const VIDEO_OBJECT_URL_CACHE = new Map<string, string>();
const VIDEO_OBJECT_URL_PENDING = new Map<string, Promise<string>>();

function touchVideoCacheEntry(url: string, objectUrl: string): void {
  VIDEO_OBJECT_URL_CACHE.delete(url);
  VIDEO_OBJECT_URL_CACHE.set(url, objectUrl);
}

function trimVideoObjectUrlCache(): void {
  while (VIDEO_OBJECT_URL_CACHE.size > VIDEO_OBJECT_URL_CACHE_LIMIT) {
    const oldest = VIDEO_OBJECT_URL_CACHE.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    VIDEO_OBJECT_URL_CACHE.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]);
  }
}

function getCachedVideoObjectUrl(url: string): string | null {
  const cached = VIDEO_OBJECT_URL_CACHE.get(url);
  if (!cached) return null;
  touchVideoCacheEntry(url, cached);
  return cached;
}

function preloadVideoObjectUrl(url: string, signal: AbortSignal): Promise<string> {
  const cached = getCachedVideoObjectUrl(url);
  if (cached) return Promise.resolve(cached);
  const pending = VIDEO_OBJECT_URL_PENDING.get(url);
  if (pending) return pending;
  const request = fetch(url, { signal })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Preload failed (${response.status})`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      touchVideoCacheEntry(url, objectUrl);
      trimVideoObjectUrlCache();
      return objectUrl;
    })
    .finally(() => {
      VIDEO_OBJECT_URL_PENDING.delete(url);
    });
  VIDEO_OBJECT_URL_PENDING.set(url, request);
  return request;
}

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
  const DRIFT_HARD_RESYNC_SECONDS = 0.45;
  const DRIFT_RATE_ADJUST_SECONDS = 0.08;
  const SYNC_CHECK_INTERVAL_MS = 500;
  const compareOriginalRef = useRef<HTMLVideoElement | null>(null);
  const compareVariantRef = useRef<HTMLVideoElement | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const [videoCompareReady, setVideoCompareReady] = useState({ original: false, generated: false });
  const [videoCompareBuffered, setVideoCompareBuffered] = useState({ original: false, generated: false });
  const [videoCompareLoadTimedOut, setVideoCompareLoadTimedOut] = useState(false);
  const [videoCompareOriginalSourceUrl, setVideoCompareOriginalSourceUrl] = useState<string | null>(null);
  const [videoCompareOriginalCachePriming, setVideoCompareOriginalCachePriming] = useState(false);

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
      setVideoCompareBuffered({ original: false, generated: false });
      setVideoCompareLoadTimedOut(false);
      setVideoCompareOriginalSourceUrl(null);
      setVideoCompareOriginalCachePriming(false);
      return;
    }
    const cachedOriginal = getCachedVideoObjectUrl(videoCompare.originalUrl);
    setVideoCompareOriginalSourceUrl(cachedOriginal ?? videoCompare.originalUrl);
    setVideoCompareOriginalCachePriming(!cachedOriginal);
    setVideoCompareReady({ original: false, generated: false });
    setVideoCompareBuffered({ original: false, generated: false });
    setVideoCompareLoadTimedOut(false);
  }, [videoCompare, videoCompare?.originalUrl, videoCompare?.compareUrl]);

  useEffect(() => {
    if (!videoCompare) return;
    const cachedOriginal = getCachedVideoObjectUrl(videoCompare.originalUrl);
    if (cachedOriginal) {
      setVideoCompareOriginalSourceUrl(cachedOriginal);
      setVideoCompareOriginalCachePriming(false);
      return;
    }
    const controller = new AbortController();
    setVideoCompareOriginalCachePriming(true);
    void preloadVideoObjectUrl(videoCompare.originalUrl, controller.signal)
      .then((objectUrl) => {
        setVideoCompareOriginalCachePriming(false);
        // Only swap source before playback has started; next opens will use cache immediately.
        if (!videoCompareReady.generated) {
          setVideoCompareOriginalSourceUrl(objectUrl);
        }
      })
      .catch((error) => {
        if ((error as { name?: string }).name === "AbortError") return;
        setVideoCompareOriginalCachePriming(false);
      });
    return () => {
      controller.abort();
    };
  }, [videoCompare, videoCompareReady.generated]);

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
    const canBeginPlayback =
      videoCompareReady.generated &&
      videoCompareBuffered.generated &&
      ((videoCompareReady.original && videoCompareBuffered.original) || videoCompareLoadTimedOut);
    if (!videoCompare || !canBeginPlayback) return;
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
      const currentOriginalTime = original.currentTime || 0;
      const drift = targetTime - currentOriginalTime;
      const driftAbs = Math.abs(drift);
      if (forceSeek || driftAbs > DRIFT_HARD_RESYNC_SECONDS) {
        try {
          original.currentTime = targetTime;
          original.playbackRate = generated.playbackRate || 1;
        } catch {
          // ignore seek failures before metadata is ready
        }
        return;
      }

      if (driftAbs > DRIFT_RATE_ADJUST_SECONDS) {
        const baseRate = generated.playbackRate || 1;
        const driftBias = Math.max(-0.06, Math.min(0.06, drift * 0.2));
        original.playbackRate = Math.max(0.9, Math.min(1.1, baseRate + driftBias));
      } else {
        original.playbackRate = generated.playbackRate || 1;
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
            if (Math.abs(original.playbackRate - (generated.playbackRate || 1)) > 0.15) {
              original.playbackRate = generated.playbackRate || 1;
            }
          }
          syncOriginal(false);
        }, SYNC_CHECK_INTERVAL_MS);
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
  }, [videoCompare, videoCompareBuffered.generated, videoCompareBuffered.original, videoCompareLoadTimedOut, videoCompareReady.generated, videoCompareReady.original]);

  useEffect(() => {
    const canBeginPlayback =
      videoCompareReady.generated &&
      videoCompareBuffered.generated &&
      ((videoCompareReady.original && videoCompareBuffered.original) || videoCompareLoadTimedOut);
    if (!videoCompare || !canBeginPlayback) return;
    const generated = compareVariantRef.current;
    if (!generated) return;
    generated.play().catch(() => undefined);
  }, [videoCompare, videoCompareBuffered.generated, videoCompareBuffered.original, videoCompareLoadTimedOut, videoCompareReady.generated, videoCompareReady.original]);

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
                  !videoCompareReady.generated ||
                  !videoCompareBuffered.generated ||
                  ((!videoCompareReady.original || !videoCompareBuffered.original) && !videoCompareLoadTimedOut)
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
                      key={`compare-original:${videoCompare.originalUrl}:${videoCompareOriginalSourceUrl ?? "none"}`}
                      ref={compareOriginalRef}
                      src={videoCompareOriginalSourceUrl ?? videoCompare.originalUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      preload="metadata"
                      className="h-full w-full object-contain"
                      onLoadedMetadata={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                      onLoadedData={(event) => {
                        setVideoCompareReady((previous) => ({ ...previous, original: true }));
                        if (hasBufferedAhead(event.currentTarget, 0.35)) {
                          setVideoCompareBuffered((previous) => ({ ...previous, original: true }));
                        }
                      }}
                      onCanPlay={(event) => {
                        setVideoCompareReady((previous) => ({ ...previous, original: true }));
                        if (hasBufferedAhead(event.currentTarget, 0.35)) {
                          setVideoCompareBuffered((previous) => ({ ...previous, original: true }));
                        }
                      }}
                      onCanPlayThrough={() => setVideoCompareBuffered((previous) => ({ ...previous, original: true }))}
                      onProgress={(event) => {
                        if (hasBufferedAhead(event.currentTarget, 0.35)) {
                          setVideoCompareBuffered((previous) => ({ ...previous, original: true }));
                        }
                      }}
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
                      onLoadedData={(event) => {
                        setVideoCompareReady((previous) => ({ ...previous, generated: true }));
                        if (hasBufferedAhead(event.currentTarget, 0.35)) {
                          setVideoCompareBuffered((previous) => ({ ...previous, generated: true }));
                        }
                      }}
                      onCanPlay={(event) => {
                        setVideoCompareReady((previous) => ({ ...previous, generated: true }));
                        if (hasBufferedAhead(event.currentTarget, 0.35)) {
                          setVideoCompareBuffered((previous) => ({ ...previous, generated: true }));
                        }
                      }}
                      onCanPlayThrough={() => setVideoCompareBuffered((previous) => ({ ...previous, generated: true }))}
                      onProgress={(event) => {
                        if (hasBufferedAhead(event.currentTarget, 0.35)) {
                          setVideoCompareBuffered((previous) => ({ ...previous, generated: true }));
                        }
                      }}
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
            {videoCompareOriginalCachePriming ? (
              <div className="mt-2 rounded border border-teal-300/30 bg-teal-300/10 px-3 py-2 text-xs text-teal-100">
                Building local source cache for smoother replay on next open.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

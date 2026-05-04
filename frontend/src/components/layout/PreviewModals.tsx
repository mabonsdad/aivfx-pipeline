import { useEffect, useRef, useState } from "react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { StatusNotice } from "./UiFeedback";

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

const VIDEO_COMPARE_OBJECT_URL_CACHE = new Map<string, Promise<string>>();

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
  const [videoCompareSources, setVideoCompareSources] = useState<{ original: string | null; generated: string | null }>({
    original: null,
    generated: null,
  });
  const [videoCompareLoading, setVideoCompareLoading] = useState(false);
  const [videoCompareLoadError, setVideoCompareLoadError] = useState<string | null>(null);

  async function loadVideoIntoObjectUrl(url: string, signal: AbortSignal): Promise<string> {
    const existing = VIDEO_COMPARE_OBJECT_URL_CACHE.get(url);
    if (existing) return existing;
    const pending = fetch(url, { signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Video preload failed: ${response.status}`);
        }
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      })
      .catch((error) => {
        VIDEO_COMPARE_OBJECT_URL_CACHE.delete(url);
        throw error;
      });
    VIDEO_COMPARE_OBJECT_URL_CACHE.set(url, pending);
    return pending;
  }

  useEffect(() => {
    return () => {
      if (syncTimerRef.current !== null) {
        window.clearInterval(syncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setVideoCompareReady({ original: false, generated: false });
  }, [videoCompare?.originalUrl, videoCompare?.compareUrl]);

  useEffect(() => {
    if (!videoCompare) {
      setVideoCompareSources({ original: null, generated: null });
      setVideoCompareLoading(false);
      setVideoCompareLoadError(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setVideoCompareLoading(true);
    setVideoCompareLoadError(null);
    setVideoCompareSources({ original: null, generated: null });
    void Promise.all([
      loadVideoIntoObjectUrl(videoCompare.originalUrl, controller.signal),
      loadVideoIntoObjectUrl(videoCompare.compareUrl, controller.signal),
    ])
      .then(([original, generated]) => {
        if (cancelled) return;
        setVideoCompareSources({ original, generated });
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setVideoCompareLoadError(error instanceof Error ? error.message : "Failed to preload compare videos");
        setVideoCompareSources({
          original: videoCompare.originalUrl,
          generated: videoCompare.compareUrl,
        });
      })
      .finally(() => {
        if (!cancelled) {
          setVideoCompareLoading(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [videoCompare]);

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
    if (!videoCompare || !videoCompareReady.original || !videoCompareReady.generated) return;
    const generated = compareVariantRef.current;
    const original = compareOriginalRef.current;
    if (!generated || !original) return;

    const stopSyncLoop = () => {
      if (syncTimerRef.current !== null) {
        window.clearInterval(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };

    const syncOriginal = (forceSeek = false) => {
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
      original.playbackRate = generated.playbackRate || 1;
      if (original.paused) {
        original.play().catch(() => undefined);
      }
      if (syncTimerRef.current === null) {
        syncTimerRef.current = window.setInterval(() => {
          if (generated.paused || generated.ended) {
            stopSyncLoop();
            return;
          }
          original.playbackRate = generated.playbackRate || 1;
          syncOriginal(false);
        }, 200);
      }
    };

    const pauseSync = () => {
      stopSyncLoop();
      original.pause();
    };

    const seekSync = () => {
      syncOriginal(true);
    };

    const onRateChange = () => {
      original.playbackRate = generated.playbackRate || 1;
      syncOriginal(true);
    };

    pauseSync();
    try {
      generated.currentTime = 0;
      const originalStart = videoCompare.originalIsSegmentClip ? 0 : videoCompare.segmentStartSec ?? 0;
      const maxOriginalStart = Math.max(0, (original.duration || 0) - 0.001);
      original.currentTime = Math.max(0, Math.min(maxOriginalStart, originalStart));
    } catch {
      // ignore early seeks
    }
    original.playbackRate = generated.playbackRate || 1;

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
      original.pause();
      generated.pause();
    };
  }, [videoCompare, videoCompareReady.generated, videoCompareReady.original, videoCompareSources.generated, videoCompareSources.original]);

  useEffect(() => {
    if (!videoCompare || !videoCompareReady.original || !videoCompareReady.generated) return;
    const generated = compareVariantRef.current;
    if (!generated) return;
    generated.play().catch(() => undefined);
  }, [videoCompare, videoCompareReady.generated, videoCompareReady.original]);

  return (
    <>
      {imagePreview ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onClick={onCloseImage}>
          <div className="relative flex h-[90vh] w-[90vw] items-center justify-center">
            <button className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseImage}>
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
            <button className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseVideo}>
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
            <button className="absolute right-2 top-2 z-10 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseImageCompare}>
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
            <button className="absolute right-2 top-2 z-10 rounded bg-black/70 px-3 py-1 text-sm text-white" onClick={onCloseVideoCompare}>
              x
            </button>
            <div className="relative overflow-hidden rounded bg-black">
              <div className={videoCompareLoading || !videoCompareReady.original || !videoCompareReady.generated ? "pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black" : "sr-only"}>
                <div className="w-full max-w-md px-6">
                  <StatusNotice variant="loading" title="Preparing compare" className="border-white/10 bg-black/70 text-center text-white">
                    <p>Loading both videos into local memory before synchronized playback starts.</p>
                  </StatusNotice>
                </div>
              </div>
              <div className={videoCompareLoading || !videoCompareReady.original || !videoCompareReady.generated ? "invisible" : "visible"}>
                <ReactCompareSlider
                  className="h-[80vh] w-full"
                  itemOne={
                    <video
                      key={`compare-original:${videoCompare.originalUrl}`}
                      ref={compareOriginalRef}
                      src={videoCompareSources.original ?? undefined}
                      muted
                      playsInline
                      preload="auto"
                      className="h-full w-full object-contain"
                      onLoadedMetadata={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                      onLoadedData={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                      onCanPlay={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                      onError={onMediaError}
                    />
                  }
                  itemTwo={
                    <video
                      key={`compare-generated:${videoCompare.compareUrl}`}
                      ref={compareVariantRef}
                      src={videoCompareSources.generated ?? undefined}
                      controls
                      playsInline
                      preload="auto"
                      poster={videoCompare.posterUrl ?? undefined}
                      className="h-full w-full object-contain"
                      onLoadedMetadata={() => setVideoCompareReady((previous) => ({ ...previous, generated: true }))}
                      onLoadedData={() => setVideoCompareReady((previous) => ({ ...previous, generated: true }))}
                      onCanPlay={() => setVideoCompareReady((previous) => ({ ...previous, generated: true }))}
                      onError={onMediaError}
                    />
                  }
                />
              </div>
            </div>
            {videoCompareLoadError ? (
              <div className="pointer-events-none absolute inset-x-6 bottom-6">
                <StatusNotice variant="warning" title="Compare loaded without local cache">
                  <p>{videoCompareLoadError}</p>
                </StatusNotice>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

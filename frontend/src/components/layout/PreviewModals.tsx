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
  const syncRafRef = useRef<number | null>(null);
  const [videoCompareReady, setVideoCompareReady] = useState({ original: false, generated: false });

  useEffect(() => {
    return () => {
      if (syncRafRef.current !== null) {
        window.cancelAnimationFrame(syncRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setVideoCompareReady({ original: false, generated: false });
  }, [videoCompare?.originalUrl, videoCompare?.compareUrl]);

  useEffect(() => {
    if (!videoCompare || !videoCompareReady.original || !videoCompareReady.generated) return;
    const generated = compareVariantRef.current;
    const original = compareOriginalRef.current;
    if (!generated || !original) return;

    const stopSyncLoop = () => {
      if (syncRafRef.current !== null) {
        window.cancelAnimationFrame(syncRafRef.current);
        syncRafRef.current = null;
      }
    };

    const syncOriginal = () => {
      const baseTime = videoCompare.originalIsSegmentClip ? 0 : videoCompare.segmentStartSec ?? 0;
      try {
        original.currentTime = baseTime + generated.currentTime;
      } catch {
        // ignore seek failures before metadata is ready
      }
    };

    const loopSync = () => {
      if (generated.paused || generated.ended) {
        stopSyncLoop();
        return;
      }
      syncOriginal();
      syncRafRef.current = window.requestAnimationFrame(loopSync);
    };

    const startSync = () => {
      syncOriginal();
      original.playbackRate = generated.playbackRate || 1;
      if (original.paused) {
        original.play().catch(() => undefined);
      }
      if (syncRafRef.current === null) {
        syncRafRef.current = window.requestAnimationFrame(loopSync);
      }
    };

    const pauseSync = () => {
      stopSyncLoop();
      original.pause();
    };

    const seekSync = () => {
      syncOriginal();
    };

    const onRateChange = () => {
      original.playbackRate = generated.playbackRate || 1;
      syncOriginal();
    };

    pauseSync();
    try {
      generated.currentTime = 0;
      original.currentTime = videoCompare.originalIsSegmentClip ? 0 : videoCompare.segmentStartSec ?? 0;
    } catch {
      // ignore early seeks
    }
    original.playbackRate = generated.playbackRate || 1;

    generated.addEventListener("play", startSync);
    generated.addEventListener("playing", startSync);
    generated.addEventListener("pause", pauseSync);
    generated.addEventListener("ended", pauseSync);
    generated.addEventListener("seeking", seekSync);
    generated.addEventListener("ratechange", onRateChange);

    return () => {
      generated.removeEventListener("play", startSync);
      generated.removeEventListener("playing", startSync);
      generated.removeEventListener("pause", pauseSync);
      generated.removeEventListener("ended", pauseSync);
      generated.removeEventListener("seeking", seekSync);
      generated.removeEventListener("ratechange", onRateChange);
      stopSyncLoop();
      original.pause();
      generated.pause();
    };
  }, [videoCompare, videoCompareReady.generated, videoCompareReady.original]);

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
            <div className="overflow-hidden rounded">
              <ReactCompareSlider
                className="h-[80vh] w-full"
                itemOne={
                  <video
                    key={`compare-original:${videoCompare.originalUrl}`}
                    ref={compareOriginalRef}
                    src={videoCompare.originalUrl}
                    muted
                    playsInline
                    preload="auto"
                    className="h-full w-full object-contain"
                    onLoadedData={() => setVideoCompareReady((previous) => ({ ...previous, original: true }))}
                    onError={onMediaError}
                  />
                }
                itemTwo={
                  <video
                    key={`compare-generated:${videoCompare.compareUrl}`}
                    ref={compareVariantRef}
                    src={videoCompare.compareUrl}
                    controls
                    playsInline
                    preload="auto"
                    poster={videoCompare.posterUrl ?? undefined}
                    className="h-full w-full object-contain"
                    onLoadedData={() => setVideoCompareReady((previous) => ({ ...previous, generated: true }))}
                    onError={onMediaError}
                  />
                }
              />
            </div>
            {!videoCompareReady.original || !videoCompareReady.generated ? (
              <div className="pointer-events-none absolute inset-x-6 bottom-6">
                <StatusNotice variant="loading" title="Preparing compare">
                  <p>Waiting for both videos to load before synchronized playback starts.</p>
                </StatusNotice>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

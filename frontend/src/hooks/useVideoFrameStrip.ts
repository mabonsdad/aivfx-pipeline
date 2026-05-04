import { useEffect, useMemo, useState } from "react";

export type VideoFrameStripItem = {
  frameIndex: number;
  imageUrl: string | null;
  sourceFrameIndex?: number;
};

const VIDEO_FRAME_THUMBNAIL_CACHE = new Map<string, string | null>();

function isValidHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function useVideoFrameStrip({
  videoUrl,
  fps,
  frameIndices,
  cachePrefix,
  sourceCacheKey,
}: {
  videoUrl?: string | null;
  fps: number;
  frameIndices: number[];
  cachePrefix: string;
  sourceCacheKey?: string | null;
}): VideoFrameStripItem[] {
  const [items, setItems] = useState<VideoFrameStripItem[]>([]);
  const signature = useMemo(() => frameIndices.join(","), [frameIndices]);

  useEffect(() => {
    let cancelled = false;
    if (!isValidHttpUrl(videoUrl) || !Number.isFinite(fps) || fps <= 0 || frameIndices.length === 0) {
      setItems([]);
      return;
    }

    const safeFps = fps;
    const uniqueFrames = Array.from(new Set(frameIndices)).sort((a, b) => a - b);
    const sourceKey = sourceCacheKey || videoUrl;
    const frameCacheKey = (frameIndex: number) => `${cachePrefix}:${sourceKey}:${frameIndex}`;
    const initial = uniqueFrames.map((frameIndex) => {
      const key = frameCacheKey(frameIndex);
      return { frameIndex, imageUrl: VIDEO_FRAME_THUMBNAIL_CACHE.get(key) ?? null };
    });
    setItems(initial);
    const allCached = uniqueFrames.every((frameIndex) => VIDEO_FRAME_THUMBNAIL_CACHE.has(frameCacheKey(frameIndex)));
    if (allCached) {
      return;
    }

    const run = async () => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.src = videoUrl;

      const waitForInitialFrame = new Promise<void>((resolve, reject) => {
        const handleLoaded = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error("Could not read video metadata"));
        };
        const cleanup = () => {
          video.removeEventListener("loadeddata", handleLoaded);
          video.removeEventListener("canplay", handleLoaded);
          video.removeEventListener("error", handleError);
        };
        video.addEventListener("loadeddata", handleLoaded);
        video.addEventListener("canplay", handleLoaded);
        video.addEventListener("error", handleError);
      });

      try {
        video.load();
        await waitForInitialFrame;
      } catch {
        if (!cancelled) {
          setItems(uniqueFrames.map((frameIndex) => ({ frameIndex, imageUrl: null })));
        }
        video.pause();
        video.src = "";
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, video.videoWidth || 1);
      canvas.height = Math.max(1, video.videoHeight || 1);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        if (!cancelled) {
          setItems(uniqueFrames.map((frameIndex) => ({ frameIndex, imageUrl: null })));
        }
        video.pause();
        video.src = "";
        return;
      }

      const results: VideoFrameStripItem[] = [];
      const durationSec = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
      const maxSeekSec = Math.max(0, durationSec - 0.001);

      for (const frameIndex of uniqueFrames) {
        if (cancelled) break;
        const cacheKey = frameCacheKey(frameIndex);
        if (VIDEO_FRAME_THUMBNAIL_CACHE.has(cacheKey)) {
          results.push({ frameIndex, imageUrl: VIDEO_FRAME_THUMBNAIL_CACHE.get(cacheKey) ?? null });
          continue;
        }

        const targetSec = Math.max(
          0,
          Math.min(maxSeekSec, frameIndex === 0 ? 0.5 / safeFps : frameIndex / safeFps),
        );
        try {
          if (Math.abs(video.currentTime - targetSec) > 0.0005) {
            const seekPromise = new Promise<void>((resolve, reject) => {
              const handleSeeked = () => {
                cleanup();
                resolve();
              };
              const handleError = () => {
                cleanup();
                reject(new Error("seek failed"));
              };
              const cleanup = () => {
                video.removeEventListener("seeked", handleSeeked);
                video.removeEventListener("error", handleError);
              };
              video.addEventListener("seeked", handleSeeked);
              video.addEventListener("error", handleError);
            });
            video.currentTime = targetSec;
            await seekPromise;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
          VIDEO_FRAME_THUMBNAIL_CACHE.set(cacheKey, dataUrl);
          results.push({ frameIndex, imageUrl: dataUrl });
        } catch {
          VIDEO_FRAME_THUMBNAIL_CACHE.set(cacheKey, null);
          results.push({ frameIndex, imageUrl: null });
        }
      }

      video.pause();
      video.src = "";
      if (!cancelled) {
        setItems(results);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [cachePrefix, fps, frameIndices, signature, sourceCacheKey, videoUrl]);

  return items;
}

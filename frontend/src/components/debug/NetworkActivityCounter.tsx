import { useEffect, useMemo, useRef, useState } from "react";

type NetworkEntry = {
  at: number;
  key: string;
  kind: "api" | "media" | "other";
};

const WINDOW_SHORT_MS = 10_000;
const WINDOW_LONG_MS = 60_000;
const KEEP_MS = 2 * 60_000;

function classifyResource(url: string, initiatorType: string): NetworkEntry["kind"] {
  if (url.includes("execute-api.") || url.includes("/tasks") || url.includes("/jobs")) return "api";
  if (initiatorType === "video" || initiatorType === "audio" || initiatorType === "img" || /\.mp4($|\?)/i.test(url) || /\.webm($|\?)/i.test(url)) {
    return "media";
  }
  return "other";
}

function normalizeResource(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function summarize(entries: NetworkEntry[], windowMs: number, now: number) {
  const floor = now - windowMs;
  let total = 0;
  let api = 0;
  let media = 0;
  const byKey = new Map<string, number>();
  for (const entry of entries) {
    if (entry.at < floor) continue;
    total += 1;
    if (entry.kind === "api") api += 1;
    if (entry.kind === "media") media += 1;
    byKey.set(entry.key, (byKey.get(entry.key) ?? 0) + 1);
  }
  const top = Array.from(byKey.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  return { total, api, media, top };
}

export default function NetworkActivityCounter() {
  const entriesRef = useRef<NetworkEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const observer = new PerformanceObserver((list) => {
      const now = Date.now();
      for (const entry of list.getEntries()) {
        if (!(entry instanceof PerformanceResourceTiming)) continue;
        const key = normalizeResource(entry.name);
        const kind = classifyResource(entry.name, entry.initiatorType);
        entriesRef.current.push({ at: now, key, kind });
      }
      const cutoff = Date.now() - KEEP_MS;
      entriesRef.current = entriesRef.current.filter((entry) => entry.at >= cutoff);
      setNow(Date.now());
    });
    observer.observe({ entryTypes: ["resource"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const cutoff = Date.now() - KEEP_MS;
      entriesRef.current = entriesRef.current.filter((entry) => entry.at >= cutoff);
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const short = useMemo(() => summarize(entriesRef.current, WINDOW_SHORT_MS, now), [now]);
  const long = useMemo(() => summarize(entriesRef.current, WINDOW_LONG_MS, now), [now]);

  return (
    <div className="fixed bottom-3 right-3 z-[70] flex max-w-[22rem] flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rounded-full border border-ink/20 bg-white/90 px-3 py-1 text-xs font-medium text-ink shadow-sm backdrop-blur"
        title="Toggle network activity counter"
      >
        Net {short.total}/10s
      </button>
      {open ? (
        <div className="w-[22rem] rounded-lg border border-ink/20 bg-white/95 p-3 text-xs text-ink shadow-lg backdrop-blur">
          <div className="mb-2 font-semibold">Network Activity</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded border border-ink/10 bg-bg px-2 py-1">10s: {short.total}</div>
            <div className="rounded border border-ink/10 bg-bg px-2 py-1">60s: {long.total}</div>
            <div className="rounded border border-ink/10 bg-bg px-2 py-1">API/10s: {short.api}</div>
            <div className="rounded border border-ink/10 bg-bg px-2 py-1">Media/10s: {short.media}</div>
          </div>
          <div className="mt-2 font-medium">Top URLs (60s)</div>
          <div className="mt-1 space-y-1">
            {long.top.length ? (
              long.top.map(([key, count]) => (
                <div key={key} className="truncate rounded border border-ink/10 bg-bg px-2 py-1" title={key}>
                  {count}x {key}
                </div>
              ))
            ) : (
              <div className="rounded border border-ink/10 bg-bg px-2 py-1 text-ink/60">No recent requests</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";

import { PendingButtonLabel } from "../layout/UiFeedback";
import type { SourceMediaPickerItem, SourceMediaPickerScope } from "../../types/referencePicker";

type SourceMediaPickerModalProps = {
  isOpen: boolean;
  mediaKind: "video" | "audio";
  items: SourceMediaPickerItem[];
  hasProjectScope: boolean;
  isSaving?: boolean;
  onClose: () => void;
  onConfirm: (taskId: string) => Promise<void> | void;
};

function sortNewestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export default function SourceMediaPickerModal({
  isOpen,
  mediaKind,
  items,
  hasProjectScope,
  isSaving = false,
  onClose,
  onConfirm,
}: SourceMediaPickerModalProps) {
  const [scope, setScope] = useState<SourceMediaPickerScope>("task");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(12);

  useEffect(() => {
    if (!isOpen) return;
    setScope("task");
    setSelectedTaskId(null);
    setVisibleCount(12);
  }, [isOpen, mediaKind]);

  const filteredItems = useMemo(() => {
    const scoped = sortNewestFirst(items).filter((item) => {
      if (scope === "all_tasks") return true;
      if (scope === "project") return item.isProjectAsset;
      return item.isCurrentTaskAsset;
    });
    return scoped;
  }, [items, scope]);

  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.taskId === selectedTaskId) ?? null,
    [filteredItems, selectedTaskId],
  );

  if (!isOpen) return null;

  const scopeOptions: Array<{ value: SourceMediaPickerScope; label: string }> = [
    { value: "all_tasks", label: "All tasks" },
    ...(hasProjectScope ? [{ value: "project" as const, label: "Project" }] : []),
    { value: "task", label: "Task" },
  ];

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-ink/10 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-lg font-semibold text-ink">{mediaKind === "audio" ? "Source audio library" : "Source video library"}</p>
              <p className="text-sm text-ink/65">Choose an existing uploaded task source to reuse without duplicating the underlying file.</p>
            </div>
            <button type="button" className="rounded-md border border-ink/20 px-3 py-2 text-sm" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-ink/15 bg-white p-3 text-sm">
            <span className="text-ink/60">Filter by</span>
            <select
              className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm text-ink"
              value={scope}
              onChange={(event) => setScope(event.target.value as SourceMediaPickerScope)}
            >
              {scopeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {filteredItems.slice(0, visibleCount).map((item) => {
                const isSelected = item.taskId === selectedTaskId;
                return (
                  <button
                    key={`${item.taskId}:${item.previewUrl}`}
                    type="button"
                    className={`rounded-lg border p-3 text-left ${isSelected ? "border-teal-500 bg-teal-50" : "border-ink/15 bg-white"}`}
                    onClick={() => setSelectedTaskId(item.taskId)}
                  >
                    <div className="relative overflow-hidden rounded-lg border border-ink/10 bg-bg">
                      {item.thumbnailUrl ? (
                        <img src={item.thumbnailUrl} alt={item.title} className="aspect-video w-full object-cover" loading="lazy" decoding="async" />
                      ) : item.waveformUrl ? (
                        <img src={item.waveformUrl} alt={item.title} className="aspect-video w-full object-contain" loading="lazy" decoding="async" />
                      ) : (
                        <div className="flex aspect-video items-center justify-center text-xs text-ink/55">{mediaKind === "audio" ? "Audio" : "Video"}</div>
                      )}
                      <span className="absolute bottom-2 left-2 rounded-full bg-white/90 px-2 py-1 text-[10px] font-medium text-ink shadow-sm">Uploaded source</span>
                    </div>
                    <p className="mt-2 truncate text-sm font-medium text-ink">{item.title}</p>
                    <p className="truncate text-[11px] text-ink/60">{item.subtitle}</p>
                  </button>
                );
              })}
              {!filteredItems.length ? <p className="text-sm text-ink/60">No compatible uploaded sources match this filter yet.</p> : null}
            </div>

            <div className="space-y-3 rounded-lg border border-ink/15 bg-white p-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-ink">Preview</p>
                <p className="text-xs text-ink/60">Select an item on the left, then bind it as this task’s source.</p>
              </div>
              {selectedItem ? (
                <>
                  <div>
                    <p className="text-sm font-medium text-ink">{selectedItem.title}</p>
                    <p className="text-xs text-ink/60">{selectedItem.subtitle}</p>
                  </div>
                  <div className="overflow-hidden rounded-lg border border-ink/10 bg-bg">
                    {mediaKind === "audio" ? (
                      <>
                        {selectedItem.waveformUrl ? (
                          <img src={selectedItem.waveformUrl} alt={selectedItem.title} className="aspect-video w-full object-contain" />
                        ) : null}
                        <audio src={selectedItem.previewUrl} controls className="w-full" />
                      </>
                    ) : (
                      <video src={selectedItem.previewUrl} controls className="aspect-video w-full bg-black" />
                    )}
                  </div>
                  <button
                    type="button"
                    className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isSaving}
                    onClick={() => void onConfirm(selectedItem.taskId)}
                  >
                    <PendingButtonLabel isPending={isSaving} idle={`Use this ${mediaKind}`} pending="Binding..." />
                  </button>
                </>
              ) : (
                <div className="rounded-md border border-dashed border-ink/20 bg-bg px-3 py-4 text-sm text-ink/60">No source selected yet.</div>
              )}
            </div>
          </div>

          {visibleCount < filteredItems.length ? (
            <button
              type="button"
              className="mt-4 text-sm font-medium text-accent underline underline-offset-2"
              onClick={() => setVisibleCount((previous) => previous + 12)}
            >
              More...
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

import type { WorkingReferencePreviewItem } from "../../types/referencePicker";

type CurrentWorkingReferencesStripProps = {
  items: WorkingReferencePreviewItem[];
  maxSelected: number;
  warning?: string | null;
  onOpenPicker: () => void;
  onRemove?: (referenceId: string) => void;
  emptyLabel?: string;
  ctaLabel?: string;
};

export default function CurrentWorkingReferencesStrip({
  items,
  maxSelected,
  warning,
  onOpenPicker,
  onRemove,
  emptyLabel = "No reference images selected.",
  ctaLabel = "Add reference images",
}: CurrentWorkingReferencesStripProps) {
  return (
    <div className="space-y-3 rounded-xl border border-ink/15 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-ink">Current Working References</p>
          <p className="text-xs text-ink/65">
            Selected images are sent in this order. Choose up to {maxSelected} for the current model.
          </p>
        </div>
        <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white" onClick={onOpenPicker}>
          {ctaLabel}
        </button>
      </div>

      {warning ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{warning}</div>
      ) : null}

      {items.length ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <div key={item.referenceId} className="rounded-lg border border-ink/15 bg-bg p-2">
              {item.imageUrl ? <img src={item.imageUrl} alt={item.title} className="h-20 w-full rounded bg-white object-contain" loading="lazy" decoding="async" /> : null}
              <div className="mt-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium text-ink">{item.token}</p>
                  <p className="truncate text-[11px] text-ink/60">{item.title}</p>
                </div>
                {onRemove ? (
                  <button
                    type="button"
                    className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px] text-ink/70"
                    onClick={() => onRemove(item.referenceId)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-ink/20 bg-bg px-4 py-5 text-sm text-ink/60">{emptyLabel}</div>
      )}
    </div>
  );
}

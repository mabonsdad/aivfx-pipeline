type WorkflowTabsProps = {
  tabs: Array<{ id: string; label: string }>;
  activeTab: string;
  onSelect: (tabId: string) => void;
  variant?: "primary" | "secondary";
  disabledTabs?: Iterable<string>;
};

export default function WorkflowTabs({ tabs, activeTab, onSelect, variant = "primary", disabledTabs = [] }: WorkflowTabsProps) {
  const isPrimary = variant === "primary";
  const disabledSet = new Set(disabledTabs);
  return (
    <div className={`${isPrimary ? "mb-4 flex flex-wrap items-center gap-2" : "mb-3 inline-flex flex-wrap items-center gap-1 rounded-xl border border-ink/10 bg-white p-1"}`}>
      {tabs.map(({ id, label }, index) => (
        <div key={id} className="flex items-center gap-2">
          {(() => {
            const isDisabled = disabledSet.has(id);
            return (
          <button
            type="button"
            onClick={() => {
              if (isDisabled) return;
              onSelect(id);
            }}
            disabled={isDisabled}
            className={`flex items-center gap-2 rounded-md text-sm transition ${
              activeTab === id
                ? isPrimary
                  ? "bg-teal-600 px-4 py-2.5 text-white shadow-sm ring-2 ring-teal-200"
                  : "border border-teal-500 bg-teal-50 px-3 py-2 font-medium text-ink shadow-sm"
                : isPrimary
                  ? `border px-3 py-2 ${isDisabled ? "cursor-not-allowed border-ink/10 bg-ink/5 text-ink/35" : "border-ink/10 bg-bg text-ink/75 hover:bg-white"}`
                  : `${isDisabled ? "cursor-not-allowed text-ink/35" : "text-ink/70 hover:bg-bg hover:text-ink"} px-3 py-2`
            }`}
          >
            {isPrimary ? (
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                  activeTab === id ? "bg-white/20 text-white" : isDisabled ? "bg-ink/5 text-ink/35" : "bg-ink/10 text-ink/60"
                }`}
              >
                {index + 1}
              </span>
            ) : null}
            {label}
          </button>
            );
          })()}
          {isPrimary && index < tabs.length - 1 ? <span className="pointer-events-none select-none text-ink/35">→</span> : null}
        </div>
      ))}
    </div>
  );
}

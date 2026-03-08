import type { TabId } from "../../hooks/useWorkflowRouting";

type WorkflowTabsProps = {
  tabs: Array<{ id: TabId; label: string }>;
  activeTab: TabId;
  onSelect: (tabId: TabId) => void;
};

export default function WorkflowTabs({ tabs, activeTab, onSelect }: WorkflowTabsProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {tabs.map(({ id, label }, index) => (
        <div key={id} className="flex items-center gap-2">
          <button
            onClick={() => onSelect(id)}
            className={`rounded-md px-3 py-2 text-sm ${activeTab === id ? "bg-ink text-white" : "bg-ink/10"}`}
          >
            {label}
          </button>
          {index < tabs.length - 1 ? <span className="text-ink/50">→</span> : null}
        </div>
      ))}
    </div>
  );
}

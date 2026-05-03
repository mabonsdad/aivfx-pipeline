type GenerateInputMode = "start_video" | "start_end" | "start_only";

type CreateRoutePickerProps = {
  activeMode: GenerateInputMode;
  onSelect: (mode: GenerateInputMode) => void;
};

const ROUTES: Array<{
  id: GenerateInputMode;
  title: string;
  body: string;
}> = [
  {
    id: "start_video",
    title: "Use source motion",
    body: "Edit a start frame, then generate motion from the working range video.",
  },
  {
    id: "start_end",
    title: "Animate between two frames",
    body: "Edit both the start and end frames, then generate a transition between them.",
  },
  {
    id: "start_only",
    title: "Animate from start frame",
    body: "Generate a new clip from the edited start frame without using source motion.",
  },
];

export default function CreateRoutePicker({ activeMode, onSelect }: CreateRoutePickerProps) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-semibold text-ink">Select Creation Mode</p>
        <p className="text-xs text-ink/60">Choose the generation method for this working range. The rest of the flow will follow it.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {ROUTES.map((route) => {
          const selected = activeMode === route.id;
          return (
            <button
              key={route.id}
              type="button"
              onClick={() => {
                onSelect(route.id);
              }}
              className={`rounded-lg border p-3 text-left transition ${
                selected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white hover:border-ink/20"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-ink">{route.title}</p>
              </div>
              <p className="mt-1 text-sm text-ink/70">{route.body}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

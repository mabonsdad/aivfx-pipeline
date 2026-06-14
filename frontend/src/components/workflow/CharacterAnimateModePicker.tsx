import {
  CHARACTER_ANIMATE_MODE_CONFIGS,
  type CharacterAnimateMode,
} from "../../lib/characterAnimate/characterAnimateModeRegistry";

type CharacterAnimateModePickerProps = {
  activeMode: CharacterAnimateMode;
  onSelect: (mode: CharacterAnimateMode) => void;
  sourceMediaKind?: "video" | "audio";
};

const MODES = (["pose_video", "audio_driven"] as CharacterAnimateMode[]).map((modeId) => {
  const config = CHARACTER_ANIMATE_MODE_CONFIGS[modeId];
  return {
    id: config.id,
    title: config.title,
    body: config.description,
  };
});

export default function CharacterAnimateModePicker({
  activeMode,
  onSelect,
  sourceMediaKind = "video",
}: CharacterAnimateModePickerProps) {
  const audioOnlySource = sourceMediaKind === "audio";
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-semibold text-ink">Select Creation Mode</p>
        <p className="text-xs text-ink/60">
          {audioOnlySource
            ? "This task was created from source audio, so animation must be audio-driven."
            : "Choose whether the character animation is driven from pose video or extracted source audio."}
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {MODES.map((mode) => {
          const selected = activeMode === mode.id;
          const disabled = audioOnlySource && mode.id === "pose_video";
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => onSelect(mode.id)}
              disabled={disabled}
              className={`rounded-lg border p-3 text-left transition ${
                selected ? "border-teal-500 bg-teal-50" : "border-ink/10 bg-white hover:border-ink/20"
              } ${disabled ? "cursor-not-allowed opacity-50 hover:border-ink/10" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-ink">{mode.title}</p>
                {disabled ? <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink/55">Video only</span> : null}
              </div>
              <p className="mt-1 text-sm text-ink/70">{mode.body}</p>
              {disabled ? (
                <p className="mt-2 text-xs text-ink/60">
                  Upload a source video to use pose-driven animation.
                </p>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

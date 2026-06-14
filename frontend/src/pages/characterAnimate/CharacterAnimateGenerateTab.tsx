import { CopyIcon, DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { getCharacterAnimateModeConfig, type CharacterAnimateModeConfig, type CharacterAnimateModelOption } from "../../lib/characterAnimate/characterAnimateModeRegistry";
import type { SegmentGeneration } from "../../types/api";
import WaveformPreview from "../../components/workflow/WaveformPreview";
import { copyTextToClipboard } from "../../lib/clipboard";

type CharacterAnimateGenerateTabProps = {
  mode: CharacterAnimateModeConfig["id"];
  sourceMediaKind?: "video" | "audio";
  sourceAudioUrl?: string | null;
  sourceWaveformUrl?: string | null;
  sourceFrameCount?: number | null;
  selectedSegmentStartFrame?: number | null;
  selectedSegmentEndFrameExclusive?: number | null;
  selectedSegmentStartTimecode?: string | null;
  selectedSegmentEndTimecode?: string | null;
  selectedModel: string;
  modelOptions: CharacterAnimateModelOption[];
  onSelectModel: (model: string) => void;
  selectedSegmentLabel: string | null;
  selectedSegmentDurationSec: number | null;
  selectedCharacterCount: number;
  prompt: string;
  onPromptChange: (value: string) => void;
  outputAspectRatio: string;
  onOutputAspectRatioChange: (value: string) => void;
  bodyControl: boolean;
  onBodyControlChange: (value: boolean) => void;
  expressionIntensity: number;
  onExpressionIntensityChange: (value: number) => void;
  klingMode: "std" | "pro";
  onKlingModeChange: (value: "std" | "pro") => void;
  klingCharacterOrientation: "image" | "video";
  onKlingCharacterOrientationChange: (value: "image" | "video") => void;
  omnihumanResolution: "720p" | "1080p";
  onOmnihumanResolutionChange: (value: "720p" | "1080p") => void;
  seedanceResolution: "480p" | "720p" | "1080p";
  onSeedanceResolutionChange: (value: "480p" | "720p" | "1080p") => void;
  seedanceAspectRatio: "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  onSeedanceAspectRatioChange: (value: "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16") => void;
  characterImageValidationError?: string | null;
  onGenerate: () => void;
  isGenerating: boolean;
  generations: SegmentGeneration[];
  selectedGenerationId: string | null;
  onSelectGeneration: (genId: string) => void;
  onPreviewGeneration: (generation: SegmentGeneration) => void;
  onDeleteGeneration: (generation: SegmentGeneration) => void;
};

const ACT_TWO_RATIO_OPTIONS = [
  { value: "1280:720", label: "16:9" },
  { value: "720:1280", label: "9:16" },
  { value: "960:960", label: "1:1" },
  { value: "1104:832", label: "4:3" },
  { value: "832:1104", label: "3:4" },
  { value: "1584:672", label: "21:9" },
] as const;

const SEEDANCE_ASPECT_RATIO_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "21:9", label: "21:9" },
  { value: "16:9", label: "16:9" },
  { value: "4:3", label: "4:3" },
  { value: "1:1", label: "1:1" },
  { value: "3:4", label: "3:4" },
  { value: "9:16", label: "9:16" },
] as const;

function formatModelLabel(generation: SegmentGeneration) {
  const rawLabel =
    generation.characterAnimation?.modelLabel ??
    generation.characterAnimation?.model ??
    generation.generationSettings?.requestedModel ??
    generation.generationSettings?.model ??
    generation.luma.model;
  return typeof rawLabel === "string" && rawLabel.trim() ? rawLabel : "Character animation";
}

function generationStatusTone(status: SegmentGeneration["status"]) {
  if (status === "failed") return "text-rose-700";
  if (status === "complete") return "text-emerald-700";
  return "text-amber-700";
}

function generationPosterFrameClass(generation: SegmentGeneration) {
  const ratioValue =
    generation.characterAnimation?.outputAspectRatio ??
    generation.generationSettings?.outputAspectRatio ??
    null;
  if (typeof ratioValue === "string" && ratioValue.includes(":")) {
    const [left, right] = ratioValue.split(":").map(Number);
    if (Number.isFinite(left) && Number.isFinite(right) && right > left) {
      return "aspect-[3/4]";
    }
  }
  const storedOutput = generation.generationSettings?.storedOutput;
  const width = Number(storedOutput?.width ?? 0);
  const height = Number(storedOutput?.height ?? 0);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > width) {
    return "aspect-[3/4]";
  }
  return "aspect-video";
}

export default function CharacterAnimateGenerateTab({
  mode,
  sourceMediaKind = "video",
  sourceAudioUrl,
  sourceWaveformUrl,
  sourceFrameCount,
  selectedSegmentStartFrame,
  selectedSegmentEndFrameExclusive,
  selectedSegmentStartTimecode,
  selectedSegmentEndTimecode,
  selectedModel,
  modelOptions,
  onSelectModel,
  selectedSegmentLabel,
  selectedSegmentDurationSec,
  selectedCharacterCount,
  prompt,
  onPromptChange,
  outputAspectRatio,
  onOutputAspectRatioChange,
  bodyControl,
  onBodyControlChange,
  expressionIntensity,
  onExpressionIntensityChange,
  klingMode,
  onKlingModeChange,
  klingCharacterOrientation,
  onKlingCharacterOrientationChange,
  omnihumanResolution,
  onOmnihumanResolutionChange,
  seedanceResolution,
  onSeedanceResolutionChange,
  seedanceAspectRatio,
  onSeedanceAspectRatioChange,
  characterImageValidationError,
  onGenerate,
  isGenerating,
  generations,
  selectedGenerationId,
  onSelectGeneration,
  onPreviewGeneration,
  onDeleteGeneration,
}: CharacterAnimateGenerateTabProps) {
  const modeConfig = getCharacterAnimateModeConfig(mode);
  const selectedModelOption = modelOptions.find((option) => option.value === selectedModel) ?? null;
  const usesPrompt = Boolean(selectedModelOption?.supportsPrompt);
  const isRunwayModel = selectedModel === "runway_act_two";
  const isKlingMotionModel = selectedModel === "kling_v3_motion_control";
  const isSeedanceModel = selectedModel === "seedance_2_0_reference_to_video";
  const isOmnihumanModel = selectedModel === "omnihuman_v1_5";
  const durationLimitWarning =
    isRunwayModel
      ? selectedSegmentDurationSec && selectedSegmentDurationSec > 30
        ? "Runway Act-Two supports up to 30 seconds. Shorten the working range before generating."
        : null
      : isKlingMotionModel
        ? selectedSegmentDurationSec && selectedSegmentDurationSec > (klingCharacterOrientation === "video" ? 30 : 10)
          ? `Kling 3.0 Motion Control supports up to ${klingCharacterOrientation === "video" ? "30" : "10"} seconds with ${klingCharacterOrientation} orientation. Shorten the working range or switch orientation.`
          : null
        : isSeedanceModel
          ? mode === "pose_video"
            ? selectedSegmentDurationSec && (selectedSegmentDurationSec < 2 || selectedSegmentDurationSec > 15)
              ? "Seedance 2.0 requires a motion-video working range between 2 and 15 seconds."
              : null
            : selectedSegmentDurationSec && selectedSegmentDurationSec > 15
              ? "Seedance 2.0 supports up to 15 seconds of driving audio."
              : null
          : omnihumanResolution === "1080p"
            ? selectedSegmentDurationSec && selectedSegmentDurationSec > 30
              ? "OmniHuman at 1080p supports up to 30 seconds. Use a shorter working range or switch to 720p."
              : null
            : selectedSegmentDurationSec && selectedSegmentDurationSec > 60
              ? "OmniHuman at 720p supports up to 60 seconds. Shorten the working range before generating."
              : null;
  const canGenerate = Boolean(
    selectedSegmentLabel && selectedCharacterCount > 0 && !isGenerating && !durationLimitWarning && !characterImageValidationError,
  );
  const isAudioSource = sourceMediaKind === "audio";
  const rangeStartRatio =
    isAudioSource && sourceFrameCount && sourceFrameCount > 0 && selectedSegmentStartFrame !== null && selectedSegmentStartFrame !== undefined
      ? selectedSegmentStartFrame / sourceFrameCount
      : null;
  const rangeEndRatio =
    isAudioSource && sourceFrameCount && sourceFrameCount > 0 && selectedSegmentEndFrameExclusive !== null && selectedSegmentEndFrameExclusive !== undefined
      ? selectedSegmentEndFrameExclusive / sourceFrameCount
      : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink/15 bg-white p-4">
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold text-ink">Generate character animation</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-generate-model">
                  Model
                </label>
                <select
                  id="character-generate-model"
                  value={selectedModel}
                  onChange={(event) => onSelectModel(event.target.value)}
                  className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                >
                  {modelOptions.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </div>
              {usesPrompt ? (
                <div className="space-y-1">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-generate-prompt">
                    Optional prompt
                  </label>
                  <textarea
                    id="character-generate-prompt"
                    value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    placeholder="A person gives an energetic product demo, speaking directly to camera."
                    rows={4}
                    className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                  />
                </div>
              ) : null}
              {isRunwayModel ? (
                <>
                  <div className="space-y-1">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-output-ratio">
                      Output aspect
                    </label>
                    <select
                      id="character-output-ratio"
                      value={outputAspectRatio}
                      onChange={(event) => onOutputAspectRatioChange(event.target.value)}
                      className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                    >
                      {ACT_TWO_RATIO_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex items-center gap-3 rounded-lg border border-ink/10 bg-bg px-3 py-3 text-sm text-ink/80">
                      <input type="checkbox" checked={bodyControl} onChange={(event) => onBodyControlChange(event.target.checked)} />
                      <span>
                        <span className="block font-medium text-ink">Body control</span>
                        <span className="block text-xs text-ink/60">Use full-body motion from the driving performance where supported.</span>
                      </span>
                    </label>
                    <div className="space-y-1 rounded-lg border border-ink/10 bg-bg px-3 py-3">
                      <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-expression-intensity">
                        Expression intensity
                      </label>
                      <select
                        id="character-expression-intensity"
                        value={String(expressionIntensity)}
                        onChange={(event) => onExpressionIntensityChange(Number(event.target.value))}
                        className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                      >
                        <option value="1">1 - Subtle</option>
                        <option value="2">2 - Light</option>
                        <option value="3">3 - Medium</option>
                        <option value="4">4 - Strong</option>
                        <option value="5">5 - High</option>
                      </select>
                    </div>
                  </div>
                </>
              ) : null}
              {isKlingMotionModel ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1 rounded-lg border border-ink/10 bg-bg px-3 py-3">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-kling-mode">
                      Kling mode
                    </label>
                    <select
                      id="character-kling-mode"
                      value={klingMode}
                      onChange={(event) => onKlingModeChange(event.target.value as "std" | "pro")}
                      className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                    >
                      <option value="std">Standard (720p)</option>
                      <option value="pro">Pro (1080p)</option>
                    </select>
                  </div>
                  <div className="space-y-1 rounded-lg border border-ink/10 bg-bg px-3 py-3">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-kling-orientation">
                      Character orientation
                    </label>
                    <select
                      id="character-kling-orientation"
                      value={klingCharacterOrientation}
                      onChange={(event) => onKlingCharacterOrientationChange(event.target.value as "image" | "video")}
                      className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                    >
                      <option value="image">Image orientation (max 10s)</option>
                      <option value="video">Video orientation (max 30s)</option>
                    </select>
                  </div>
                </div>
              ) : null}
              {isSeedanceModel ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1 rounded-lg border border-ink/10 bg-bg px-3 py-3">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-seedance-resolution">
                      Output resolution
                    </label>
                    <select
                      id="character-seedance-resolution"
                      value={seedanceResolution}
                      onChange={(event) => onSeedanceResolutionChange(event.target.value as "480p" | "720p" | "1080p")}
                      className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                    >
                      <option value="480p">480p</option>
                      <option value="720p">720p</option>
                      <option value="1080p">1080p</option>
                    </select>
                  </div>
                  <div className="space-y-1 rounded-lg border border-ink/10 bg-bg px-3 py-3">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-seedance-aspect">
                      Output aspect
                    </label>
                    <select
                      id="character-seedance-aspect"
                      value={seedanceAspectRatio}
                      onChange={(event) => onSeedanceAspectRatioChange(event.target.value as "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16")}
                      className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                    >
                      {SEEDANCE_ASPECT_RATIO_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
              {isOmnihumanModel ? (
                <div className="space-y-1">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-ink/55" htmlFor="character-output-resolution">
                    Output resolution
                  </label>
                  <select
                    id="character-output-resolution"
                    value={omnihumanResolution}
                    onChange={(event) => onOmnihumanResolutionChange(event.target.value as "720p" | "1080p")}
                    className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-200"
                  >
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                </div>
              ) : null}
              {durationLimitWarning ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{durationLimitWarning}</div>
              ) : null}
              {characterImageValidationError ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{characterImageValidationError}</div>
              ) : null}
              <button
                type="button"
                onClick={onGenerate}
                disabled={!canGenerate}
                className="w-full rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-ink/20"
              >
                {isGenerating ? "Queueing..." : "Generate character animation"}
              </button>
            </div>
            <div className="rounded-lg border border-ink/10 bg-bg px-3 py-3 text-xs text-ink/70">
              <p className="font-medium text-ink/85">{modeConfig.title}</p>
              {selectedModelOption?.summary ? <p className="mt-1">{selectedModelOption.summary}</p> : null}
              {isRunwayModel ? (
                <>
                  <p className="mt-1">Use a clean single-subject driving video. This path is best for body movement, acting, and gesture transfer.</p>
                  <p className="mt-1">Runway Act-Two supports up to 30 seconds and uses the selected output aspect ratio.</p>
                  <p className="mt-1">The selected character image must be at least half as wide as it is tall.</p>
                </>
              ) : isKlingMotionModel ? (
                <>
                  <p className="mt-1">Kling 3.0 Motion Control transfers motion from the selected reference video to the selected character image.</p>
                  <p className="mt-1">Use `image` orientation for closer fidelity to the still image or `video` orientation for up to 30 seconds of motion reference.</p>
                </>
              ) : isSeedanceModel ? (
                <>
                  <p className="mt-1">Seedance 2.0 combines the selected character image with the current motion video or audio range and follows asset tokens in the prompt.</p>
                  <p className="mt-1">Use concise prompts that explicitly mention `@Image1`, plus `@Video1` or `@Audio1` depending on the mode.</p>
                </>
              ) : (
                <>
                  <p className="mt-1">Audio is extracted automatically from the selected video range. Use the prompt only to steer tone, framing, or performance style.</p>
                  <p className="mt-1">OmniHuman supports up to 60 seconds at 720p and 30 seconds at 1080p.</p>
                </>
              )}
              {isKlingMotionModel ? <p className="mt-2 text-ink/60">Standard mode targets 720p. Pro mode targets 1080p.</p> : null}
              {isOmnihumanModel ? <p className="mt-2 text-ink/60">720p allows longer audio-driven generations and is usually the safer starting point.</p> : null}
              {isAudioSource ? <p className="mt-2 text-ink/60">The selected working range from the uploaded source audio will drive the generated performance.</p> : null}
              {isAudioSource && (sourceAudioUrl || sourceWaveformUrl) ? (
                <div className="mt-3 space-y-3">
                  {sourceWaveformUrl ? (
                    <WaveformPreview
                      src={sourceWaveformUrl}
                      alt="Source audio waveform"
                      className="max-h-40 w-full rounded border border-ink/10 bg-white"
                      imageClassName="max-h-40 w-full rounded bg-white object-contain"
                      rangeStartRatio={rangeStartRatio}
                      rangeEndRatio={rangeEndRatio}
                      rangeStartLabel={selectedSegmentStartTimecode}
                      rangeEndLabel={selectedSegmentEndTimecode}
                    />
                  ) : null}
                  {sourceAudioUrl ? <audio src={sourceAudioUrl} controls preload="metadata" className="w-full" /> : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-ink/15 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">Generated outputs</p>
            <p className="text-xs text-ink/60">Outputs shown here are limited to the current character-animation mode and working range.</p>
          </div>
          <span className="rounded-full bg-bg px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink/55">
            {generations.length} item{generations.length === 1 ? "" : "s"}
          </span>
        </div>

        {generations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink/15 bg-bg px-4 py-8 text-center text-sm text-ink/60">
            No character animations for this mode and working range yet.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {generations.map((generation) => {
              const selected = generation.genId === selectedGenerationId;
              const isComplete = generation.status === "complete" && Boolean(generation.downloadUrl);
              const posterFrameClass = generationPosterFrameClass(generation);
              const copyablePrompt = generation.characterAnimation?.prompt?.trim() || generation.luma.prompt?.trim() || "";
              return (
                <div key={generation.genId} className="overflow-hidden rounded-xl border border-ink/12 bg-white shadow-sm">
                  <div className={`relative overflow-hidden bg-ink/5 ${posterFrameClass}`}>
                    {isComplete && generation.posterUrl ? (
                      <button
                        type="button"
                        className="h-full w-full disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!generation.downloadUrl}
                        onClick={() => onSelectGeneration(generation.genId)}
                        title={generation.downloadUrl ? `Use ${formatModelLabel(generation)}` : "Video unavailable"}
                      >
                        <img src={generation.posterUrl} alt={formatModelLabel(generation)} className="h-full w-full object-contain" />
                      </button>
                    ) : (
                      <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(15,176,155,0.16),_transparent_55%)]">
                        {generation.status === "failed" ? (
                          <div className="px-4 text-center text-sm text-rose-700">Generation failed</div>
                        ) : (
                          <div className="flex flex-col items-center gap-2 text-sm text-ink/55">
                            <span className="h-8 w-8 animate-spin rounded-full border-2 border-ink/15 border-t-teal-500" />
                            <span>{generation.status === "queued" ? "Queued" : "Running"}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 p-3">
                    <div className="space-y-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">{formatModelLabel(generation)}</p>
                        <span className={`text-[11px] font-semibold uppercase tracking-wide ${generationStatusTone(generation.status)}`}>
                          {generation.status}
                        </span>
                      </div>
                      <p className="text-xs text-ink/60">
                        {generation.characterAnimation?.mode === "audio_driven" ? "Character image + audio" : "Character image + pose video"}
                      </p>
                    </div>
                    {generation.error ? <p className="text-xs text-rose-700">{generation.error}</p> : null}
                    <div className="flex items-center gap-2">
                      {isComplete ? (
                        <button
                          type="button"
                          className={`rounded border px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
                            selected ? "border-teal-500 bg-teal-50 text-ink" : "border-ink/20 bg-white text-ink"
                          }`}
                          disabled={!generation.downloadUrl}
                          onClick={() => onSelectGeneration(generation.genId)}
                        >
                          {selected ? "Selected" : "Select"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded border border-ink/20 bg-white px-3 py-2 text-xs text-ink/60"
                          disabled
                        >
                          {generation.status === "failed" ? "Failed" : "Waiting..."}
                        </button>
                      )}
                      <IconActionButton
                        title="Preview"
                        disabled={!generation.downloadUrl}
                        onClick={() => onPreviewGeneration(generation)}
                      >
                        <PreviewIcon />
                      </IconActionButton>
                      {generation.downloadUrl ? (
                        <IconActionButton href={generation.downloadUrl} download title="Download full quality video">
                          <DownloadIcon />
                        </IconActionButton>
                      ) : null}
                      {copyablePrompt ? (
                        <IconActionButton title="Copy prompt" onClick={() => void copyTextToClipboard(copyablePrompt)}>
                          <CopyIcon />
                        </IconActionButton>
                      ) : null}
                      {generation.status === "complete" || generation.status === "failed" ? (
                        <IconActionButton title="Delete output" tone="danger" onClick={() => onDeleteGeneration(generation)}>
                          <DeleteIcon />
                        </IconActionButton>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

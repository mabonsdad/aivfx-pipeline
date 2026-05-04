export type GenerateInputMode = "start_video" | "start_end" | "start_only";

export type PostProcessToolId = "extend" | "reconcileTiming" | "trackedCleanup" | "mergeIntoSource";

export type GenerationModeConfig = {
  id: GenerateInputMode;
  title: string;
  description: string;
  requiresEndFrame: boolean;
  postProcessTools: Record<PostProcessToolId, boolean>;
};

export const GENERATION_MODE_CONFIGS: Record<GenerateInputMode, GenerationModeConfig> = {
  start_video: {
    id: "start_video",
    title: "Use source motion",
    description: "Edit a start frame, then generate motion from the working range video.",
    requiresEndFrame: false,
    postProcessTools: {
      extend: true,
      reconcileTiming: true,
      trackedCleanup: true,
      mergeIntoSource: true,
    },
  },
  start_end: {
    id: "start_end",
    title: "Animate between two frames",
    description: "Edit both the start and end frames, then generate a transition between them.",
    requiresEndFrame: true,
    postProcessTools: {
      extend: true,
      reconcileTiming: false,
      trackedCleanup: false,
      mergeIntoSource: true,
    },
  },
  start_only: {
    id: "start_only",
    title: "Animate from start frame",
    description: "Generate a new clip from the edited start frame without using source motion.",
    requiresEndFrame: false,
    postProcessTools: {
      extend: true,
      reconcileTiming: false,
      trackedCleanup: false,
      mergeIntoSource: false,
    },
  },
};

export function getGenerationModeConfig(mode: GenerateInputMode): GenerationModeConfig {
  return GENERATION_MODE_CONFIGS[mode];
}

export function generationModeSupportsTool(mode: GenerateInputMode, tool: PostProcessToolId): boolean {
  return GENERATION_MODE_CONFIGS[mode].postProcessTools[tool];
}

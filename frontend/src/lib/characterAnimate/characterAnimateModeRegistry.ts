export type CharacterAnimateMode = "pose_video" | "audio_driven";

export type CharacterAnimateModeConfig = {
  id: CharacterAnimateMode;
  title: string;
  description: string;
};

export type CharacterAnimateModelOption = {
  value: "runway_act_two" | "kling_v3_motion_control" | "seedance_2_0_reference_to_video" | "omnihuman_v1_5";
  label: string;
  summary: string;
  supportsPrompt?: boolean;
};

export const CHARACTER_ANIMATE_MODE_CONFIGS: Record<CharacterAnimateMode, CharacterAnimateModeConfig> = {
  pose_video: {
    id: "pose_video",
    title: "Character image + pose video",
    description: "Drive the character from a selected source-video range.",
  },
  audio_driven: {
    id: "audio_driven",
    title: "Character image + audio",
    description: "Drive the character from extracted speech or singing audio.",
  },
};

export const CHARACTER_ANIMATE_MODEL_OPTIONS: Record<CharacterAnimateMode, CharacterAnimateModelOption[]> = {
  pose_video: [
    {
      value: "runway_act_two",
      label: "Runway Act-Two",
      summary: "Best fit for actor-to-character performance capture from a driving video and character image.",
    },
    {
      value: "kling_v3_motion_control",
      label: "Kling 3.0 Motion Control",
      summary: "Strong motion-transfer alternative for character image plus reference motion video, with 720p or 1080p output.",
      supportsPrompt: true,
    },
    {
      value: "seedance_2_0_reference_to_video",
      label: "ByteDance Seedance 2.0",
      summary: "Flexible cinematic reference-to-video model using the character image plus the selected motion video range.",
      supportsPrompt: true,
    },
  ],
  audio_driven: [
    {
      value: "omnihuman_v1_5",
      label: "ByteDance OmniHuman v1.5",
      summary: "Audio-driven human animation from a character image and extracted source audio.",
      supportsPrompt: true,
    },
    {
      value: "seedance_2_0_reference_to_video",
      label: "ByteDance Seedance 2.0",
      summary: "Flexible multimodal reference-to-video model using the character image plus the selected source audio range.",
      supportsPrompt: true,
    },
  ],
};

export function getCharacterAnimateModeConfig(mode: CharacterAnimateMode): CharacterAnimateModeConfig {
  return CHARACTER_ANIMATE_MODE_CONFIGS[mode];
}

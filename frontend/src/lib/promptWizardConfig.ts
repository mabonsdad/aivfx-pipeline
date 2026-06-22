import type { VideoModelId } from "./generated/videoContracts";

export type PromptWizardMode = "start_video" | "start_end" | "edit_video";

export type PromptWizardProvider = "Luma" | "fal.ai" | "Runway" | "Replicate" | "Runware";

export type PromptWizardPromptStrategy =
  | "luma_descriptive_change"
  | "happy_horse_video_image_markers"
  | "runway_aleph_start_with_input_image"
  | "kling_angle_marker_video_image"
  | "seedance_reference_tags"
  | "wan_videoedit_focused_change"
  | "kling_start_end_motion_camera"
  | "wan_start_end_motion_transform"
  | "veo_start_end_visual_transition"
  | "ltx_start_end_motion_transition";

export type PromptWizardModelConfig = {
  modelId: VideoModelId;
  dropdownName: string;
  mode: PromptWizardMode;
  provider: PromptWizardProvider;
  providerModel: string;
  endpointUsed: string;
  requiredMarkers: string[];
  supportsNegativePrompt: false;
  promptStrategy: PromptWizardPromptStrategy;
};

export type PromptWizardAdminModelConfig = {
  selected_model: string;
  dropdown_name: string;
  mode: PromptWizardMode;
  provider: PromptWizardProvider;
  provider_model: string;
  endpoint_used: string;
  required_markers: string[];
  supports_negative_prompt: false;
  prompt_strategy: PromptWizardPromptStrategy;
};

export type PromptWizardAdminConfig = {
  schemaVersion: number;
  systemPrompt: string;
  models: PromptWizardAdminModelConfig[];
  updatedAt?: string | null;
  updatedBy?: string | null;
};

const PROMPT_WIZARD_MODEL_CONFIGS: PromptWizardAdminModelConfig[] = [
  {
    selected_model: "ray-3.2-720p",
    dropdown_name: "Luma Ray 3.2 720p",
    mode: "start_video",
    provider: "Luma",
    provider_model: "ray-3.2",
    endpoint_used: "POST https://agents.lumalabs.ai/v1/generations (type=video_edit)",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "luma_descriptive_change",
  },
  {
    selected_model: "ray-3.2-1080p",
    dropdown_name: "Luma Ray 3.2 1080p",
    mode: "start_video",
    provider: "Luma",
    provider_model: "ray-3.2",
    endpoint_used: "POST https://agents.lumalabs.ai/v1/generations (type=video_edit)",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "luma_descriptive_change",
  },
  {
    selected_model: "happy-horse-video-edit",
    dropdown_name: "Happy Horse 1.0 Video Edit",
    mode: "start_video",
    provider: "fal.ai",
    provider_model: "alibaba/happy-horse/video-edit",
    endpoint_used: "POST https://queue.fal.run/alibaba/happy-horse/video-edit",
    required_markers: ["@Video1", "@Image1"],
    supports_negative_prompt: false,
    prompt_strategy: "happy_horse_video_image_markers",
  },
  {
    selected_model: "runway-gen4-aleph",
    dropdown_name: "Runway Aleph 2.0",
    mode: "start_video",
    provider: "Runway",
    provider_model: "aleph2",
    endpoint_used: "POST https://api.dev.runwayml.com/v1/video_to_video",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "runway_aleph_start_with_input_image",
  },
  {
    selected_model: "kling-o1",
    dropdown_name: "Kling O1 Edit",
    mode: "start_video",
    provider: "Replicate",
    provider_model: "kwaivgi/kling-o1",
    endpoint_used: "POST https://api.replicate.com/v1/predictions",
    required_markers: ["<<<video_1>>>", "<<<image_1>>>"],
    supports_negative_prompt: false,
    prompt_strategy: "kling_angle_marker_video_image",
  },
  {
    selected_model: "kling-v3-omni-video",
    dropdown_name: "Kling v3 Omni Video",
    mode: "start_video",
    provider: "Replicate",
    provider_model: "kwaivgi/kling-v3-omni-video",
    endpoint_used: "POST https://api.replicate.com/v1/predictions",
    required_markers: ["<<<video_1>>>", "<<<image_1>>>"],
    supports_negative_prompt: false,
    prompt_strategy: "kling_angle_marker_video_image",
  },
  {
    selected_model: "seedance-2.0-reference-to-video",
    dropdown_name: "Seedance 2.0 Reference to Video",
    mode: "start_video",
    provider: "fal.ai",
    provider_model: "bytedance/seedance-2.0/reference-to-video",
    endpoint_used: "POST https://queue.fal.run/bytedance/seedance-2.0/reference-to-video",
    required_markers: ["@Video1", "@Image1"],
    supports_negative_prompt: false,
    prompt_strategy: "seedance_reference_tags",
  },
  {
    selected_model: "wan2.7-videoedit",
    dropdown_name: "Wan 2.7 VideoEdit",
    mode: "start_video",
    provider: "Replicate",
    provider_model: "wan-video/wan-2.7-videoedit",
    endpoint_used: "POST https://api.replicate.com/v1/models/wan-video/wan-2.7-videoedit/predictions",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "wan_videoedit_focused_change",
  },
  {
    selected_model: "happy-horse-video-edit",
    dropdown_name: "Happy Horse 1.0 Video Edit",
    mode: "edit_video",
    provider: "fal.ai",
    provider_model: "alibaba/happy-horse/video-edit",
    endpoint_used: "POST https://queue.fal.run/alibaba/happy-horse/video-edit",
    required_markers: ["@Video1", "@Image1"],
    supports_negative_prompt: false,
    prompt_strategy: "happy_horse_video_image_markers",
  },
  {
    selected_model: "runway-gen4-aleph",
    dropdown_name: "Runway Aleph 2.0",
    mode: "edit_video",
    provider: "Runway",
    provider_model: "aleph2",
    endpoint_used: "POST https://api.dev.runwayml.com/v1/video_to_video",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "runway_aleph_start_with_input_image",
  },
  {
    selected_model: "kling-v3-omni-video",
    dropdown_name: "Kling v3 Omni Video",
    mode: "edit_video",
    provider: "Replicate",
    provider_model: "kwaivgi/kling-v3-omni-video",
    endpoint_used: "POST https://api.replicate.com/v1/predictions",
    required_markers: ["<<<video_1>>>", "<<<image_1>>>"],
    supports_negative_prompt: false,
    prompt_strategy: "kling_angle_marker_video_image",
  },
  {
    selected_model: "seedance-2.0-reference-to-video",
    dropdown_name: "Seedance 2.0 Reference to Video",
    mode: "edit_video",
    provider: "fal.ai",
    provider_model: "bytedance/seedance-2.0/reference-to-video",
    endpoint_used: "POST https://queue.fal.run/bytedance/seedance-2.0/reference-to-video",
    required_markers: ["@Video1"],
    supports_negative_prompt: false,
    prompt_strategy: "seedance_reference_tags",
  },
  {
    selected_model: "wan2.7-videoedit",
    dropdown_name: "Wan 2.7 VideoEdit",
    mode: "edit_video",
    provider: "Replicate",
    provider_model: "wan-video/wan-2.7-videoedit",
    endpoint_used: "POST https://api.replicate.com/v1/models/wan-video/wan-2.7-videoedit/predictions",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "wan_videoedit_focused_change",
  },
  {
    selected_model: "kling-2.6",
    dropdown_name: "Kling 2.6",
    mode: "start_end",
    provider: "Runware",
    provider_model: "klingai:kling-video@2.6-pro",
    endpoint_used: "POST https://api.runware.ai/v1",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "kling_start_end_motion_camera",
  },
  {
    selected_model: "wan2.7-i2v",
    dropdown_name: "Wan 2.7 Image to Video",
    mode: "start_end",
    provider: "Replicate",
    provider_model: "wan-video/wan-2.7-i2v",
    endpoint_used: "POST https://api.replicate.com/v1/models/wan-video/wan-2.7-i2v/predictions",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "wan_start_end_motion_transform",
  },
  {
    selected_model: "ltx-2.3-pro",
    dropdown_name: "LTX 2.3 Pro",
    mode: "start_end",
    provider: "Replicate",
    provider_model: "lightricks/ltx-2.3-pro",
    endpoint_used: "POST https://api.replicate.com/v1/models/lightricks/ltx-2.3-pro/predictions",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "ltx_start_end_motion_transition",
  },
  {
    selected_model: "veo-3.1",
    dropdown_name: "Veo 3.1",
    mode: "start_end",
    provider: "Runware",
    provider_model: "google:3@2",
    endpoint_used: "POST https://api.runware.ai/v1",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "veo_start_end_visual_transition",
  },
  {
    selected_model: "veo-3.1-fast",
    dropdown_name: "Veo 3.1 Fast",
    mode: "start_end",
    provider: "Runware",
    provider_model: "google:3@3",
    endpoint_used: "POST https://api.runware.ai/v1",
    required_markers: [],
    supports_negative_prompt: false,
    prompt_strategy: "veo_start_end_visual_transition",
  },
];

export const DEFAULT_PROMPT_WIZARD_ADMIN_CONFIG: PromptWizardAdminConfig = {
  schemaVersion: 1,
  systemPrompt: "",
  models: PROMPT_WIZARD_MODEL_CONFIGS,
};

function toPromptWizardModelConfig(raw: PromptWizardAdminModelConfig): PromptWizardModelConfig {
  return {
    modelId: raw.selected_model as VideoModelId,
    dropdownName: raw.dropdown_name,
    mode: raw.mode,
    provider: raw.provider,
    providerModel: raw.provider_model,
    endpointUsed: raw.endpoint_used,
    requiredMarkers: raw.required_markers,
    supportsNegativePrompt: false,
    promptStrategy: raw.prompt_strategy,
  };
}

export function getPromptWizardModelConfig(
  modelId: VideoModelId,
  mode: PromptWizardMode,
  modelConfigs?: PromptWizardAdminModelConfig[] | null,
): PromptWizardModelConfig | null {
  const source = Array.isArray(modelConfigs) && modelConfigs.length ? modelConfigs : PROMPT_WIZARD_MODEL_CONFIGS;
  const raw = source.find((config) => config.selected_model === modelId && config.mode === mode);
  return raw ? toPromptWizardModelConfig(raw) : null;
}

export type PromptWizardRequest = {
  selected_model: string;
  provider: PromptWizardProvider;
  provider_model: string;
  endpoint_used?: string;
  mode: PromptWizardMode;
  user_draft_prompt: string;
  has_source_video: boolean;
  has_edited_first_frame: boolean;
  has_last_frame: boolean;
  app_required_markers: string[];
  supports_negative_prompt: false;
  duration_seconds?: number | null;
  aspect_ratio?: string | null;
  luma_mode?: "adhere" | "flex" | "reimagine" | null;
  user_visible_model_name: string;
  first_frame_variant_id?: string | null;
  selected_reference_ids?: string[];
};

export type PromptWizardResult = {
  recommended_prompt: string;
  negative_prompt: "";
  user_advice: string;
  detected_intent: string;
  preservation_targets: string[];
  required_markers_present: boolean;
  warnings: string[];
};

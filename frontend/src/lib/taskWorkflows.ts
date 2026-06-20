import { PRIMARY_WORKFLOW_TABS, type PrimaryWorkflowSection } from "./workflowSections";
import type { CharacterAnimateMode } from "./characterAnimate/characterAnimateModeRegistry";
import type { GenerateInputMode } from "./generationModeRegistry";

export type TaskWorkflowId =
  | "source_video_flow"
  | "source_video_start_end_workflow"
  | "source_video_edit_workflow"
  | "character_animate_workflow"
  | "character_animate_audio_workflow"
  | "simple_generation_workflow"
  | "canvas_workflow";

export type UserFacingTaskWorkflowId =
  | "source_video_flow"
  | "source_video_start_end_workflow"
  | "source_video_edit_workflow"
  | "character_animate_workflow"
  | "character_animate_audio_workflow"
  | "simple_generation_workflow";

export type HomeTaskWorkflowId = UserFacingTaskWorkflowId | "canvas_workflow";

export type TaskWorkflowConfig = {
  id: TaskWorkflowId;
  label: string;
  shortLabel: string;
  description: string;
  homeTitle: string;
  homeDescription: string;
  primaryTabs: Array<{ id: PrimaryWorkflowSection; label: string }>;
  implemented: boolean;
  userFacing: boolean;
  showOnHome: boolean;
};

export const DEFAULT_TASK_WORKFLOW_ID: TaskWorkflowId = "source_video_flow";

export const SOURCE_VIDEO_WORKFLOW_IDS = [
  "source_video_flow",
  "source_video_start_end_workflow",
  "source_video_edit_workflow",
] as const satisfies TaskWorkflowId[];

export const CHARACTER_ANIMATE_WORKFLOW_IDS = [
  "character_animate_workflow",
  "character_animate_audio_workflow",
] as const satisfies TaskWorkflowId[];

export const USER_FACING_TASK_WORKFLOW_IDS: UserFacingTaskWorkflowId[] = [
  "simple_generation_workflow",
  "character_animate_workflow",
  "character_animate_audio_workflow",
  "source_video_flow",
  "source_video_start_end_workflow",
  "source_video_edit_workflow",
];

export const HOME_TASK_WORKFLOW_IDS: HomeTaskWorkflowId[] = [
  ...USER_FACING_TASK_WORKFLOW_IDS,
  "canvas_workflow",
];

const SOURCE_WORKFLOW_INPUT_MODE: Record<(typeof SOURCE_VIDEO_WORKFLOW_IDS)[number], GenerateInputMode> = {
  source_video_flow: "start_video",
  source_video_start_end_workflow: "start_end",
  source_video_edit_workflow: "edit_video",
};

const CHARACTER_WORKFLOW_MODE: Record<(typeof CHARACTER_ANIMATE_WORKFLOW_IDS)[number], CharacterAnimateMode> = {
  character_animate_workflow: "pose_video",
  character_animate_audio_workflow: "audio_driven",
};

export const TASK_WORKFLOW_CONFIGS: Record<TaskWorkflowId, TaskWorkflowConfig> = {
  source_video_flow: {
    id: "source_video_flow",
    label: "VFX: Video + Start Frame",
    shortLabel: "VFX start",
    description:
      "Edit specific features of the first frame of the video segment while retaining the motion, duration and composition of the video. Good for superficial or localised edits while retaining characters and scenes accurately.",
    homeTitle: "VFX: video + start frame",
    homeDescription:
      "Edit specific features of the first frame of the video segment while retaining the motion, duration and composition of the video. Good for superficial or localised edits while retaining characters and scenes accurately.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
    showOnHome: true,
  },
  source_video_start_end_workflow: {
    id: "source_video_start_end_workflow",
    label: "VFX: Start Frame + End Frame",
    shortLabel: "VFX start/end",
    description:
      "Select and replace a segment of video while matching in and out frames. Good to where motion or duration needs to change.",
    homeTitle: "VFX: start frame + end frame",
    homeDescription:
      "Select and replace a segment of video while matching in and out frames. Good to where motion or duration needs to change.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
    showOnHome: true,
  },
  source_video_edit_workflow: {
    id: "source_video_edit_workflow",
    label: "VFX: Video + Text + Refs",
    shortLabel: "VFX edit",
    description:
      "Use source video plus text prompt, with optional reference imagery, for direct video-editing. Good for more radical changes to the video with new motion, composition and subjects.",
    homeTitle: "VFX: video + text + refs",
    homeDescription:
      "Use source video plus text prompt, with optional reference imagery, for direct video-editing. Good for more radical changes to the video with new motion, composition and subjects.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
    showOnHome: true,
  },
  character_animate_workflow: {
    id: "character_animate_workflow",
    label: "Animate Character: With Pose Video",
    shortLabel: "Character pose",
    description:
      "Use a video of a performance (with or without audio) to drive the motion of a characer animation. Good for a controlled performance.",
    homeTitle: "Animate Character: with pose video",
    homeDescription:
      "Use a video of a performance (with or without audio) to drive the motion of a characer animation. Good for a controlled performance.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
    showOnHome: true,
  },
  character_animate_audio_workflow: {
    id: "character_animate_audio_workflow",
    label: "Animate Character: With Audio",
    shortLabel: "Character audio",
    description:
      "Use Audio to drive lipsync and animation from a still of a character. Good for quickly adding motion and lip sync.",
    homeTitle: "Animate Character: with audio",
    homeDescription:
      "Use Audio to drive lipsync and animation from a still of a character. Good for quickly adding motion and lip sync.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
    showOnHome: true,
  },
  simple_generation_workflow: {
    id: "simple_generation_workflow",
    label: "Previz Workflow",
    shortLabel: "Previz",
    description:
      "Build previs scenes from text and reference imagery, create storyboard frames, generate shots, and iterate with the shared post-process, assets, and reports tooling.",
    homeTitle: "Previz",
    homeDescription: "Use reference images/sheets to create key frames and then generate rough video for each shot.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
    showOnHome: true,
  },
  canvas_workflow: {
    id: "canvas_workflow",
    label: "Canvas Workflow",
    shortLabel: "Canvas",
    description:
      "Reserved workflow surface for canvas-based task tooling that shares the common auth, task, asset, and reporting contract.",
    homeTitle: "Canvas",
    homeDescription: "Collaborator workflow placeholder for the separate canvas surface.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: false,
    userFacing: false,
    showOnHome: true,
  },
};

export function isTaskWorkflowId(value: string | null | undefined): value is TaskWorkflowId {
  const workflowId = typeof value === "string" ? value.trim() : "";
  return Object.prototype.hasOwnProperty.call(TASK_WORKFLOW_CONFIGS, workflowId);
}

export function normalizeTaskWorkflowId(value: string | null | undefined): TaskWorkflowId {
  return isTaskWorkflowId(value) ? value : DEFAULT_TASK_WORKFLOW_ID;
}

export function getTaskWorkflowConfig(value: string | null | undefined): TaskWorkflowConfig {
  return TASK_WORKFLOW_CONFIGS[normalizeTaskWorkflowId(value)];
}

export function isUserFacingTaskWorkflowId(value: string | null | undefined): value is UserFacingTaskWorkflowId {
  const workflowId = typeof value === "string" ? value.trim() : "";
  return USER_FACING_TASK_WORKFLOW_IDS.includes(workflowId as UserFacingTaskWorkflowId);
}

export function isHomeTaskWorkflowId(value: string | null | undefined): value is HomeTaskWorkflowId {
  const workflowId = typeof value === "string" ? value.trim() : "";
  return HOME_TASK_WORKFLOW_IDS.includes(workflowId as HomeTaskWorkflowId);
}

export function isSourceVideoWorkflowId(value: string | null | undefined): value is (typeof SOURCE_VIDEO_WORKFLOW_IDS)[number] {
  const workflowId = typeof value === "string" ? value.trim() : "";
  return SOURCE_VIDEO_WORKFLOW_IDS.includes(workflowId as (typeof SOURCE_VIDEO_WORKFLOW_IDS)[number]);
}

export function isCharacterAnimateWorkflowId(value: string | null | undefined): value is (typeof CHARACTER_ANIMATE_WORKFLOW_IDS)[number] {
  const workflowId = typeof value === "string" ? value.trim() : "";
  return CHARACTER_ANIMATE_WORKFLOW_IDS.includes(workflowId as (typeof CHARACTER_ANIMATE_WORKFLOW_IDS)[number]);
}

export function isPrevizWorkflowId(value: string | null | undefined): value is "simple_generation_workflow" {
  return (typeof value === "string" ? value.trim() : "") === "simple_generation_workflow";
}

export function getFixedGenerationInputModeForWorkflow(value: string | null | undefined): GenerateInputMode | null {
  if (!isSourceVideoWorkflowId(value)) return null;
  return SOURCE_WORKFLOW_INPUT_MODE[normalizeTaskWorkflowId(value) as (typeof SOURCE_VIDEO_WORKFLOW_IDS)[number]];
}

export function getFixedCharacterAnimateModeForWorkflow(value: string | null | undefined): CharacterAnimateMode | null {
  if (!isCharacterAnimateWorkflowId(value)) return null;
  return CHARACTER_WORKFLOW_MODE[normalizeTaskWorkflowId(value) as (typeof CHARACTER_ANIMATE_WORKFLOW_IDS)[number]];
}

export function workflowForSourceVideoMode(mode: GenerateInputMode | null | undefined): TaskWorkflowId {
  if (mode === "start_end") return "source_video_start_end_workflow";
  if (mode === "edit_video") return "source_video_edit_workflow";
  return "source_video_flow";
}

export function workflowForCharacterAnimateMode(mode: CharacterAnimateMode | null | undefined): TaskWorkflowId {
  return mode === "audio_driven" ? "character_animate_audio_workflow" : "character_animate_workflow";
}

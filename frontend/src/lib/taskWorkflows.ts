import { PRIMARY_WORKFLOW_TABS, type PrimaryWorkflowSection } from "./workflowSections";

export type TaskWorkflowId = "source_video_flow" | "character_animate_workflow" | "simple_generation_workflow" | "canvas_workflow";
export type UserFacingTaskWorkflowId = "source_video_flow" | "character_animate_workflow" | "simple_generation_workflow";

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
};

export const DEFAULT_TASK_WORKFLOW_ID: TaskWorkflowId = "source_video_flow";
export const USER_FACING_TASK_WORKFLOW_IDS: UserFacingTaskWorkflowId[] = [
  "simple_generation_workflow",
  "character_animate_workflow",
  "source_video_flow",
];

export const TASK_WORKFLOW_CONFIGS: Record<TaskWorkflowId, TaskWorkflowConfig> = {
  source_video_flow: {
    id: "source_video_flow",
    label: "Source Video Workflow",
    shortLabel: "Source video",
    description: "Frame pick, frame edit, video generation, post-process, reports, and shared asset management for source-driven shots.",
    homeTitle: "VFX",
    homeDescription: "Make targeted changes to the style, lighting or content of a source video.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
  },
  character_animate_workflow: {
    id: "character_animate_workflow",
    label: "Character Animate Workflow",
    shortLabel: "Character animate",
    description: "Shared six-step workflow shell for character animation work, reusing the common asset library, reporting, and generation infrastructure.",
    homeTitle: "Character",
    homeDescription: "Create or use an existing character and animate it, using audio or video to drive the motion.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
  },
  simple_generation_workflow: {
    id: "simple_generation_workflow",
    label: "Previz Workflow",
    shortLabel: "Previz",
    description: "Build previs scenes from text and reference imagery, create storyboard frames, generate shots, and iterate with the shared post-process, assets, and reports tooling.",
    homeTitle: "Previz",
    homeDescription: "Use reference images/sheets to create key frames and then generate rough video for each shot.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
    userFacing: true,
  },
  canvas_workflow: {
    id: "canvas_workflow",
    label: "Canvas Workflow",
    shortLabel: "Canvas",
    description: "Reserved workflow surface for canvas-based task tooling that shares the common auth, task, asset, and reporting contract.",
    homeTitle: "Canvas",
    homeDescription: "Hidden integration workflow reserved for the separate canvas surface.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: false,
    userFacing: false,
  },
};

export function isTaskWorkflowId(value: string | null | undefined): value is TaskWorkflowId {
  return value === "source_video_flow" || value === "character_animate_workflow" || value === "simple_generation_workflow" || value === "canvas_workflow";
}

export function normalizeTaskWorkflowId(value: string | null | undefined): TaskWorkflowId {
  return isTaskWorkflowId(value) ? value : DEFAULT_TASK_WORKFLOW_ID;
}

export function getTaskWorkflowConfig(value: string | null | undefined): TaskWorkflowConfig {
  return TASK_WORKFLOW_CONFIGS[normalizeTaskWorkflowId(value)];
}

export function isUserFacingTaskWorkflowId(value: string | null | undefined): value is UserFacingTaskWorkflowId {
  return value === "source_video_flow" || value === "character_animate_workflow" || value === "simple_generation_workflow";
}

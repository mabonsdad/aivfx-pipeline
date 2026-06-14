import { PRIMARY_WORKFLOW_TABS, type PrimaryWorkflowSection } from "./workflowSections";

export type TaskWorkflowId = "source_video_flow" | "character_animate_workflow" | "simple_generation_workflow";

export type TaskWorkflowConfig = {
  id: TaskWorkflowId;
  label: string;
  shortLabel: string;
  description: string;
  homeTitle: string;
  homeDescription: string;
  primaryTabs: Array<{ id: PrimaryWorkflowSection; label: string }>;
  implemented: boolean;
};

export const DEFAULT_TASK_WORKFLOW_ID: TaskWorkflowId = "source_video_flow";

export const TASK_WORKFLOW_CONFIGS: Record<TaskWorkflowId, TaskWorkflowConfig> = {
  source_video_flow: {
    id: "source_video_flow",
    label: "Source Video Workflow",
    shortLabel: "Source video",
    description: "Frame pick, frame edit, video generation, post-process, reports, and shared asset management for source-driven shots.",
    homeTitle: "VFX",
    homeDescription: "Change style, lighting, or content of a source video.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
  },
  character_animate_workflow: {
    id: "character_animate_workflow",
    label: "Character Animate Workflow",
    shortLabel: "Character animate",
    description: "Shared six-step workflow shell for character animation work, reusing the common asset library, reporting, and generation infrastructure.",
    homeTitle: "Character",
    homeDescription: "Animate character movement or dialogue.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
  },
  simple_generation_workflow: {
    id: "simple_generation_workflow",
    label: "Previz Workflow",
    shortLabel: "Previz",
    description: "Build previs scenes from text and reference imagery, create storyboard frames, generate shots, and iterate with the shared post-process, assets, and reports tooling.",
    homeTitle: "Previz",
    homeDescription: "Use storyboard images to generate video.",
    primaryTabs: PRIMARY_WORKFLOW_TABS,
    implemented: true,
  },
};

export function isTaskWorkflowId(value: string | null | undefined): value is TaskWorkflowId {
  return value === "source_video_flow" || value === "character_animate_workflow" || value === "simple_generation_workflow";
}

export function normalizeTaskWorkflowId(value: string | null | undefined): TaskWorkflowId {
  return isTaskWorkflowId(value) ? value : DEFAULT_TASK_WORKFLOW_ID;
}

export function getTaskWorkflowConfig(value: string | null | undefined): TaskWorkflowConfig {
  return TASK_WORKFLOW_CONFIGS[normalizeTaskWorkflowId(value)];
}

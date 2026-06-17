import type { CharacterAnimateMode } from "./characterAnimate/characterAnimateModeRegistry";
import type { GenerateInputMode } from "./generationModeRegistry";
import type { TaskWorkflowId } from "./taskWorkflows";
import type { SegmentGeneration, TaskDetail } from "../types/api";

const START_END_MODES = new Set(["kling_start_end", "veo_start_end", "ltx23_i2v_start_end"]);
const START_ONLY_MODES = new Set(["kling_start_only", "veo_start_only", "runway_i2v", "sora_i2v", "happy_horse_i2v", "wan_a14b_i2v"]);

export type GenerationOrigin = {
  workflowId: string;
  stepOrigin: string;
  toolOrigin: string;
  creationMode?: string | null;
  appSurface?: string | null;
  [key: string]: unknown;
};

function inferLegacySourceInputMode(
  generation: SegmentGeneration | null | undefined,
  task?: TaskDetail | undefined,
): GenerateInputMode | null {
  const explicitInputMode = String(generation?.generationSettings?.inputMode ?? "").trim();
  if (explicitInputMode === "start_video" || explicitInputMode === "start_end" || explicitInputMode === "start_only" || explicitInputMode === "edit_video") {
    return explicitInputMode;
  }
  const selectedReferenceIds = Array.isArray(generation?.generationSettings?.selectedReferenceIds)
    ? generation?.generationSettings?.selectedReferenceIds
    : [];
  if (selectedReferenceIds.length > 0) return "edit_video";
  const prompt = String(generation?.luma.prompt ?? "").toLowerCase();
  const audioReferenceId = String(generation?.generationSettings?.audioReferenceId ?? "").trim();
  if (audioReferenceId || /@image\d+/.test(prompt) || /@audio\d+/.test(prompt)) return "edit_video";
  const mode = String(generation?.luma.mode ?? "").trim();
  if (START_END_MODES.has(mode)) return "start_end";
  if (START_ONLY_MODES.has(mode)) return "start_only";
  if (mode === "seedance_reference_to_video" && /@video1/.test(prompt)) {
    const hasEditReferences = Array.isArray(task?.editVideoReferences) && task.editVideoReferences.length > 0;
    if (hasEditReferences) return "edit_video";
  }
  if (mode === "happy_horse_video_edit" || mode === "runway_aleph_v2v" || mode === "kling_v3_omni_video_edit" || mode === "seedance_reference_to_video" || mode === "flex_1") {
    return "start_video";
  }
  if (String(generation?.luma.model ?? "").trim() === "wan2.7-videoedit") {
    return "edit_video";
  }
  return null;
}

export function getGenerationOrigin(
  generation: SegmentGeneration | null | undefined,
  task?: TaskDetail | undefined,
): GenerationOrigin | null {
  if (!generation) return null;
  const persisted = generation.origin;
  if (persisted?.workflowId && persisted?.stepOrigin && persisted?.toolOrigin) {
    return {
      workflowId: persisted.workflowId,
      stepOrigin: persisted.stepOrigin,
      toolOrigin: persisted.toolOrigin,
      creationMode: persisted.creationMode ?? null,
      appSurface: typeof persisted.appSurface === "string" ? persisted.appSurface : null,
      ...Object.fromEntries(Object.entries(persisted).filter(([key]) => !["workflowId", "stepOrigin", "toolOrigin", "creationMode", "appSurface"].includes(key))),
    };
  }

  const workflowId =
    String(
      persisted?.workflowId ??
        generation.generationSettings?.workflowId ??
        generation.characterAnimation?.workflowId ??
        task?.workflowId ??
        "source_video_flow",
    ).trim() || "source_video_flow";

  let toolOrigin = "segment_generate";
  let stepOrigin = "generate";
  let creationMode: string | null = null;
  const workflowMarker = String(generation.generationSettings?.workflow ?? "").trim();
  if (workflowMarker === "clip_lengthen") {
    toolOrigin = "clip_lengthen";
    stepOrigin = "post_process";
  } else if (workflowMarker === "timing_reconcile") {
    toolOrigin = "timing_reconcile";
    stepOrigin = "post_process";
  } else if (workflowMarker === "manual_upload_normalize" || generation.manualUpload) {
    toolOrigin = "manual_upload";
  } else if (workflowMarker === "chunked_generation" || generation.chunkRole === "draft_stitched") {
    toolOrigin = "chunked_generate";
  } else if (workflowMarker === "extension_chain_stitch") {
    toolOrigin = "extension_chain_stitch";
  }

  if (workflowId === "character_animate_workflow") {
    toolOrigin = toolOrigin === "segment_generate" ? "character_generate" : toolOrigin;
    creationMode = String(generation.characterAnimation?.mode ?? generation.generationSettings?.characterMode ?? "").trim() || null;
  } else if (workflowId === "simple_generation_workflow") {
    toolOrigin = toolOrigin === "segment_generate" ? "previz_generate" : toolOrigin;
    creationMode = "previz";
  } else {
    creationMode = inferLegacySourceInputMode(generation, task);
  }

  return {
    workflowId,
    stepOrigin,
    toolOrigin,
    creationMode,
    appSurface: "main_app",
  };
}

export function isPostProcessDerivedGeneration(
  generation: SegmentGeneration | null | undefined,
  task?: TaskDetail | undefined,
): boolean {
  const origin = getGenerationOrigin(generation, task);
  if (origin?.stepOrigin === "post_process") return true;
  if (!generation) return false;
  return (
    generation.generationSettings?.workflow === "clip_lengthen" ||
    generation.generationSettings?.workflow === "timing_reconcile" ||
    Boolean(generation.parentGenerationId || generation.extension?.parentGenerationId)
  );
}

export function classifyGenerationAssetRole(
  generation: SegmentGeneration | null | undefined,
  task?: TaskDetail | undefined,
): "generated_video" | "post_process_video" | "orphaned" | null {
  if (!generation || generation.isChunkInternal || generation.status !== "complete" || !generation.downloadUrl) return null;
  const origin = getGenerationOrigin(generation, task);
  if (!origin) return "orphaned";
  if (task?.workflowId && origin.workflowId !== task.workflowId) return "orphaned";
  if (origin.stepOrigin === "generate") return "generated_video";
  if (origin.stepOrigin === "post_process") return "post_process_video";
  return "orphaned";
}

export function matchesGenerateStepGrid(
  generation: SegmentGeneration,
  {
    task,
    workflowId,
    activeInputMode,
    activeCharacterMode,
    selectedSegmentId,
    filterBySelectedSegment,
  }: {
    task?: TaskDetail | undefined;
    workflowId: TaskWorkflowId;
    activeInputMode: GenerateInputMode;
    activeCharacterMode?: CharacterAnimateMode;
    selectedSegmentId?: string | null;
    filterBySelectedSegment: boolean;
  },
): boolean {
  if (generation.isChunkInternal) return false;
  if (filterBySelectedSegment && selectedSegmentId && generation.segmentId !== selectedSegmentId) return false;
  const origin = getGenerationOrigin(generation, task);
  if (!origin) return false;
  if (origin.workflowId !== workflowId) return false;
  if (origin.stepOrigin !== "generate") return false;
  if (workflowId === "character_animate_workflow") {
    return !activeCharacterMode || origin.creationMode === activeCharacterMode;
  }
  if (workflowId === "simple_generation_workflow") {
    return true;
  }
  return origin.creationMode === activeInputMode;
}

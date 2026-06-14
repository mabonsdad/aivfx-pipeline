import { useMemo } from "react";

import type { VideoModelId } from "../lib/generated/videoContracts";
import type { GenerateInputMode } from "../lib/generationModeRegistry";

type GenerationHelp = {
  title: string;
  lines: string[];
};

function generationModelHelp(modelName: VideoModelId, modeValue: string, inputMode: GenerateInputMode): GenerationHelp {
  if (modelName === "kling-o1") {
    return {
      title: "Kling O1 Edit",
      lines: [
        "Uses the working-range video plus the selected edited start frame.",
        "Prompt must include both <<<video_1>>> and <<<image_1>>>.",
        'Example: "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. Keep motion and background the same."',
      ],
    };
  }
  if (modelName === "kling-v3-omni-video") {
    return {
      title: "Kling v3 Omni Video",
      lines: [
        inputMode === "edit_video"
          ? "Uses the working-range video plus up to 3 selected reference images."
          : "Uses the working-range video plus the selected edited start frame.",
        "Prompt must include both <<<video_1>>> and <<<image_1>>>.",
        'Example: "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. Keep motion and background the same."',
      ],
    };
  }
  if (modelName === "seedance-2.0-reference-to-video") {
    return {
      title: "Seedance 2.0 Reference to Video",
      lines: [
        inputMode === "edit_video"
          ? "Uses the working-range video as @Video1, with optional reference images @Image1..@Image3 and optional audio @Audio1."
          : "Uses the working-range video as @Video1 and the selected edited start frame as @Image1.",
        inputMode === "edit_video" ? "Prompt must include @Video1. @Image1 and @Audio1 are optional." : "Prompt must include both @Video1 and @Image1.",
        "The app conforms the input to Seedance reference-video bounds, then scales the result back to the working range.",
        inputMode === "edit_video"
          ? 'Example: "Keep the action from @Video1, shift the look toward @Image1, and sync pacing to @Audio1 where useful."'
          : 'Example: "Transform the horse in @Video1 into the unicorn in @Image1. Keep motion and background the same."',
      ],
    };
  }
  if (modelName === "wan2.7-videoedit") {
    return {
      title: "Wan 2.7 VideoEdit",
      lines: [
        inputMode === "edit_video"
          ? "Uses the working-range video plus one selected reference image."
          : "Uses the working-range video plus the selected edited start frame.",
        "Prompt should focus on the visual change, not restate motion or camera behavior.",
        "Resolution can be 720p or 1080p.",
      ],
    };
  }
  if (modelName === "happy-horse-video-edit") {
    return {
      title: "Happy Horse 1.0 Video Edit",
      lines: [
        inputMode === "edit_video"
          ? "Uses the working-range video plus up to 3 selected reference images as @Image1..@Image3."
          : "Uses the working-range video plus the selected edited start frame as @Image1.",
        "Prompt must include @Image1.",
        'Example: "change the horse into the white unicorn in @Image1 and keep the background and motion exactly the same".',
      ],
    };
  }
  if (modelName === "happy-horse-image-to-video") {
    return {
      title: "Happy Horse 1.0 Image to Video",
      lines: [
        "Uses only the selected start frame and prompt. No source working-range video is sent.",
        "Resolution can be set to 720p or 1080p.",
        "Happy Horse supports clips from 3 to 15 seconds in this flow.",
      ],
    };
  }
  if (modelName === "wan2.7-i2v") {
    return {
      title: inputMode === "start_end" ? "Wan 2.7 Image to Video (Start/End)" : "Wan 2.7 Image to Video",
      lines: [
        inputMode === "start_end"
          ? "Uses the selected start and end frames only. No source working-range video is sent."
          : "Uses the selected start frame only. No source working-range video is sent.",
        "Supports an optional negative prompt plus 720p or 1080p output. This app caps the path at 10 seconds.",
        inputMode === "start_end"
          ? "Best prompt style: describe how motion develops from the start frame into the supplied end frame while keeping camera motion coherent."
          : "Best prompt style: describe the subject motion, camera movement and scene continuity clearly from the first frame.",
      ],
    };
  }
  if (modelName === "ltx-2.3-pro") {
    return {
      title: "LTX 2.3 Pro (Start/End)",
      lines: [
        "Uses the selected start and end frames only. No source working-range video is sent for this mode.",
        "Prompting works best when you describe visible motion and one clear camera move between the start and end images.",
        "Replicate LTX retake is video-only (no image input), so this app currently does not use retake for start frame + video flows.",
      ],
    };
  }
  if (modelName === "kling-2.6") {
    return {
      title: inputMode === "start_only" ? "Kling 2.6 (Start Frame)" : "Kling 2.6 Start/End",
      lines: [
        inputMode === "start_only"
          ? "Uses only the selected start frame in this tab. It does not use source working-range video."
          : "Uses start frame + end frame + working-range duration. It does not use the source working-range video for motion.",
        inputMode === "start_only"
          ? "Best prompt style: describe motion evolution from the start frame while preserving identity."
          : "Best prompt style: describe camera motion and action between start and end frames.",
        "Keep prompts temporal and concrete, for example 'slow push in, subtle cloth movement, keep background stable'.",
      ],
    };
  }
  if (modelName === "runway-gen4.5") {
    return {
      title: "Runway Gen-4.5",
      lines: [
        "Uses only the selected start frame as the initial frame. It does not use source working-range motion.",
        "Best prompt style: describe the motion and evolution from frame one while preserving composition.",
        "Avoid conflicting scene changes in one prompt; short and specific prompts usually hold frame identity better.",
      ],
    };
  }
  if (modelName === "sora-2-image-to-video") {
    return {
      title: "Sora 2 Image to Video",
      lines: [
        "Uses only the selected start frame. No source working-range video is sent.",
        "Resolution can be auto, 720p or 1080p. This app exposes up to 10 seconds in the UI and trims longer provider outputs back to the requested duration when needed.",
        "Best prompt style: describe the motion, camera movement and continuity from the first frame clearly and concretely.",
      ],
    };
  }
  if (modelName === "runway-gen4-aleph") {
    return {
      title: "Runway Gen-4 Aleph",
      lines: [
        inputMode === "edit_video"
          ? "Uses the working-range video plus one selected reference image."
          : "Uses the working-range video plus the selected edited start frame as an image reference.",
        "Prompts work best when they start with a clear verb and reference the first frame.",
        'Example: "edit the video to start on the input image as the first frame. add motion so that the car floats weightlessly, as if in zero gravity, throughout the video".',
        "Runway may center-crop to fit supported output ratios.",
      ],
    };
  }
  if (modelName === "veo-3.1" || modelName === "veo-3.1-fast") {
    return {
      title:
        modelName === "veo-3.1-fast"
          ? inputMode === "start_only"
            ? "Runware Veo 3.1 Fast (Start Frame, No Audio)"
            : "Runware Veo 3.1 Fast (No Audio)"
          : inputMode === "start_only"
            ? "Runware Veo 3.1 (Start Frame, No Audio)"
            : "Runware Veo 3.1 (No Audio)",
      lines: [
        inputMode === "start_only"
          ? "Uses only the selected start frame in this tab. No source working-range video is sent."
          : "Uses selected start and end frames as keyframes. No source working-range video is sent.",
        "Duration is fixed at 8 seconds for Veo 3.1 API runs; merged output may be time-adjusted at insert.",
        inputMode === "start_only"
          ? "Prompting works best with clear motion direction and continuity constraints from the start frame."
          : "Prompting works best with clear motion direction and continuity constraints between start and end frames.",
      ],
    };
  }
  if (modelName === "wan2.2-a14b") {
    return {
      title: "Runware Wan2.2 A14B",
      lines: [
        "Best for high-quality image-to-video from the selected start frame.",
        "Uses the start frame as the anchor image; this flow does not consume the source working-range video.",
        "Prompt tips: describe camera motion and subject movement clearly, keep style constraints concise and specific.",
      ],
    };
  }
  return {
    title: modelName === "ray-flash-2" ? "Luma Ray Flash 2" : "Luma Ray 2",
    lines: [
      "Uses the working-range video plus the selected edited start frame.",
      "Luma modes: adhere = closest to source, flex = moderate change, reimagine = strongest change.",
      `Current mode: ${modeValue}. Use lower modes for continuity and higher modes for stronger visual change.`,
    ],
  };
}

type UseGenerationPromptGuidanceArgs = {
  lumaModel: VideoModelId;
  advancedMode: string;
  generationInputMode: GenerateInputMode;
  hasEditedStartFrame: boolean;
  hasEditedEndFrame: boolean;
  requiresEndFrameForRoute: boolean;
  lumaPrompt: string;
};

export function useGenerationPromptGuidance({
  lumaModel,
  advancedMode,
  generationInputMode,
  hasEditedStartFrame,
  hasEditedEndFrame,
  requiresEndFrameForRoute,
  lumaPrompt,
}: UseGenerationPromptGuidanceArgs) {
  const generationHelp = useMemo(
    () => generationModelHelp(lumaModel, advancedMode, generationInputMode),
    [advancedMode, generationInputMode, lumaModel],
  );

  const missingRouteInputsMessage = useMemo(() => {
    if (!hasEditedStartFrame && requiresEndFrameForRoute && !hasEditedEndFrame) {
      return "No edited start or end frame selected. Generation will use the original source start and end frames.";
    }
    if (!hasEditedStartFrame) {
      return "No edited start frame selected. Generation will use the original source start frame.";
    }
    if (requiresEndFrameForRoute && !hasEditedEndFrame) {
      return "No edited end frame selected. Generation will use the original source end frame.";
    }
    return null;
  }, [hasEditedEndFrame, hasEditedStartFrame, requiresEndFrameForRoute]);

  const generationInputNote = useMemo(() => {
    if (lumaModel === "kling-o1") {
      return "Uses the selected working-range video as <<<video_1>>> and the selected edited start frame as <<<image_1>>>. Prompt must reference both.";
    }
    if (lumaModel === "kling-v3-omni-video") {
      return generationInputMode === "edit_video"
        ? "Uses the selected working-range video as <<<video_1>>> and selected references as <<<image_1>>>..<<<image_3>>>. Prompt must reference <<<video_1>>> and at least <<<image_1>>>."
        : "Uses the selected working-range video as <<<video_1>>> and the selected edited start frame as <<<image_1>>> for base video editing. Prompt must reference both.";
    }
    if (lumaModel === "seedance-2.0-reference-to-video") {
      return generationInputMode === "edit_video"
        ? "Uses the selected working-range video as @Video1, optional selected references as @Image1..@Image3, and an optional uploaded audio reference as @Audio1. Prompt must reference @Video1."
        : "Uses the selected working-range video as @Video1 and the selected edited start frame as @Image1. Prompt must reference both. The working range is conformed to Seedance's smaller reference-video bounds, then the result is upscaled back to the working-range size.";
    }
    if (lumaModel === "wan2.7-videoedit") {
      return generationInputMode === "edit_video"
        ? "Uses the selected working-range video plus one selected reference image. Prompt should describe only the intended edit."
        : "Uses the selected working-range video plus the selected edited start frame as reference_image. Prompt should describe only the intended edit.";
    }
    if (lumaModel === "happy-horse-video-edit") {
      return generationInputMode === "edit_video"
        ? "Uses the selected working-range video plus up to 3 selected references as @Image1..@Image3. Prompt must reference @Image1."
        : "Uses the selected working-range video plus the selected edited start frame as @Image1. Prompt must reference @Image1.";
    }
    if (lumaModel === "happy-horse-image-to-video") {
      return "Uses only the selected edited start frame. No source working-range video is sent.";
    }
    if (lumaModel === "wan2.7-i2v") {
      return generationInputMode === "start_end"
        ? "Uses the selected edited start and end frames only. No source working-range video is sent."
        : "Uses only the selected edited start frame. No source working-range video is sent.";
    }
    if (lumaModel === "ltx-2.3-pro") {
      return "Uses the selected edited start and end frames only with Replicate LTX 2.3 Pro image_to_video. LTX retake is not image-referenced, so it is not used in this flow.";
    }
    if (lumaModel === "runway-gen4-aleph") {
      return generationInputMode === "edit_video"
        ? "Uses the selected working-range video plus one selected reference image. Prompt should describe the intended transformation while preserving motion and camera continuity."
        : "Uses the selected working-range video plus the selected edited start frame as an image reference. Prompt should describe the intended transformation while preserving motion and camera continuity. Runway may center-crop to the chosen output ratio.";
    }
    if (lumaModel === "sora-2-image-to-video") {
      return "Uses only the selected edited start frame. No source working-range video is sent.";
    }
    if (lumaModel === "wan2.2-a14b" || lumaModel === "runway-gen4.5") {
      return "Start frame variant is taken automatically from your Edit frames selection.";
    }
    if (lumaModel === "wan2.2-animate") {
      return "Wan2.2 Animate uses start frame + source working-range video. Text prompt is disabled in this flow unless LoRA inputs are used.";
    }
    if (generationInputMode === "start_only" && (lumaModel === "kling-2.6" || lumaModel === "veo-3.1" || lumaModel === "veo-3.1-fast")) {
      return "Start frame only is enforced in this tab; the end frame is not sent.";
    }
    return "Start and end frame variants are taken automatically from your Edit frames selections.";
  }, [generationInputMode, lumaModel]);

  const generationPromptPlaceholder = useMemo(() => {
    if (lumaModel === "kling-o1" || lumaModel === "kling-v3-omni-video") {
      return "Transform the horse in <<<video_1>>> into the unicorn in <<<image_1>>>. Keep motion, camera movement and background the same.";
    }
    if (lumaModel === "seedance-2.0-reference-to-video") {
      return generationInputMode === "edit_video"
        ? "Keep the motion and camera from @Video1, optionally use @Image1 for look/style and @Audio1 for timing or mood."
        : "Transform the horse in @Video1 into the unicorn in @Image1. Keep the motion, camera movement and background the same.";
    }
    if (lumaModel === "wan2.7-videoedit") {
      return "Change the horse into the white unicorn, keep the background and motion the same.";
    }
    if (lumaModel === "happy-horse-video-edit") {
      return "change the horse into the white unicorn in @Image1 and keep the background and motion exactly the same";
    }
    if (lumaModel === "happy-horse-image-to-video") {
      return "Animate from this first frame with clear subject motion, stable background continuity and coherent camera movement.";
    }
    if (lumaModel === "wan2.7-i2v") {
      return generationInputMode === "start_end"
        ? "Animate from the first frame to the final frame with coherent camera motion and stable subject detail."
        : "Animate from this first frame with clear subject motion, camera motion and scene continuity.";
    }
    if (lumaModel === "ltx-2.3-pro") {
      return "Describe one clear camera move and subject motion that transitions naturally from the start frame into the end frame.";
    }
    if (lumaModel === "runway-gen4-aleph") {
      return "Transform the horse into the white unicorn from the reference image while preserving camera movement, timing and background continuity.";
    }
    if (lumaModel === "sora-2-image-to-video") {
      return "Animate from this first frame with clear subject motion, camera motion and scene continuity.";
    }
    return "Optional generation prompt";
  }, [generationInputMode, lumaModel]);

  const generationPromptError = useMemo(() => {
    const promptValue = lumaPrompt.trim();
    if (lumaModel === "wan2.2-animate") return null;
    if (lumaModel === "kling-o1") {
      if (!promptValue) return "Kling O1 Edit requires a prompt that references both <<<video_1>>> and <<<image_1>>>.";
      const missing: string[] = [];
      if (!promptValue.includes("<<<video_1>>>")) missing.push("<<<video_1>>>");
      if (!promptValue.includes("<<<image_1>>>")) missing.push("<<<image_1>>>");
      if (missing.length) return `Kling O1 Edit prompt must include ${missing.join(" and ")}.`;
      return null;
    }
    if (lumaModel === "kling-v3-omni-video") {
      if (!promptValue) return "Kling v3 Omni Video requires a prompt that references both <<<video_1>>> and <<<image_1>>>.";
      const missing: string[] = [];
      if (!promptValue.includes("<<<video_1>>>")) missing.push("<<<video_1>>>");
      if (!promptValue.includes("<<<image_1>>>")) missing.push("<<<image_1>>>");
      if (missing.length) return `Kling v3 Omni Video prompt must include ${missing.join(" and ")}.`;
      return null;
    }
    if (lumaModel === "seedance-2.0-reference-to-video") {
      if (!promptValue) {
        return generationInputMode === "edit_video"
          ? "Seedance 2.0 Reference to Video requires a prompt that references @Video1."
          : "Seedance 2.0 Reference to Video requires a prompt that references both @Video1 and @Image1.";
      }
      const missing: string[] = [];
      if (!promptValue.includes("@Video1")) missing.push("@Video1");
      if (generationInputMode !== "edit_video" && !promptValue.includes("@Image1")) missing.push("@Image1");
      if (missing.length) return `Seedance 2.0 Reference to Video prompt must include ${missing.join(" and ")}.`;
      return null;
    }
    if (lumaModel === "wan2.7-videoedit" && !promptValue) {
      return "Wan 2.7 VideoEdit requires a prompt describing the change you want to make.";
    }
    if (lumaModel === "happy-horse-video-edit") {
      if (!promptValue) return "Happy Horse 1.0 Video Edit requires a prompt that references @Image1.";
      if (!promptValue.includes("@Image1")) return "Happy Horse 1.0 Video Edit prompt must include @Image1.";
      return null;
    }
    if (lumaModel === "happy-horse-image-to-video" && !promptValue) {
      return "Happy Horse 1.0 Image to Video requires a prompt describing the intended motion from the first frame.";
    }
    if (lumaModel === "wan2.7-i2v" && !promptValue) {
      return generationInputMode === "start_end"
        ? "Wan 2.7 Image to Video requires a prompt describing the motion and the transition between the start and end frames."
        : "Wan 2.7 Image to Video requires a prompt describing the intended motion from the first frame.";
    }
    if (lumaModel === "ltx-2.3-pro" && !promptValue) {
      return "LTX 2.3 Pro requires a prompt describing motion and camera transition between the start and end frames.";
    }
    if (lumaModel === "runway-gen4-aleph" && !promptValue) {
      return "Runway Gen-4 Aleph requires a prompt describing the intended transformation.";
    }
    if (lumaModel === "sora-2-image-to-video" && !promptValue) {
      return "Sora 2 Image to Video requires a prompt describing the intended motion from the first frame.";
    }
    return null;
  }, [generationInputMode, lumaModel, lumaPrompt]);

  return {
    generationHelp,
    missingRouteInputsMessage,
    generationInputNote,
    generationPromptPlaceholder,
    generationPromptError,
  };
}

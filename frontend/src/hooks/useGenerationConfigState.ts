import { useEffect, useMemo, useState } from "react";

import type {
  HappyHorseResolutionId,
  ReplicateKlingModeId,
  ReplicateKlingV3ModeId,
  Sora2ResolutionId,
  VideoModelId,
  Wan27ResolutionId,
} from "../lib/generated/videoContracts";
import type { GenerateInputMode } from "../lib/generationModeRegistry";

export type GenerationModelOption = {
  value: VideoModelId;
  label: string;
};

export const GENERATION_MODELS_BY_INPUT: Record<GenerateInputMode, GenerationModelOption[]> = {
  start_video: [
    { value: "ray-flash-2", label: "Luma Ray Flash 2" },
    { value: "ray-2", label: "Luma Ray 2" },
    { value: "happy-horse-video-edit", label: "Happy Horse 1.0 Video Edit" },
    { value: "runway-gen4-aleph", label: "Runway Gen-4 Aleph" },
    { value: "kling-o1", label: "Kling O1 Edit" },
    { value: "kling-v3-omni-video", label: "Kling v3 Omni Video" },
    { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video" },
    { value: "wan2.7-videoedit", label: "Wan 2.7 VideoEdit" },
  ],
  start_end: [
    { value: "kling-2.6", label: "Kling 2.6" },
    { value: "ltx-2.3-pro", label: "LTX 2.3 Pro" },
    { value: "wan2.7-i2v", label: "Wan 2.7 Image to Video" },
    { value: "veo-3.1", label: "Veo 3.1" },
    { value: "veo-3.1-fast", label: "Veo 3.1 Fast" },
  ],
  start_only: [
    { value: "wan2.2-a14b", label: "Wan 2.2 A14B" },
    { value: "happy-horse-image-to-video", label: "Happy Horse 1.0 Image to Video" },
    { value: "wan2.7-i2v", label: "Wan 2.7 Image to Video" },
    { value: "runway-gen4.5", label: "Runway Gen-4.5" },
    { value: "sora-2-image-to-video", label: "Sora 2 Image to Video" },
    { value: "veo-3.1", label: "Veo 3.1" },
    { value: "veo-3.1-fast", label: "Veo 3.1 Fast" },
    { value: "kling-2.6", label: "Kling 2.6" },
  ],
  edit_video: [
    { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video" },
    { value: "happy-horse-video-edit", label: "Happy Horse 1.0 Video Edit" },
    { value: "kling-v3-omni-video", label: "Kling v3 Omni Video" },
    { value: "wan2.7-videoedit", label: "Wan 2.7 VideoEdit" },
    { value: "runway-gen4-aleph", label: "Runway Gen-4 Aleph" },
  ],
};

export function useGenerationConfigState() {
  const [generationInputMode, setGenerationInputMode] = useState<GenerateInputMode>("start_video");
  const [generationModelByInput, setGenerationModelByInput] = useState<Record<GenerateInputMode, VideoModelId>>({
    start_video: "ray-flash-2",
    start_end: "kling-2.6",
    start_only: "wan2.2-a14b",
    edit_video: "seedance-2.0-reference-to-video",
  });
  const [lumaModel, setLumaModel] = useState<VideoModelId>("ray-flash-2");
  const [advancedMode, setAdvancedMode] = useState("flex_1");
  const [lumaPrompt, setLumaPrompt] = useState("");
  const [lumaContinuationPrompt, setLumaContinuationPrompt] = useState("");
  const [preserveFrames, setPreserveFrames] = useState(true);
  const [replicateKlingMode, setReplicateKlingMode] = useState<ReplicateKlingModeId>("pro");
  const [replicateKlingV3Mode, setReplicateKlingV3Mode] = useState<ReplicateKlingV3ModeId>("pro");
  const [wan27Resolution, setWan27Resolution] = useState<Wan27ResolutionId>("720p");
  const [happyHorseResolution, setHappyHorseResolution] = useState<HappyHorseResolutionId>("1080p");
  const [wan27NegativePrompt, setWan27NegativePrompt] = useState("");
  const [sora2Resolution, setSora2Resolution] = useState<Sora2ResolutionId>("auto");

  useEffect(() => {
    const modelForInput = generationModelByInput[generationInputMode];
    if (modelForInput !== lumaModel) {
      setLumaModel(modelForInput);
    }
  }, [generationInputMode, generationModelByInput, lumaModel]);

  const generationModelOptions = useMemo(() => GENERATION_MODELS_BY_INPUT[generationInputMode], [generationInputMode]);

  useEffect(() => {
    if (generationModelOptions.some((option) => option.value === lumaModel)) {
      return;
    }
    const fallback = generationModelOptions[0]?.value;
    if (!fallback) return;
    setGenerationModelByInput((previous) => ({ ...previous, [generationInputMode]: fallback }));
    setLumaModel(fallback);
  }, [generationInputMode, generationModelOptions, lumaModel]);

  return {
    generationInputMode,
    setGenerationInputMode,
    generationModelByInput,
    setGenerationModelByInput,
    lumaModel,
    setLumaModel,
    advancedMode,
    setAdvancedMode,
    lumaPrompt,
    setLumaPrompt,
    lumaContinuationPrompt,
    setLumaContinuationPrompt,
    preserveFrames,
    setPreserveFrames,
    replicateKlingMode,
    setReplicateKlingMode,
    replicateKlingV3Mode,
    setReplicateKlingV3Mode,
    wan27Resolution,
    setWan27Resolution,
    happyHorseResolution,
    setHappyHorseResolution,
    wan27NegativePrompt,
    setWan27NegativePrompt,
    sora2Resolution,
    setSora2Resolution,
    generationModelOptions,
  };
}

import { useCallback, useEffect, useMemo, useState } from "react";

import { CHARACTER_ANIMATE_MODEL_OPTIONS, type CharacterAnimateMode } from "../lib/characterAnimate/characterAnimateModeRegistry";

const CHARACTER_ANIMATE_MODE_STORAGE_KEY = "aivfx:character-animate-mode";

function readStoredCharacterAnimateMode(): CharacterAnimateMode | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(CHARACTER_ANIMATE_MODE_STORAGE_KEY);
  if (raw === "pose_video" || raw === "audio_driven") return raw;
  return null;
}

export function useCharacterAnimateConfigState(forcedMode: CharacterAnimateMode | null = null) {
  const [storedCharacterAnimateMode, setStoredCharacterAnimateMode] = useState<CharacterAnimateMode>(
    () => readStoredCharacterAnimateMode() ?? "pose_video",
  );
  const [characterAnimateModelByMode, setCharacterAnimateModelByMode] = useState<Record<CharacterAnimateMode, string>>({
    pose_video: "runway_act_two",
    audio_driven: "omnihuman_v1_5",
  });

  const characterAnimateMode = forcedMode ?? storedCharacterAnimateMode;

  const setCharacterAnimateMode = useCallback((nextMode: CharacterAnimateMode) => {
    if (forcedMode) return;
    setStoredCharacterAnimateMode(nextMode);
  }, [forcedMode]);

  useEffect(() => {
    if (forcedMode) return;
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(CHARACTER_ANIMATE_MODE_STORAGE_KEY, characterAnimateMode);
  }, [characterAnimateMode, forcedMode]);

  const characterAnimateModelOptions = useMemo(
    () => CHARACTER_ANIMATE_MODEL_OPTIONS[characterAnimateMode],
    [characterAnimateMode],
  );
  const selectedCharacterAnimateModel = characterAnimateModelByMode[characterAnimateMode];

  useEffect(() => {
    if (characterAnimateModelOptions.some((option) => option.value === selectedCharacterAnimateModel)) return;
    const fallback = characterAnimateModelOptions[0]?.value;
    if (!fallback) return;
    setCharacterAnimateModelByMode((previous) => ({ ...previous, [characterAnimateMode]: fallback }));
  }, [characterAnimateMode, characterAnimateModelOptions, selectedCharacterAnimateModel]);

  return {
    characterAnimateMode,
    setCharacterAnimateMode,
    characterAnimateModelByMode,
    setCharacterAnimateModelByMode,
    characterAnimateModelOptions,
    selectedCharacterAnimateModel,
  };
}

import { create } from "zustand";

import type { VideoCleanupSettings } from "../types/api";

export type CleanupPreviewMode = "generated" | "overlay" | "checker" | "cleaned";

type CleanupTrackState = {
  selectedFrameIndexLocal: number;
  previewMode: CleanupPreviewMode;
  isSavingCorrection: boolean;
  isApplying: boolean;
  pendingSettings: Partial<VideoCleanupSettings>;
  setSelectedFrameIndexLocal: (value: number) => void;
  setPreviewMode: (mode: CleanupPreviewMode) => void;
  setIsSavingCorrection: (value: boolean) => void;
  setIsApplying: (value: boolean) => void;
  setPendingSettings: (update: Partial<VideoCleanupSettings> | ((previous: Partial<VideoCleanupSettings>) => Partial<VideoCleanupSettings>)) => void;
  reset: () => void;
};

const DEFAULT_PENDING_SETTINGS: Partial<VideoCleanupSettings> = {};

export const useCleanupTrackStore = create<CleanupTrackState>((set) => ({
  selectedFrameIndexLocal: 0,
  previewMode: "cleaned",
  isSavingCorrection: false,
  isApplying: false,
  pendingSettings: DEFAULT_PENDING_SETTINGS,
  setSelectedFrameIndexLocal: (selectedFrameIndexLocal) => set({ selectedFrameIndexLocal }),
  setPreviewMode: (previewMode) => set({ previewMode }),
  setIsSavingCorrection: (isSavingCorrection) => set({ isSavingCorrection }),
  setIsApplying: (isApplying) => set({ isApplying }),
  setPendingSettings: (update) =>
    set((state) => ({
      pendingSettings:
        typeof update === "function"
          ? update(state.pendingSettings)
          : update,
    })),
  reset: () =>
    set({
      selectedFrameIndexLocal: 0,
      previewMode: "cleaned",
      isSavingCorrection: false,
      isApplying: false,
      pendingSettings: DEFAULT_PENDING_SETTINGS,
    }),
}));

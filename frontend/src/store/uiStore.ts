import { create } from "zustand";

type UiState = {
  selectedTaskId: string | null;
  currentFrameIndex: number;
  selectedFrameId: string | null;
  selectedSegmentId: string | null;
  setSelectedTaskId: (taskId: string | null) => void;
  setCurrentFrameIndex: (value: number) => void;
  setSelectedFrameId: (frameId: string | null) => void;
  setSelectedSegmentId: (segmentId: string | null) => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedTaskId: null,
  currentFrameIndex: 0,
  selectedFrameId: null,
  selectedSegmentId: null,
  setSelectedTaskId: (selectedTaskId) =>
    set({ selectedTaskId, currentFrameIndex: 0, selectedFrameId: null, selectedSegmentId: null }),
  setCurrentFrameIndex: (currentFrameIndex) => set({ currentFrameIndex }),
  setSelectedFrameId: (selectedFrameId) => set({ selectedFrameId }),
  setSelectedSegmentId: (selectedSegmentId) => set({ selectedSegmentId }),
}));

export type ReferencePickerSourceGroup = "upload" | "generated";

export type ReferencePickerSourceType =
  | "task_reference"
  | "frame_capture"
  | "frame_variant";

export type ReferencePickerGeneratedScope = "current_mode_task" | "task" | "project" | "all_tasks";
export type ReferencePickerAssetKind = "uploaded" | "generated_image" | "captured_frame";
export type ReferencePickerInitialTab = "upload" | "generated" | "capture_video_frame";

export type ReferencePickerItem = {
  id: string;
  taskId: string;
  imageUrl: string;
  createdAt: string;
  title: string;
  subtitle: string;
  sourceGroup: ReferencePickerSourceGroup;
  sourceType: ReferencePickerSourceType;
  sourceKey: string;
  referenceId?: string;
  referenceType?: "uploaded" | "generated";
  isCurrentTaskAsset: boolean;
  isProjectAsset: boolean;
  matchesCurrentContext: boolean;
  assetKind: ReferencePickerAssetKind;
};

export type WorkingReferencePreviewItem = {
  referenceId: string;
  imageUrl?: string;
  token: string;
  title: string;
  subtitle?: string;
};

export type ReferencePickerVideoSourceKind = "uploaded" | "generated";

export type ReferencePickerVideoItem = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  previewUrl: string;
  thumbnailUrl?: string;
  createdAt: string;
  sourceKind: ReferencePickerVideoSourceKind;
  isCurrentTaskAsset: boolean;
  isProjectAsset: boolean;
  matchesCurrentContext: boolean;
  canCaptureFrame: boolean;
  frameCount?: number | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
};

export type SourceMediaPickerScope = "task" | "project" | "all_tasks";

export type SourceMediaPickerItem = {
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  mediaKind: "video" | "audio";
  previewUrl: string;
  thumbnailUrl?: string;
  waveformUrl?: string;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  isCurrentTaskAsset: boolean;
  isProjectAsset: boolean;
  sourceLabel: "uploaded";
};

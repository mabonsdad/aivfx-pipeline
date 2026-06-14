import type { CustomReportOutputRef } from "./api";

export type LibraryAssetDeletePayload =
  | { assetType: "upload" }
  | { assetType: "frame_capture"; frameId: string }
  | { assetType: "frame_variant"; frameId: string; variantId: string }
  | { assetType: "segment_generation"; genId: string }
  | { assetType: "export"; exportId: string }
  | { assetType: "edit_video_reference"; referenceId: string }
  | { assetType: "generation_audio_reference" };

export type LibraryAsset = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  mediaType: "image" | "video" | "audio";
  assetRole?:
    | "source_audio"
    | "audio_reference"
    | "character"
    | "reference_image"
    | "edited_frame"
    | "generated_video"
    | "post_process_video"
    | "merged_video"
    | "orphaned";
  customReportRef?: CustomReportOutputRef;
  deletePayload?: LibraryAssetDeletePayload;
};

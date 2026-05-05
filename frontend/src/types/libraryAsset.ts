import type { CustomReportOutputRef } from "./api";

export type LibraryAssetDeletePayload =
  | { assetType: "upload" }
  | { assetType: "frame_capture"; frameId: string }
  | { assetType: "frame_variant"; frameId: string; variantId: string }
  | { assetType: "segment_generation"; genId: string }
  | { assetType: "export"; exportId: string };

export type LibraryAsset = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  mediaType: "image" | "video";
  customReportRef?: CustomReportOutputRef;
  deletePayload: LibraryAssetDeletePayload;
};

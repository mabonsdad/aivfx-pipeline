export type TaskSummary = {
  taskId: string;
  name: string;
  status: "created" | "ingesting" | "ready" | "error";
  createdAt: string;
  updatedAt: string;
  video?: Record<string, unknown>;
};

export type FrameVariant = {
  variantId: string;
  type: "full" | "patch";
  model: "nano_banana" | "nano_banana_pro" | "runware_flux_fill" | "runware_ace_pp";
  promptHash: string;
  createdAt: string;
  outputKey: string;
  imageUrl?: string;
  patchMeta?: Record<string, unknown>;
};

export type FrameRecord = {
  frameId: string;
  frameIndex: number;
  timecode: string;
  captureKey: string;
  createdAt?: string;
  imageUrl?: string;
  variants: FrameVariant[];
  selectedVariantId?: string | null;
};

export type SegmentRecord = {
  segmentId: string;
  startFrame: number;
  endFrameExclusive: number;
  durationFrames: number;
  durationSec: number;
  startTimecode: string;
  endTimecode: string;
  startFrameId: string;
  endFrameId: string;
  selectedGenerationId?: string | null;
};

export type SegmentGeneration = {
  genId: string;
  segmentId: string;
  luma: {
    provider?: "luma" | "runway" | "kling";
    model: "ray-2" | "ray-flash-2" | "runway-aleph" | "kling-2.6";
    mode: string;
    prompt?: string;
    lumaGenerationId?: string | null;
  };
  status: "queued" | "running" | "complete" | "failed";
  outputKey?: string | null;
  createdAt: string;
  downloadUrl?: string;
};

export type ExportRecord = {
  exportId: string;
  outputKey: string;
  createdAt: string;
  downloadUrl?: string;
};

export type TaskDetail = {
  taskId: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: "created" | "ingesting" | "ready" | "error";
  video: {
    original?: {
      s3Key: string;
      filename: string;
      sizeBytes: number;
      sha256?: string | null;
      downloadUrl?: string;
    };
    editSource?: {
      s3Key: string;
      fps: { num: number; den: number };
      frameCount: number;
      durationSec: number;
      width: number;
      height: number;
      isVfrInput: boolean;
      downloadUrl?: string;
    };
    previewSource?: {
      s3Key: string;
      frameCount: number;
      durationSec: number;
      width: number;
      height: number;
      downloadUrl?: string;
    };
  };
  segments: SegmentRecord[];
  frames: Record<string, FrameRecord>;
  segmentGenerations: Record<string, SegmentGeneration>;
  exports: ExportRecord[];
};

export type JobStatus = {
  jobId: string;
  userId: string;
  taskId: string;
  type: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  createdAt?: string;
  updatedAt?: string;
  logs?: Array<{ at: string; message: string }>;
  error?: string;
  resultRefs?: Record<string, unknown>;
};

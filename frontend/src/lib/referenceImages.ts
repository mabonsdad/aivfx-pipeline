import type { VideoModelId } from "./generated/videoContracts";

const DEFAULT_REFERENCE_LIMIT = 3;
const MAX_REFERENCE_UPLOAD_SHORT_EDGE_PX = 1080;

export function editVideoReferenceLimitForModel(model: VideoModelId): number {
  if (model === "seedance-2.0-reference-to-video" || model === "happy-horse-video-edit" || model === "kling-v3-omni-video") {
    return 3;
  }
  if (model === "wan2.7-videoedit" || model === "runway-gen4-aleph") {
    return 1;
  }
  return DEFAULT_REFERENCE_LIMIT;
}

export function editVideoReferenceTokenForIndex(model: VideoModelId, index: number): string {
  if (model === "seedance-2.0-reference-to-video" || model === "happy-horse-video-edit") return `@Image${index + 1}`;
  if (model === "kling-v3-omni-video") return `<<<image_${index + 1}>>>`;
  return `Reference ${index + 1}`;
}

function renameWithPngExtension(filename: string): string {
  const basename = filename.replace(/\.[^/.]+$/, "") || "reference";
  return `${basename}.png`;
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to read image"));
    image.src = url;
  });
}

async function canvasToPngFile(canvas: HTMLCanvasElement, filename: string): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), "image/png");
  });
  if (!blob) throw new Error("Failed to convert image for upload");
  return new File([blob], renameWithPngExtension(filename), { type: "image/png" });
}

export async function prepareReferenceImageUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Reference files must be images");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(objectUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      throw new Error("Reference image is empty");
    }
    const shortestEdge = Math.min(width, height);
    const alreadyCompatible = (file.type === "image/png" || file.type === "image/jpeg") && shortestEdge <= MAX_REFERENCE_UPLOAD_SHORT_EDGE_PX;
    if (alreadyCompatible) {
      return file;
    }

    const scale = shortestEdge > MAX_REFERENCE_UPLOAD_SHORT_EDGE_PX ? MAX_REFERENCE_UPLOAD_SHORT_EDGE_PX / shortestEdge : 1;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to prepare upload canvas");
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    return canvasToPngFile(canvas, file.name);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

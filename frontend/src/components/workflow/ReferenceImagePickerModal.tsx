import { useEffect, useMemo, useRef, useState, type ChangeEvent, type SyntheticEvent } from "react";
import ReactCrop, { centerCrop, makeAspectCrop, type Crop, type PercentCrop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

import { PendingButtonLabel } from "../layout/UiFeedback";
import type {
  ReferencePickerAssetKind,
  ReferencePickerGeneratedScope,
  ReferencePickerInitialTab,
  ReferencePickerItem,
  ReferencePickerVideoItem,
} from "../../types/referencePicker";

type ReferenceImagePickerModalProps = {
  isOpen: boolean;
  maxSelected: number;
  selectedIds: string[];
  items: ReferencePickerItem[];
  videoItems?: ReferencePickerVideoItem[];
  initialTab?: ReferencePickerInitialTab;
  generatedScopeDefault?: ReferencePickerGeneratedScope;
  isSaving?: boolean;
  onClose: () => void;
  onConfirm: (selectedIds: string[]) => Promise<void> | void;
  onUpload: (files: File[]) => Promise<string[]>;
  onCaptureVideoFrame?: (videoItem: ReferencePickerVideoItem, progressRatio: number) => Promise<string[]>;
};

function sortSelectedItems(selectedIds: string[], items: ReferencePickerItem[]): ReferencePickerItem[] {
  const itemLookup = new Map(items.map((item) => [item.id, item]));
  return selectedIds.map((id) => itemLookup.get(id)).filter((item): item is ReferencePickerItem => Boolean(item));
}

function assetKindLabel(assetKind: ReferencePickerAssetKind): string {
  if (assetKind === "captured_frame") return "Captured frame";
  if (assetKind === "generated_image") return "Generated image";
  return "Uploaded";
}

function sortNewestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

type CropAspectPreset = "free" | "1:1" | "4:3" | "3:2" | "16:9" | "9:16";

const CROP_ASPECT_OPTIONS: Array<{ value: CropAspectPreset; label: string; aspect?: number }> = [
  { value: "free", label: "Free" },
  { value: "1:1", label: "1:1", aspect: 1 },
  { value: "4:3", label: "4:3", aspect: 4 / 3 },
  { value: "3:2", label: "3:2", aspect: 3 / 2 },
  { value: "16:9", label: "16:9", aspect: 16 / 9 },
  { value: "9:16", label: "9:16", aspect: 9 / 16 },
];

function defaultCenteredCrop(mediaWidth: number, mediaHeight: number, aspect?: number): PercentCrop {
  if (!aspect) {
    return {
      unit: "%",
      x: 10,
      y: 10,
      width: 80,
      height: 80,
    };
  }
  return centerCrop(
    makeAspectCrop(
      {
        unit: "%",
        width: 80,
      },
      aspect,
      mediaWidth,
      mediaHeight,
    ),
    mediaWidth,
    mediaHeight,
  );
}

async function createCroppedFile(params: {
  imageElement: HTMLImageElement;
  crop: PixelCrop;
  filename: string;
  mimeType: string;
}): Promise<File> {
  const image = params.imageElement;
  const scaleX = image.naturalWidth / Math.max(1, image.width);
  const scaleY = image.naturalHeight / Math.max(1, image.height);
  const cropX = Math.max(0, Math.round(params.crop.x * scaleX));
  const cropY = Math.max(0, Math.round(params.crop.y * scaleY));
  const cropWidth = Math.max(1, Math.round(params.crop.width * scaleX));
  const cropHeight = Math.max(1, Math.round(params.crop.height * scaleY));
  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Crop preview could not be prepared.");
  }
  ctx.drawImage(
    image,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const preferredMimeType = ["image/jpeg", "image/png", "image/webp"].includes(params.mimeType) ? params.mimeType : "image/png";
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), preferredMimeType, preferredMimeType === "image/jpeg" ? 0.95 : undefined);
  });
  if (!blob) {
    throw new Error("Failed to prepare cropped image.");
  }
  const extension = preferredMimeType === "image/jpeg" ? ".jpg" : preferredMimeType === "image/webp" ? ".webp" : ".png";
  const baseName = params.filename.replace(/\.[^.]+$/, "") || "cropped-image";
  return new File([blob], `${baseName}${extension}`, { type: preferredMimeType });
}

function isCropSupportedMimeType(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType);
}

function sanitizeFilenameSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "reference";
}

async function waitForVideoEvent(video: HTMLVideoElement, eventName: "loadedmetadata" | "seeked"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The selected video could not be prepared for frame capture."));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, handleSuccess);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener(eventName, handleSuccess, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

async function captureVideoFrameFile(params: {
  src: string;
  timeSec: number;
  filenameBase: string;
}): Promise<File> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.src = params.src;
  await waitForVideoEvent(video, "loadedmetadata");
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const targetTime = duration > 0 ? Math.min(Math.max(0, params.timeSec), Math.max(0, duration - 0.01)) : 0;
  if (Math.abs(video.currentTime - targetTime) > 0.01) {
    video.currentTime = targetTime;
    await waitForVideoEvent(video, "seeked");
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, video.videoWidth);
  canvas.height = Math.max(1, video.videoHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Frame capture canvas could not be prepared.");
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), "image/png");
  });
  if (!blob) {
    throw new Error("Failed to render the selected video frame.");
  }
  return new File([blob], `${sanitizeFilenameSegment(params.filenameBase)}-frame-${Math.round(targetTime * 100) / 100}.png`, {
    type: "image/png",
  });
}

async function prepareCropSourceFile(file: File): Promise<File> {
  if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    return file;
  }
  if (!["image/heic", "image/heif"].includes(file.type) && !/\.(heic|heif)$/i.test(file.name)) {
    throw new Error("Upload & crop currently supports JPEG, PNG, WebP, HEIC, and HEIF images.");
  }
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({
    blob: file,
    toType: "image/png",
  });
  const firstBlob = Array.isArray(converted) ? converted[0] : converted;
  if (!(firstBlob instanceof Blob)) {
    throw new Error("The HEIC image could not be prepared for cropping.");
  }
  const baseName = file.name.replace(/\.[^.]+$/, "") || "cropped-image";
  return new File([firstBlob], `${baseName}.png`, { type: "image/png" });
}

export default function ReferenceImagePickerModal({
  isOpen,
  maxSelected,
  selectedIds,
  items,
  videoItems = [],
  initialTab = "upload",
  generatedScopeDefault = "task",
  isSaving = false,
  onClose,
  onConfirm,
  onUpload,
  onCaptureVideoFrame,
}: ReferenceImagePickerModalProps) {
  const [activeTab, setActiveTab] = useState<ReferencePickerInitialTab>(initialTab);
  const defaultScope: ReferencePickerGeneratedScope = generatedScopeDefault === "all_tasks" ? "all_tasks" : "all_tasks";
  const [generatedScope, setGeneratedScope] = useState<ReferencePickerGeneratedScope>(defaultScope);
  const [videoScope, setVideoScope] = useState<ReferencePickerGeneratedScope>(defaultScope);
  const [videoKindFilter, setVideoKindFilter] = useState<"all" | "generated" | "uploaded">("all");
  const [draftSelection, setDraftSelection] = useState<string[]>(selectedIds);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [selectedVideoProgress, setSelectedVideoProgress] = useState(0.5);
  const [selectedVideoCurrentTimeSec, setSelectedVideoCurrentTimeSec] = useState(0);
  const [selectedVideoDurationSec, setSelectedVideoDurationSec] = useState(0);
  const [visibleImageCount, setVisibleImageCount] = useState(12);
  const [visibleVideoCount, setVisibleVideoCount] = useState(12);
  const [cropSource, setCropSource] = useState<{ file: File; objectUrl: string } | null>(null);
  const [cropError, setCropError] = useState<string | null>(null);
  const [cropAspect, setCropAspect] = useState<CropAspectPreset>("free");
  const [crop, setCrop] = useState<Crop | undefined>(undefined);
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const [isCropUploading, setIsCropUploading] = useState(false);
  const [cropImageSize, setCropImageSize] = useState<{ width: number; height: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cropImageRef = useRef<HTMLImageElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const videoUploadInputRef = useRef<HTMLInputElement | null>(null);
  const cropUploadInputRef = useRef<HTMLInputElement | null>(null);
  const wasOpenRef = useRef(isOpen);
  const skipNextAutoVideoSelectionRef = useRef(false);
  const [localVideoItems, setLocalVideoItems] = useState<ReferencePickerVideoItem[]>([]);
  const localVideoItemsRef = useRef<ReferencePickerVideoItem[]>([]);

  function clearLocalVideoItems() {
    setLocalVideoItems((previous) => {
      for (const item of previous) {
        if (item.previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return [];
    });
  }

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setDraftSelection(selectedIds);
      setUploadError(null);
      setCaptureError(null);
      setActiveTab(initialTab);
      setGeneratedScope(defaultScope);
      setVideoScope(defaultScope);
      setVideoKindFilter("all");
      setSelectedVideoProgress(0.5);
      setSelectedVideoCurrentTimeSec(0);
      setSelectedVideoDurationSec(0);
      setVisibleImageCount(12);
      setVisibleVideoCount(12);
      setCropError(null);
      setCropAspect("free");
      setCrop(undefined);
      setCompletedCrop(null);
      setCropImageSize(null);
      clearLocalVideoItems();
    }
    if (!isOpen && wasOpenRef.current) {
      clearLocalVideoItems();
    }
    wasOpenRef.current = isOpen;
  }, [defaultScope, initialTab, isOpen, selectedIds]);

  useEffect(() => {
    localVideoItemsRef.current = localVideoItems;
  }, [localVideoItems]);

  useEffect(() => {
    return () => {
      for (const item of localVideoItemsRef.current) {
        if (item.previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cropSource?.objectUrl) {
        URL.revokeObjectURL(cropSource.objectUrl);
      }
    };
  }, [cropSource]);

  const sortedItems = useMemo(() => sortNewestFirst(items), [items]);
  const sortedVideoItems = useMemo(() => sortNewestFirst([...localVideoItems, ...videoItems]), [localVideoItems, videoItems]);

  const uploadTabItems = useMemo(
    () => sortedItems.filter((item) => item.sourceGroup === "upload"),
    [sortedItems],
  );
  const generatedItems = useMemo(
    () => sortedItems.filter((item) => item.sourceGroup === "generated"),
    [sortedItems],
  );
  const scopedGeneratedItems = useMemo(
    () =>
      generatedItems.filter((item) => {
        if (generatedScope === "all_tasks") return true;
        if (generatedScope === "task") return item.isCurrentTaskAsset;
        return item.matchesCurrentContext;
      }),
    [generatedItems, generatedScope],
  );

  const scopedVideoItems = useMemo(() => {
    const scopeMatchedItems = sortedVideoItems.filter((item) => {
      if (videoScope === "all_tasks") return true;
      if (videoScope === "task") return item.isCurrentTaskAsset;
      return item.matchesCurrentContext;
    });
    if (videoKindFilter === "all") return scopeMatchedItems;
    return scopeMatchedItems.filter((item) => item.sourceKind === videoKindFilter);
  }, [sortedVideoItems, videoKindFilter, videoScope]);

  useEffect(() => {
    if (!selectedVideoId || !scopedVideoItems.some((item) => item.id === selectedVideoId)) {
      if (skipNextAutoVideoSelectionRef.current) {
        skipNextAutoVideoSelectionRef.current = false;
        return;
      }
      setSelectedVideoId(scopedVideoItems[0]?.id ?? null);
      setSelectedVideoProgress(0.5);
      setSelectedVideoCurrentTimeSec(0);
      setSelectedVideoDurationSec(0);
    }
  }, [scopedVideoItems, selectedVideoId]);

  useEffect(() => {
    setVisibleImageCount(12);
  }, [activeTab, generatedScope, items]);

  useEffect(() => {
    setVisibleVideoCount(12);
  }, [activeTab, videoKindFilter, videoScope, videoItems]);

  const selectedItems = useMemo(() => sortSelectedItems(draftSelection, items), [draftSelection, items]);
  const selectedVideo = useMemo(
    () => scopedVideoItems.find((item) => item.id === selectedVideoId) ?? null,
    [scopedVideoItems, selectedVideoId],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selectedVideo) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const nextTime = video.duration * selectedVideoProgress;
    if (Math.abs(video.currentTime - nextTime) > 0.05) {
      video.currentTime = nextTime;
    }
  }, [selectedVideo, selectedVideoProgress]);

  function toggleItem(itemId: string) {
    setDraftSelection((previous) => {
      if (previous.includes(itemId)) {
        return previous.filter((id) => id !== itemId);
      }
      if (previous.length >= maxSelected) {
        return previous;
      }
      return [...previous, itemId];
    });
  }

  function moveSelectedReference(referenceId: string, direction: -1 | 1) {
    setDraftSelection((previous) => {
      const currentIndex = previous.indexOf(referenceId);
      if (currentIndex < 0) return previous;
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= previous.length) return previous;
      const updated = [...previous];
      const [moved] = updated.splice(currentIndex, 1);
      updated.splice(nextIndex, 0, moved);
      return updated;
    });
  }

  function removeSelectedReference(referenceId: string) {
    setDraftSelection((previous) => previous.filter((id) => id !== referenceId));
  }

  function clearCropper() {
    if (cropSource?.objectUrl) {
      URL.revokeObjectURL(cropSource.objectUrl);
    }
    setCropSource(null);
    setCropError(null);
    setCropAspect("free");
    setCrop(undefined);
    setCompletedCrop(null);
    setCropImageSize(null);
  }

  function appendUploadedIdsToSelection(uploadedIds: string[]) {
    setDraftSelection((previous) => {
      const additions = uploadedIds.filter((id) => !previous.includes(id));
      if (!additions.length) return previous;
      const merged = [...previous, ...additions];
      if (merged.length <= maxSelected) return merged;
      const keepExistingCount = Math.max(0, maxSelected - additions.length);
      return [...previous.slice(0, keepExistingCount), ...additions.slice(-maxSelected)];
    });
  }

  function addLocalUploadedVideos(files: File[]) {
    if (!files.length) return;
    const createdAt = new Date().toISOString();
    const nextItems = files.map<ReferencePickerVideoItem>((file, index) => ({
      id: `local-upload-video:${file.name}:${file.lastModified}:${index}:${Date.now()}`,
      taskId: "local-upload-video",
      title: file.name,
      subtitle: "Uploaded in picker · capture frames locally",
      previewUrl: URL.createObjectURL(file),
      createdAt,
      sourceKind: "uploaded",
      isCurrentTaskAsset: true,
      matchesCurrentContext: true,
      canCaptureFrame: true,
      durationSec: null,
      width: null,
      height: null,
    }));
    skipNextAutoVideoSelectionRef.current = true;
    setLocalVideoItems((previous) => [...nextItems, ...previous]);
    setActiveTab("capture_video_frame");
    setVideoKindFilter("uploaded");
    setCaptureError(null);
  }

  async function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;

    setUploadError(null);
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const videoFiles = files.filter((file) => file.type.startsWith("video/"));

    if (videoFiles.length) {
      addLocalUploadedVideos(videoFiles);
    }
    if (!imageFiles.length) return;

    setIsUploading(true);
    try {
      const uploadedIds = await onUpload(imageFiles);
      appendUploadedIdsToSelection(uploadedIds);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleCropFileChange(event: ChangeEvent<HTMLInputElement>) {
    const originalFile = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!originalFile) return;
    clearCropper();
    setCropError(null);
    setIsCropUploading(true);
    try {
      if (!isCropSupportedMimeType(originalFile.type) && !/\.(heic|heif)$/i.test(originalFile.name)) {
        throw new Error("Upload & crop currently supports JPEG, PNG, WebP, HEIC, and HEIF images.");
      }
      const cropFile = await prepareCropSourceFile(originalFile);
      setCropSource({
        file: cropFile,
        objectUrl: URL.createObjectURL(cropFile),
      });
    } catch (error) {
      setCropError(error instanceof Error ? error.message : "Crop upload could not be prepared.");
    } finally {
      setIsCropUploading(false);
    }
  }

  function handleCropImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    cropImageRef.current = image;
    setCropImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    const selectedAspect = CROP_ASPECT_OPTIONS.find((option) => option.value === cropAspect)?.aspect;
    const nextCrop = defaultCenteredCrop(image.naturalWidth, image.naturalHeight, selectedAspect);
    setCrop(nextCrop);
  }

  function handleCropAspectChange(nextAspect: CropAspectPreset) {
    setCropAspect(nextAspect);
    if (!cropImageSize) return;
    const aspect = CROP_ASPECT_OPTIONS.find((option) => option.value === nextAspect)?.aspect;
    setCrop(defaultCenteredCrop(cropImageSize.width, cropImageSize.height, aspect));
  }

  async function handleUploadCroppedImage() {
    if (!cropSource || !completedCrop || completedCrop.width < 1 || completedCrop.height < 1 || !cropImageRef.current) {
      setCropError("Adjust the crop area before uploading.");
      return;
    }
    setCropError(null);
    setIsCropUploading(true);
    try {
      const croppedFile = await createCroppedFile({
        imageElement: cropImageRef.current,
        crop: completedCrop,
        filename: cropSource.file.name,
        mimeType: cropSource.file.type,
      });
      const uploadedIds = await onUpload([croppedFile]);
      appendUploadedIdsToSelection(uploadedIds);
      clearCropper();
    } catch (error) {
      setCropError(error instanceof Error ? error.message : "Crop upload failed");
    } finally {
      setIsCropUploading(false);
    }
  }

  async function captureVideoFrameLocally(videoItem: ReferencePickerVideoItem, timeSec: number): Promise<string[]> {
    let fetchedObjectUrl: string | null = null;
    try {
      let src = videoItem.previewUrl;
      if (!src.startsWith("blob:")) {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`Video download failed: ${response.status}`);
        }
        const blob = await response.blob();
        fetchedObjectUrl = URL.createObjectURL(blob);
        src = fetchedObjectUrl;
      }
      const frameFile = await captureVideoFrameFile({
        src,
        timeSec,
        filenameBase: videoItem.title,
      });
      return onUpload([frameFile]);
    } finally {
      if (fetchedObjectUrl) {
        URL.revokeObjectURL(fetchedObjectUrl);
      }
    }
  }

  async function handleCaptureVideoFrame() {
    if (!selectedVideo) return;
    setCaptureError(null);
    setIsCapturing(true);
    try {
      const captureTimeSec =
        selectedVideoCurrentTimeSec || (selectedVideoDurationSec || selectedVideo.durationSec || 0) * selectedVideoProgress;
      const shouldUseServerCapture =
        selectedVideo.sourceKind === "uploaded" &&
        !selectedVideo.id.startsWith("local-upload-video:") &&
        selectedVideo.canCaptureFrame &&
        Boolean(onCaptureVideoFrame);
      const serverCapture = onCaptureVideoFrame;
      const selectedIds = shouldUseServerCapture
        ? await serverCapture!(selectedVideo, selectedVideoProgress)
        : await captureVideoFrameLocally(selectedVideo, captureTimeSec);
      appendUploadedIdsToSelection(selectedIds);
      setActiveTab(shouldUseServerCapture ? "generated" : "upload");
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "Frame capture failed");
    } finally {
      setIsCapturing(false);
    }
  }

  async function handleConfirm() {
    await onConfirm(draftSelection);
  }

  if (!isOpen) return null;

  const gridItems = activeTab === "upload" ? uploadTabItems : scopedGeneratedItems;
  const visibleGridItems = gridItems.slice(0, visibleImageCount);
  const visibleScopedVideoItems = scopedVideoItems.slice(0, visibleVideoCount);

  const scopeOptions: Array<{ value: ReferencePickerGeneratedScope; label: string }> = [
    { value: "all_tasks", label: "All tasks" },
    { value: "task", label: "Task" },
    { value: "current_mode_task", label: "Current mode + task" },
  ];

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-ink/10 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-lg font-semibold text-ink">Reference Library</p>
              <p className="text-sm text-ink/65">Select up to {maxSelected} images. They are sent to the model in the order shown below.</p>
            </div>
            <button type="button" className="rounded-md border border-ink/20 px-3 py-2 text-sm" onClick={onClose}>
              Cancel
            </button>
          </div>
          <div className="mt-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {selectedItems.length ? (
                selectedItems.map((item, index) => (
                  <div key={item.id} className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-2 py-2">
                    <img src={item.imageUrl} alt={item.title} className="h-10 w-10 rounded bg-white object-contain" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium text-ink">Reference {index + 1}</p>
                      <p className="max-w-[120px] truncate text-[11px] text-ink/60">{item.title}</p>
                    </div>
                    <div className="flex gap-1">
                      <button type="button" className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px]" disabled={index === 0} onClick={() => moveSelectedReference(item.id, -1)}>
                        ←
                      </button>
                      <button
                        type="button"
                        className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px]"
                        disabled={index === selectedItems.length - 1}
                        onClick={() => moveSelectedReference(item.id, 1)}
                      >
                        →
                      </button>
                      <button type="button" className="rounded border border-ink/15 bg-white px-2 py-1 text-[11px]" onClick={() => removeSelectedReference(item.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-dashed border-ink/20 bg-bg px-3 py-3 text-sm text-ink/60">No images selected yet.</div>
              )}
            </div>
            {draftSelection.length >= maxSelected ? (
              <p className="text-xs text-amber-700">Selection is full for this model. Remove an image to add another.</p>
            ) : null}
          </div>
        </div>

        <div className="border-b border-ink/10 px-5 pt-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`rounded-t-md border px-3 py-2 text-sm ${activeTab === "upload" ? "border-ink/20 border-b-white bg-white font-medium" : "border-transparent bg-bg text-ink/65"}`}
              onClick={() => setActiveTab("upload")}
            >
              Uploads
            </button>
            <button
              type="button"
              className={`rounded-t-md border px-3 py-2 text-sm ${activeTab === "generated" ? "border-ink/20 border-b-white bg-white font-medium" : "border-transparent bg-bg text-ink/65"}`}
              onClick={() => setActiveTab("generated")}
            >
              Image library
            </button>
            <button
              type="button"
              className={`rounded-t-md border px-3 py-2 text-sm ${activeTab === "capture_video_frame" ? "border-ink/20 border-b-white bg-white font-medium" : "border-transparent bg-bg text-ink/65"}`}
              onClick={() => setActiveTab("capture_video_frame")}
            >
              Capture video frame
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {activeTab === "upload" ? (
            <div className="mb-4 space-y-3 rounded-lg border border-ink/15 bg-bg p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">Upload new reference images</p>
                  <p className="text-xs text-ink/60">Images keep their original aspect ratio. This tab also shows previously uploaded reference images.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input ref={uploadInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void handleUploadChange(event)} />
                  <input ref={videoUploadInputRef} type="file" accept="video/*" multiple className="hidden" onChange={(event) => void handleUploadChange(event)} />
                  <input
                    ref={cropUploadInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
                    className="hidden"
                    onChange={(event) => void handleCropFileChange(event)}
                  />
                  <button
                    type="button"
                    className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isUploading || isCropUploading}
                    onClick={() => uploadInputRef.current?.click()}
                  >
                    <PendingButtonLabel isPending={isUploading} idle="Upload" pending="Uploading..." />
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isUploading || isCropUploading}
                    onClick={() => videoUploadInputRef.current?.click()}
                  >
                    Upload video
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isUploading || isCropUploading}
                    onClick={() => cropUploadInputRef.current?.click()}
                  >
                    <PendingButtonLabel isPending={isCropUploading} idle="Upload & crop" pending="Preparing..." />
                  </button>
                </div>
              </div>
              {uploadError ? <p className="text-xs text-red-700">{uploadError}</p> : null}
              {!cropSource ? <p className="text-xs text-ink/55">Crop supports JPEG, PNG, WebP, HEIC, and HEIF. Video uploads stay in the picker for frame capture and are not selected directly.</p> : null}
              {cropSource ? (
                <div className="rounded-xl border border-ink/15 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-ink">Crop image</p>
                      <p className="text-xs text-ink/60">Set a fixed aspect ratio or free crop, then upload the cropped image.</p>
                    </div>
                    <button type="button" className="rounded-md border border-ink/20 px-3 py-2 text-sm text-ink" onClick={clearCropper}>
                      Cancel
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-ink/60">Aspect</span>
                    {CROP_ASPECT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                          cropAspect === option.value ? "border-teal-500 bg-teal-50 text-teal-800" : "border-ink/15 bg-white text-ink/70"
                        }`}
                        onClick={() => handleCropAspectChange(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 overflow-hidden rounded-xl border border-ink/10 bg-bg p-3">
                    <ReactCrop
                      crop={crop}
                      onChange={(nextCrop) => setCrop(nextCrop)}
                      onComplete={(nextCrop) => setCompletedCrop(nextCrop)}
                      aspect={CROP_ASPECT_OPTIONS.find((option) => option.value === cropAspect)?.aspect}
                      keepSelection
                      ruleOfThirds
                      minWidth={40}
                      minHeight={40}
                    >
                      <img
                        ref={cropImageRef}
                        src={cropSource.objectUrl}
                        alt="Crop upload"
                        className="max-h-[28rem] w-full object-contain"
                        onLoad={handleCropImageLoad}
                      />
                    </ReactCrop>
                  </div>
                  {cropError ? <p className="mt-3 text-xs text-red-700">{cropError}</p> : null}
                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={clearCropper}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isCropUploading || !completedCrop || completedCrop.width < 1 || completedCrop.height < 1}
                      onClick={() => void handleUploadCroppedImage()}
                    >
                      <PendingButtonLabel isPending={isCropUploading} idle="Upload cropped image" pending="Uploading..." />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "generated" ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink/15 bg-white p-3">
              <p className="text-sm font-medium text-ink">Image library</p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink/60">Filter by</span>
                <select
                  className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm text-ink"
                  value={generatedScope}
                  onChange={(event) => setGeneratedScope(event.target.value as ReferencePickerGeneratedScope)}
                >
                  {scopeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {activeTab === "capture_video_frame" ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink/15 bg-white p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-ink">Choose a video</p>
                    <p className="text-xs text-ink/60">Select a task video, generated output, or upload a video into this picker, then capture a frame into your image references.</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 bg-white px-3 py-2 text-sm font-medium text-ink"
                      onClick={() => videoUploadInputRef.current?.click()}
                    >
                      Upload video
                    </button>
                    <span className="text-ink/60">Filter by</span>
                    <select
                      className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm text-ink"
                      value={videoScope}
                      onChange={(event) => setVideoScope(event.target.value as ReferencePickerGeneratedScope)}
                    >
                      {scopeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm text-ink"
                      value={videoKindFilter}
                      onChange={(event) => setVideoKindFilter(event.target.value as "all" | "generated" | "uploaded")}
                    >
                      <option value="all">All</option>
                      <option value="uploaded">Uploaded</option>
                      <option value="generated">Generated</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {visibleScopedVideoItems.map((item) => {
                    const isSelected = item.id === selectedVideoId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`rounded-lg border p-3 text-left ${isSelected ? "border-teal-500 bg-teal-50" : "border-ink/15 bg-white"}`}
                        onClick={() => {
                          setSelectedVideoId(item.id);
                          setCaptureError(null);
                        }}
                      >
                        <div className="relative overflow-hidden rounded-lg border border-ink/10 bg-bg">
                          {item.thumbnailUrl ? (
                            <img src={item.thumbnailUrl} alt={item.title} className="aspect-video w-full object-cover" loading="lazy" decoding="async" />
                          ) : (
                            <div className="flex aspect-video items-center justify-center text-xs text-ink/55">Video</div>
                          )}
                          <span className="absolute bottom-2 left-2 rounded-full bg-white/90 px-2 py-1 text-[10px] font-medium text-ink shadow-sm">
                            {item.sourceKind === "uploaded" ? "Uploaded" : "Generated"}
                          </span>
                        </div>
                        <p className="mt-2 truncate text-sm font-medium text-ink">{item.title}</p>
                        <p className="truncate text-[11px] text-ink/60">{item.subtitle}</p>
                      </button>
                    );
                  })}
                </div>
                {visibleVideoCount < scopedVideoItems.length ? (
                  <button
                    type="button"
                    className="text-sm font-medium text-accent underline underline-offset-2"
                    onClick={() => setVisibleVideoCount((previous) => previous + 12)}
                  >
                    More...
                  </button>
                ) : null}
                {!scopedVideoItems.length ? <p className="text-sm text-ink/60">No videos match this filter yet.</p> : null}
              </div>

              <div className="space-y-3 rounded-lg border border-ink/15 bg-white p-4">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-ink">Capture frame</p>
                  <p className="text-xs text-ink/60">Captured frames are added to the image library and selected automatically.</p>
                </div>
                {selectedVideo ? (
                  <>
                    <div className="space-y-1">
                      <p className="truncate text-sm font-medium text-ink">{selectedVideo.title}</p>
                      <p className="text-xs text-ink/60">{selectedVideo.subtitle}</p>
                    </div>
                    <div className="overflow-hidden rounded-lg border border-ink/10 bg-bg">
                      <video
                        ref={videoRef}
                        key={selectedVideo.id}
                        src={selectedVideo.previewUrl}
                        controls
                        className="aspect-video w-full bg-black"
                        onLoadedMetadata={(event) => {
                          const duration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : selectedVideo.durationSec ?? 0;
                          setSelectedVideoDurationSec(duration);
                          const nextTime = duration > 0 ? duration * selectedVideoProgress : 0;
                          event.currentTarget.currentTime = nextTime;
                          setSelectedVideoCurrentTimeSec(nextTime);
                        }}
                        onTimeUpdate={(event) => {
                          const duration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0;
                          const currentTime = event.currentTarget.currentTime || 0;
                          setSelectedVideoCurrentTimeSec(currentTime);
                          if (duration > 0) {
                            setSelectedVideoProgress(Math.min(1, Math.max(0, currentTime / duration)));
                          }
                        }}
                      />
                    </div>
                    <label className="block space-y-2">
                      <span className="text-xs font-medium text-ink/75">Capture position</span>
                      <input
                        type="range"
                        min={0}
                        max={1000}
                        step={1}
                        value={Math.round(selectedVideoProgress * 1000)}
                        className="w-full"
                        onChange={(event) => {
                          const nextProgress = Number(event.target.value) / 1000;
                          setSelectedVideoProgress(nextProgress);
                          const video = videoRef.current;
                          const duration = Number.isFinite(video?.duration) ? (video?.duration ?? 0) : selectedVideoDurationSec;
                          if (video && duration > 0) {
                            const nextTime = duration * nextProgress;
                            video.currentTime = nextTime;
                            setSelectedVideoCurrentTimeSec(nextTime);
                          }
                        }}
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2 text-xs text-ink/60">
                      <div className="rounded-md border border-ink/15 bg-bg px-3 py-2">
                        Time: <span className="font-medium text-ink">{selectedVideoCurrentTimeSec.toFixed(2)}s</span>
                      </div>
                      <div className="rounded-md border border-ink/15 bg-bg px-3 py-2">
                        Duration: <span className="font-medium text-ink">{(selectedVideoDurationSec || selectedVideo.durationSec || 0).toFixed(2)}s</span>
                      </div>
                    </div>
                    {captureError ? <p className="text-xs text-red-700">{captureError}</p> : null}
                    <button
                      type="button"
                      className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isCapturing}
                      onClick={() => void handleCaptureVideoFrame()}
                    >
                      <PendingButtonLabel isPending={isCapturing} idle="Capture frame" pending="Capturing..." />
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-ink/60">Select a video to capture a frame.</p>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {visibleGridItems.map((item) => {
                  const selectedIndex = draftSelection.indexOf(item.id);
                  const isSelected = selectedIndex >= 0;
                  const canAdd = isSelected || draftSelection.length < maxSelected;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`rounded-lg border p-2 text-left ${isSelected ? "border-teal-500 bg-teal-50" : "border-ink/15 bg-white"} ${!canAdd ? "opacity-60" : ""}`}
                      disabled={!canAdd}
                      onClick={() => toggleItem(item.id)}
                    >
                      <div className="relative">
                        <img src={item.imageUrl} alt={item.title} className="h-28 w-full rounded bg-bg object-contain" loading="lazy" decoding="async" />
                        {isSelected ? (
                          <span className="absolute left-2 top-2 rounded-full bg-teal-600 px-2 py-1 text-[11px] font-medium text-white">{selectedIndex + 1}</span>
                        ) : null}
                        <span className="absolute bottom-2 left-2 rounded-full bg-white/90 px-2 py-1 text-[10px] font-medium text-ink shadow-sm">
                          {assetKindLabel(item.assetKind)}
                        </span>
                      </div>
                      <p className="mt-2 truncate text-xs font-medium text-ink">{item.title}</p>
                      <p className="truncate text-[11px] text-ink/60">{item.subtitle}</p>
                    </button>
                  );
                })}
              </div>
              {visibleImageCount < gridItems.length ? (
                <button
                  type="button"
                  className="mt-4 text-sm font-medium text-accent underline underline-offset-2"
                  onClick={() => setVisibleImageCount((previous) => previous + 12)}
                >
                  More...
                </button>
              ) : null}
              {!gridItems.length ? (
                <p className="text-sm text-ink/60">
                  {activeTab === "upload"
                    ? "No uploaded reference images are available yet."
                    : "No images match this filter yet."}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="border-t border-ink/10 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink/60">{draftSelection.length} selected</p>
            <div className="flex gap-2">
              <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSaving}
                onClick={() => void handleConfirm()}
              >
                <PendingButtonLabel isPending={isSaving} idle="Save Selection" pending="Saving..." />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { apiTestCurrentUser, apiTestGetIdToken, apiTestLogin, apiTestLogout } from "./lib/apiTestAuth";
import { assertConfig, config } from "./lib/config";
import type { ApiRequestRecord } from "./types/api";
import "./api-test.css";

type Workflow = "image_full" | "image_masked" | "video_reference";

type UploadPreview = {
  id: string;
  name: string;
  type: string;
  url: string;
};

type PreviewAsset = {
  url: string;
  contentType?: string;
  label: string;
};

type VideoModelOption = {
  value: string;
  apiModel?: string;
  label: string;
  mode: string;
  note?: string;
  usesSourceVideo?: boolean;
  requiresLastFrame?: boolean;
};

const IMAGE_FULL_MODELS = [
  { value: "nano_banana", label: "Nano Banana" },
  { value: "nano_banana_pro", label: "Nano Banana Pro" },
  { value: "chatgpt", label: "ChatGPT-image 1.5" },
  { value: "chatgpt_latest", label: "ChatGPT-image 2.0" },
  { value: "luma_uni_1", label: "Luma Uni 1" },
  { value: "luma_uni_1_max", label: "Luma Uni 1 Max" },
  { value: "luma_uni_1_1", label: "Luma Uni 1.1" },
] as const;

const IMAGE_MASKED_MODELS = [
  { value: "nano_banana_pro", label: "Nano Banana Pro" },
  { value: "chatgpt", label: "ChatGPT-image 1.5" },
  { value: "chatgpt_latest", label: "ChatGPT-image 2.0" },
  { value: "runware_flux_fill", label: "Runware Flux Fill" },
  { value: "runware_ace_pp", label: "Runware ACE++" },
] as const;

const VIDEO_MODELS: readonly VideoModelOption[] = [
  { value: "ray-flash-2", label: "Luma Ray 2 Flash", mode: "flex_1" },
  { value: "ray-2", label: "Luma Ray 2", mode: "adhere_1" },
  { value: "runway-gen4.5", label: "Runway Gen-4.5", mode: "runway_i2v" },
  { value: "sora-2-image-to-video", label: "Sora 2 Image to Video", mode: "sora_i2v", note: "Image-to-video only. Uses the first frame image and prompt. Resolution can be auto, 720p or 1080p." },
  { value: "happy-horse-video-edit", label: "Happy Horse 1.0 Video Edit", mode: "happy_horse_video_edit", note: "Uses source video plus up to 3 ordered reference images. In prompts, @Image1..@Image3 follow the referenceAssetKeys order. If none are supplied, the edited first frame is used as the fallback provider reference image. Resolution can be 720p or 1080p." },
  { value: "happy-horse-image-to-video", label: "Happy Horse 1.0 Image to Video", mode: "happy_horse_i2v", note: "Image-to-video only. Uses the first frame image and prompt. Resolution can be 720p or 1080p.", usesSourceVideo: false },
  { value: "runway-gen4-aleph", label: "Runway Gen-4 Aleph", mode: "runway_aleph_v2v", note: "Uses source video plus the edited first frame image. Extra ordered reference images are not used in this route." },
  { value: "kling-2.6", label: "Kling 2.6", mode: "kling_start_only" },
  { value: "kling-o1", label: "Kling O1 Edit", mode: "kling_o1_video_edit", note: "Prompt should reference <<<video_1>>> and the ordered reference images as <<<image_1>>>..<<<image_3>>>. If no extra references are supplied, the edited first frame is used as the fallback provider reference image." },
  { value: "kling-v3-omni-video", label: "Kling V3 Omni Video", mode: "kling_v3_omni_video_edit", note: "Prompt should reference <<<video_1>>> and the ordered reference images as <<<image_1>>>..<<<image_3>>>. If no extra references are supplied, the edited first frame is used as the fallback provider reference image." },
  { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video", mode: "seedance_reference_to_video", note: "Prompt must reference @Video1 and can reference @Image1..@Image3 in the same order as referenceAssetKeys. If no extra references are supplied, the edited first frame is used as the fallback provider reference image." },
  { value: "veo-3.1-fast", label: "Veo 3.1 Fast", mode: "veo_start_only" },
  { value: "veo-3.1", label: "Veo 3.1", mode: "veo_start_only" },
  { value: "wan2.2-a14b", label: "Wan 2.2 A14B", mode: "wan_a14b_i2v" },
  { value: "wan2.2-animate", label: "Wan 2.2 Animate", mode: "wan_animate_replace" },
  { value: "wan2.7-videoedit", label: "Wan 2.7 VideoEdit", mode: "wan27_video_edit" },
  {
    value: "wan2.7-i2v:start_only",
    apiModel: "wan2.7-i2v",
    label: "Wan 2.7 Image to Video",
    mode: "wan27_i2v_start_only",
    note: "Image-to-video only. Uses the first frame image, optional negative prompt, duration up to 10s here, and 720p/1080p output.",
    usesSourceVideo: false,
  },
  {
    value: "wan2.7-i2v:start_end",
    apiModel: "wan2.7-i2v",
    label: "Wan 2.7 Image to Video (Start/End)",
    mode: "wan27_i2v_start_end",
    note: "Uses both first and last frame images, plus optional negative prompt, duration up to 10s here, and 720p/1080p output.",
    usesSourceVideo: false,
    requiresLastFrame: true,
  },
  {
    value: "ltx-2.3-pro",
    label: "LTX 2.3 Pro",
    mode: "ltx23_i2v_start_end",
    note: "Uses edited first and last frame images. Extra ordered reference images are not used in this route.",
    usesSourceVideo: false,
    requiresLastFrame: true,
  },
] as const;

const IMAGE_FULL_REFERENCE_LIMITS: Partial<Record<string, number>> = {
  nano_banana: 3,
  nano_banana_pro: 9,
  chatgpt: 9,
  chatgpt_latest: 9,
};

const IMAGE_MASKED_REFERENCE_LIMITS: Partial<Record<string, number>> = {
  nano_banana_pro: 9,
  chatgpt: 9,
  chatgpt_latest: 9,
  runware_ace_pp: 1,
};

const VIDEO_REFERENCE_LIMITS: Partial<Record<string, number>> = {
  "happy-horse-video-edit": 3,
  "kling-o1": 3,
  "kling-v3-omni-video": 3,
  "seedance-2.0-reference-to-video": 3,
};

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function extractApiErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const errorValue = (payload as { error?: unknown }).error;
    if (typeof errorValue === "string" && errorValue) {
      return errorValue;
    }
    if (errorValue && typeof errorValue === "object") {
      const message = (errorValue as { message?: unknown }).message;
      if (typeof message === "string" && message) {
        return message;
      }
    }
  }
  return fallback;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function requestErrorMessage(record: ApiRequestRecord | null): string | null {
  if (!record?.error) return null;
  if (typeof record.error === "string") return record.error;
  if (typeof record.error.message === "string" && record.error.message) return record.error.message;
  return formatJson(record.error);
}

function requestLogs(record: ApiRequestRecord | null): Array<{ at?: string; source: string; message: string }> {
  if (!record) return [];
  const entries: Array<{ at?: string; source: string; message: string }> = [];
  for (const log of record.logs ?? []) {
    entries.push({ at: log.at, source: "request", message: log.message });
  }
  for (const log of record.job?.logs ?? []) {
    const duplicate = entries.some((entry) => entry.at === log.at && entry.message === log.message);
    if (!duplicate) entries.push({ at: log.at, source: "job", message: log.message });
  }
  const errorMessage = requestErrorMessage(record) ?? record.job?.error ?? null;
  if (errorMessage) {
    entries.push({ at: record.finishedAt ?? record.updatedAt, source: "error", message: errorMessage });
  }
  return entries.sort((left, right) => {
    const leftTime = left.at ? new Date(left.at).getTime() : 0;
    const rightTime = right.at ? new Date(right.at).getTime() : 0;
    return leftTime - rightTime;
  });
}

async function apiTestRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await apiTestGetIdToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(extractApiErrorMessage(payload, `${path} failed: ${response.status}`));
  }
  return payload as T;
}

async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("Failed to read image dimensions"));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function statusLabel(record: ApiRequestRecord | null): string {
  if (!record) return "No request yet";
  return `${record.status.toUpperCase()}${typeof record.processingDurationSec === "number" ? ` · ${record.processingDurationSec.toFixed(1)}s` : ""}`;
}

function environmentLabel(): string {
  if (typeof window === "undefined") return "Unknown";
  if (window.location.hostname === "aivfx.shwsh.co.uk") return "Production";
  if (window.location.pathname.startsWith("/experiments/aivfx")) return "Development";
  return "Custom";
}

async function uploadAsset(file: File, assetType: "image" | "video"): Promise<string> {
  const init = await apiTestRequest<{ assetId: string; assetKey: string; uploadUrl: string }>("/api/v1/assets/uploads/init", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || (assetType === "image" ? "image/png" : "video/mp4"),
      assetType,
    }),
  });

  const response = await fetch(init.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || (assetType === "image" ? "image/png" : "video/mp4"),
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Upload failed for ${file.name}: ${response.status}`);
  }

  return init.assetKey;
}

function createUploadPreview(file: File): UploadPreview {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    type: file.type,
    url: URL.createObjectURL(file),
  };
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || index >= items.length || nextIndex >= items.length) return items;
  const nextItems = [...items];
  const [moved] = nextItems.splice(index, 1);
  nextItems.splice(nextIndex, 0, moved);
  return nextItems;
}

function placeholderAssetKey(file: File | null): string | null {
  return file ? `<assetKey:${file.name}>` : null;
}

function App() {
  const environment = useMemo(() => environmentLabel(), []);
  const currentPage = useMemo(() => (typeof window === "undefined" ? "" : window.location.href.split("#")[0]), []);
  const [workflow, setWorkflow] = useState<Workflow>("image_full");
  const [prompt, setPrompt] = useState("");
  const [imageModel, setImageModel] = useState<string>("nano_banana_pro");
  const [maskedModel, setMaskedModel] = useState<string>("nano_banana_pro");
  const [videoModel, setVideoModel] = useState<string>("ray-flash-2");
  const [klingMode, setKlingMode] = useState<"std" | "pro">("pro");
  const [klingV3Mode, setKlingV3Mode] = useState<"standard" | "pro">("pro");
  const [wan27Resolution, setWan27Resolution] = useState<"720p" | "1080p">("720p");
  const [happyHorseResolution, setHappyHorseResolution] = useState<"720p" | "1080p">("1080p");
  const [wan27NegativePrompt, setWan27NegativePrompt] = useState("");
  const [sora2Resolution, setSora2Resolution] = useState<"auto" | "720p" | "1080p">("auto");
  const [durationSeconds, setDurationSeconds] = useState<number>(4);
  const [preserveFrames, setPreserveFrames] = useState(true);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [lastFrameFile, setLastFrameFile] = useState<File | null>(null);
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [imagePreview, setImagePreview] = useState<UploadPreview | null>(null);
  const [videoPreview, setVideoPreview] = useState<UploadPreview | null>(null);
  const [lastFramePreview, setLastFramePreview] = useState<UploadPreview | null>(null);
  const [maskPreview, setMaskPreview] = useState<UploadPreview | null>(null);
  const [referenceImagePreviews, setReferenceImagePreviews] = useState<UploadPreview[]>([]);
  const [currentUserLabel, setCurrentUserLabel] = useState<string>("Checking sign-in…");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [activity, setActivity] = useState<string>("Idle");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [requestDetail, setRequestDetail] = useState<ApiRequestRecord | null>(null);
  const [previewAsset, setPreviewAsset] = useState<PreviewAsset | null>(null);

  const selectedVideoModel = useMemo(
    () => VIDEO_MODELS.find((model) => model.value === videoModel) ?? VIDEO_MODELS[0],
    [videoModel],
  );
  const selectedVideoModelUsesSourceVideo = useMemo(
    () =>
      selectedVideoModel.usesSourceVideo ??
      !["runway-gen4.5", "sora-2-image-to-video", "kling-2.6", "veo-3.1", "veo-3.1-fast", "wan2.2-a14b"].includes(
        selectedVideoModel.apiModel ?? selectedVideoModel.value,
      ),
    [selectedVideoModel.apiModel, selectedVideoModel.usesSourceVideo, selectedVideoModel.value],
  );
  const referenceImageLimit = useMemo(() => {
    if (workflow === "image_full") return IMAGE_FULL_REFERENCE_LIMITS[imageModel] ?? 0;
    if (workflow === "image_masked") return IMAGE_MASKED_REFERENCE_LIMITS[maskedModel] ?? 0;
    return VIDEO_REFERENCE_LIMITS[selectedVideoModel.apiModel ?? selectedVideoModel.value] ?? 0;
  }, [imageModel, maskedModel, selectedVideoModel.apiModel, selectedVideoModel.value, workflow]);
  const supportsReferenceImages = referenceImageLimit > 0;
  const referenceTokenPrefix = useMemo(() => {
    const model = selectedVideoModel.apiModel ?? selectedVideoModel.value;
    if (workflow !== "video_reference") return null;
    if (model === "seedance-2.0-reference-to-video" || model === "happy-horse-video-edit") return "@Image";
    if (model === "kling-o1" || model === "kling-v3-omni-video") return "<<<image_";
    return null;
  }, [selectedVideoModel.apiModel, selectedVideoModel.value, workflow]);
  const outputAsset = requestDetail?.outputAssets?.output?.url
    ? {
        url: requestDetail.outputAssets.output.url,
        contentType: requestDetail.outputAssets.output.contentType,
        label: requestDetail.outputAssets.output.contentType?.startsWith("video/") ? "API video output" : "API image output",
      }
    : null;
  const referenceOrderingNotes = useMemo(() => {
    if (!supportsReferenceImages) return [] as string[];
    if (workflow === "image_full") {
      return [
        "inputAssetKey is the base image being edited.",
        "referenceAssetKeys are additional reference images, kept in the exact array order supplied.",
        "If your prompt depends on order, describe the first, second, and third additional reference explicitly.",
      ];
    }
    if (workflow === "image_masked") {
      if (maskedModel === "runware_ace_pp") {
        return ["Runware ACE++ uses only the first reference image in referenceAssetKeys."];
      }
      return [
        "patchAssetKey is the editable patch image.",
        "referenceAssetKeys are additional reference images, kept in the exact array order supplied.",
        "If your prompt depends on order, describe the first, second, and third additional reference explicitly.",
      ];
    }
    const model = selectedVideoModel.apiModel ?? selectedVideoModel.value;
    if (model === "seedance-2.0-reference-to-video") {
      return [
        "@Video1 refers to videoAssetKey.",
        "@Image1, @Image2, and @Image3 map to referenceAssetKeys[0], [1], and [2] in order.",
        "If referenceAssetKeys is empty, the route falls back to firstFrameAssetKey as the provider-side image reference.",
      ];
    }
    if (model === "happy-horse-video-edit") {
      return [
        "referenceAssetKeys[0], [1], and [2] are passed to the provider in order.",
        "If referenceAssetKeys is empty, the route falls back to firstFrameAssetKey as the provider-side image reference.",
        "When you mention @Image1 in the prompt, it should refer to the first ordered reference image.",
      ];
    }
    if (model === "kling-o1" || model === "kling-v3-omni-video") {
      return [
        "<<<video_1>>> refers to videoAssetKey.",
        "<<<image_1>>>, <<<image_2>>>, and <<<image_3>>> map to referenceAssetKeys[0], [1], and [2] in order.",
        "If referenceAssetKeys is empty, the route falls back to firstFrameAssetKey as the provider-side image reference.",
      ];
    }
    return ["referenceAssetKeys are sent in the same order shown above."];
  }, [maskedModel, selectedVideoModel.apiModel, selectedVideoModel.value, supportsReferenceImages, workflow]);
  const requestPreview = useMemo(() => {
    const referenceAssetKeys = referenceImageFiles.map((file) => placeholderAssetKey(file)).filter((value): value is string => Boolean(value));
    if (workflow === "image_full") {
      return {
        endpoint: "/api/v1/image-edits/full",
        body: {
          model: imageModel,
          prompt: prompt || "<prompt>",
          inputAssetKey: placeholderAssetKey(imageFile),
          ...(referenceAssetKeys.length ? { referenceAssetKeys } : {}),
        },
      };
    }
    if (workflow === "image_masked") {
      return {
        endpoint: "/api/v1/image-edits/patch",
        body: {
          model: maskedModel,
          prompt: prompt || "<prompt>",
          inputAssetKey: placeholderAssetKey(imageFile),
          patchAssetKey: placeholderAssetKey(imageFile),
          maskAssetKey: placeholderAssetKey(maskFile),
          ...(referenceAssetKeys.length ? { referenceAssetKeys } : {}),
          patchRect: { x: 0, y: 0, width: "<image width>", height: "<image height>" },
          featherPx: 0,
          bleedPx: 0,
          edgeAwareRefine: true,
          edgeAwareStrength: 0.45,
          edgeAwareRadiusPx: 6,
          maskGrowPx: 0,
        },
      };
    }
    return {
      endpoint: "/api/v1/video-generations/reference-video",
      body: {
        model: selectedVideoModel.apiModel ?? selectedVideoModel.value,
        mode: selectedVideoModel.mode,
        prompt: prompt || "<prompt>",
        videoAssetKey: selectedVideoModelUsesSourceVideo ? placeholderAssetKey(videoFile) : undefined,
        firstFrameAssetKey: placeholderAssetKey(imageFile),
        lastFrameAssetKey: selectedVideoModel.requiresLastFrame ? placeholderAssetKey(lastFrameFile) : undefined,
        ...(referenceAssetKeys.length ? { referenceAssetKeys } : {}),
        ...(selectedVideoModel.apiModel === "wan2.7-i2v" ? { negativePrompt: wan27NegativePrompt || "<optional negative prompt>" } : {}),
      },
    };
  }, [imageFile, imageModel, lastFrameFile, maskFile, maskedModel, prompt, referenceImageFiles, selectedVideoModel.apiModel, selectedVideoModel.mode, selectedVideoModel.requiresLastFrame, selectedVideoModel.value, selectedVideoModelUsesSourceVideo, videoFile, wan27NegativePrompt, workflow]);
  const logEntries = requestLogs(requestDetail);
  const fullErrorMessage = requestErrorMessage(requestDetail);

  useEffect(() => {
    try {
      assertConfig();
    } catch (configError) {
      setError(configError instanceof Error ? configError.message : "Missing API test configuration");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUser() {
      const user = await apiTestCurrentUser();
      if (cancelled) return;
      if (user) {
        setIsAuthenticated(true);
        setCurrentUserLabel(user.username);
      } else {
        setIsAuthenticated(false);
        setCurrentUserLabel("Not signed in");
      }
    }

    void loadUser();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!requestId) return undefined;
    const activeRequestId = requestId;
    let cancelled = false;

    async function poll() {
      try {
        const detail = await apiTestRequest<ApiRequestRecord>(`/api/v1/requests/${activeRequestId}`);
        if (!cancelled) {
          setRequestDetail(detail);
          setActivity(`Polling request ${activeRequestId} · ${detail.status}`);
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Failed to poll request");
        }
      }
    }

    void poll();
    const interval = window.setInterval(() => {
      if (requestDetail?.status === "complete" || requestDetail?.status === "failed") return;
      void poll();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [requestId, requestDetail?.status]);

  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview.url);
      if (videoPreview) URL.revokeObjectURL(videoPreview.url);
      if (lastFramePreview) URL.revokeObjectURL(lastFramePreview.url);
      if (maskPreview) URL.revokeObjectURL(maskPreview.url);
      for (const preview of referenceImagePreviews) URL.revokeObjectURL(preview.url);
    };
  }, [imagePreview, lastFramePreview, maskPreview, referenceImagePreviews, videoPreview]);

  useEffect(() => {
    setReferenceImageFiles((previous) => previous.slice(0, referenceImageLimit));
    setReferenceImagePreviews((previous) => {
      const kept = previous.slice(0, referenceImageLimit);
      for (const preview of previous.slice(referenceImageLimit)) {
        URL.revokeObjectURL(preview.url);
      }
      return kept;
    });
  }, [referenceImageLimit]);

  function updatePreview(
    file: File | null,
    setFile: (value: File | null) => void,
    existing: UploadPreview | null,
    setPreview: (value: UploadPreview | null) => void,
  ) {
    if (existing) URL.revokeObjectURL(existing.url);
    setFile(file);
    if (!file) {
      setPreview(null);
      return;
    }
    setPreview(createUploadPreview(file));
  }

  function addReferenceImages(files: FileList | File[]) {
    const nextFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!nextFiles.length) return;
    const remainingSlots = Math.max(0, referenceImageLimit - referenceImageFiles.length);
    const acceptedFiles = supportsReferenceImages ? nextFiles.slice(0, remainingSlots) : [];
    if (!acceptedFiles.length) return;
    setReferenceImageFiles((previous) => [...previous, ...acceptedFiles]);
    setReferenceImagePreviews((previous) => [...previous, ...acceptedFiles.map((file) => createUploadPreview(file))]);
  }

  function moveReferenceImage(index: number, direction: -1 | 1) {
    setReferenceImageFiles((previous) => moveItem(previous, index, direction));
    setReferenceImagePreviews((previous) => moveItem(previous, index, direction));
  }

  function removeReferenceImage(index: number) {
    setReferenceImageFiles((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
    setReferenceImagePreviews((previous) => {
      const removed = previous[index];
      if (removed) URL.revokeObjectURL(removed.url);
      return previous.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  async function handleSubmit() {
    setError(null);
    setSuccessMessage(null);
    setActivity("Validating inputs");

    if (!isAuthenticated) {
      setError("Sign in first.");
      return;
    }
    if (!prompt.trim()) {
      setError("Prompt is required.");
      return;
    }
    if ((workflow === "image_full" || workflow === "image_masked") && !imageFile) {
      setError("Select an image.");
      return;
    }
    if (workflow === "image_masked" && !maskFile) {
      setError("Select a mask for masked image edit.");
      return;
    }
    if (workflow === "video_reference" && !imageFile) {
      setError("Select the edited first frame image.");
      return;
    }
    if (workflow === "video_reference" && selectedVideoModelUsesSourceVideo && !videoFile) {
      setError("Select the source video for this model.");
      return;
    }
    if (workflow === "video_reference" && selectedVideoModel.requiresLastFrame && !lastFrameFile) {
      setError("Select the edited last frame image for this mode.");
      return;
    }
    if (referenceImageFiles.length > referenceImageLimit) {
      setError(`This model supports up to ${referenceImageLimit} ordered reference image${referenceImageLimit === 1 ? "" : "s"}.`);
      return;
    }

    setIsSubmitting(true);
    setRequestId(null);
    setRequestDetail(null);

    try {
      if (workflow === "image_full") {
        setActivity("Uploading source image");
        const inputAssetKey = await uploadAsset(imageFile!, "image");
        const referenceAssetKeys = referenceImageFiles.length ? await Promise.all(referenceImageFiles.map((file) => uploadAsset(file, "image"))) : [];
        setActivity("Submitting full image edit request");
        const created = await apiTestRequest<{ requestId: string; jobId: string }>("/api/v1/image-edits/full", {
          method: "POST",
          body: JSON.stringify({
            model: imageModel,
            prompt: prompt.trim(),
            inputAssetKey,
            referenceAssetKeys,
          }),
        });
        setRequestId(created.requestId);
        setSuccessMessage(`Queued full image edit: ${created.requestId}`);
        setActivity(`Queued full image edit ${created.requestId}`);
      } else if (workflow === "image_masked") {
        setActivity("Uploading source image and mask");
        const [inputAssetKey, maskAssetKey] = await Promise.all([
          uploadAsset(imageFile!, "image"),
          uploadAsset(maskFile!, "image"),
        ]);
        const referenceAssetKeys = referenceImageFiles.length ? await Promise.all(referenceImageFiles.map((file) => uploadAsset(file, "image"))) : [];
        const dimensions = await readImageDimensions(imageFile!);
        setActivity("Submitting masked image edit request");
        const created = await apiTestRequest<{ requestId: string; jobId: string }>("/api/v1/image-edits/patch", {
          method: "POST",
          body: JSON.stringify({
            model: maskedModel,
            prompt: prompt.trim(),
            inputAssetKey,
            patchAssetKey: inputAssetKey,
            maskAssetKey,
            patchRect: {
              x: 0,
              y: 0,
              width: dimensions.width,
              height: dimensions.height,
            },
            featherPx: 0,
            bleedPx: 0,
            edgeAwareRefine: true,
            edgeAwareStrength: 0.45,
            edgeAwareRadiusPx: 6,
            maskGrowPx: 0,
            referenceAssetKeys,
          }),
        });
        setRequestId(created.requestId);
        setSuccessMessage(`Queued masked image edit: ${created.requestId}`);
        setActivity(`Queued masked image edit ${created.requestId}`);
      } else {
        setActivity(selectedVideoModelUsesSourceVideo ? "Uploading source video and first frame" : "Uploading first frame");
        const firstFrameAssetKey = await uploadAsset(imageFile!, "image");
        const lastFrameAssetKey = selectedVideoModel.requiresLastFrame && lastFrameFile ? await uploadAsset(lastFrameFile, "image") : null;
        const videoAssetKey = selectedVideoModelUsesSourceVideo && videoFile ? await uploadAsset(videoFile, "video") : null;
        const referenceAssetKeys = referenceImageFiles.length ? await Promise.all(referenceImageFiles.map((file) => uploadAsset(file, "image"))) : [];
        setActivity("Submitting reference video generation request");
        const created = await apiTestRequest<{ requestId: string; jobId: string }>("/api/v1/video-generations/reference-video", {
          method: "POST",
          body: JSON.stringify({
            model: selectedVideoModel.apiModel ?? selectedVideoModel.value,
            mode: selectedVideoModel.mode,
            prompt: prompt.trim(),
            negativePrompt: (selectedVideoModel.apiModel ?? selectedVideoModel.value) === "wan2.7-i2v" ? wan27NegativePrompt.trim() || undefined : undefined,
            videoAssetKey,
            firstFrameAssetKey,
            lastFrameAssetKey,
            referenceAssetKeys,
            durationSeconds: ["sora-2-image-to-video", "wan2.7-i2v", "happy-horse-image-to-video"].includes(selectedVideoModel.apiModel ?? selectedVideoModel.value)
              ? durationSeconds
              : undefined,
            replicateKlingMode: (selectedVideoModel.apiModel ?? selectedVideoModel.value) === "kling-o1" ? klingMode : undefined,
            replicateKlingV3Mode: (selectedVideoModel.apiModel ?? selectedVideoModel.value) === "kling-v3-omni-video" ? klingV3Mode : undefined,
            wan27Resolution: ["wan2.7-videoedit", "wan2.7-i2v"].includes(selectedVideoModel.apiModel ?? selectedVideoModel.value) ? wan27Resolution : undefined,
            happyHorseResolution: ["happy-horse-video-edit", "happy-horse-image-to-video"].includes(selectedVideoModel.apiModel ?? selectedVideoModel.value) ? happyHorseResolution : undefined,
            sora2Resolution: (selectedVideoModel.apiModel ?? selectedVideoModel.value) === "sora-2-image-to-video" ? sora2Resolution : undefined,
            preserveFrames,
          }),
        });
        setRequestId(created.requestId);
        setSuccessMessage(`Queued reference-video generation: ${created.requestId}`);
        setActivity(`Queued reference-video generation ${created.requestId}`);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Request failed");
      setActivity("Failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="api-test-shell">
      <header className="api-test-hero">
        <h1 className="api-test-title">AIVFX API Playground</h1>
        <p className="api-test-subtitle">
          Use Cognito to sign in, upload assets, submit requests, and inspect the exact API schema and payload shape being used. This page is environment-specific, so local or external API clients must use the same API base, user pool, app client, and Hosted UI domain shown here.
        </p>
      </header>

      <div className="api-test-grid">
        <section className="api-card">
          <div className="api-card-inner api-section-stack">
            <div>
              <h2>Auth</h2>
              <p className="api-muted">
                Browser auth uses Cognito Hosted UI with PKCE and sends the Cognito ID token as the bearer token for API calls. The callback for this page must be allowed in the Cognito app client.
              </p>
            </div>

            <div className="api-auth-row">
              <div className="api-preview-tile">
                <strong>Environment</strong>
                <span>{environment}</span>
              </div>
              <div className="api-preview-tile">
                <strong>Current user</strong>
                <span>{currentUserLabel}</span>
              </div>
              <div className="api-preview-tile">
                <strong>Public playground</strong>
                <span>{currentPage}</span>
              </div>
              <div className="api-preview-tile">
                <strong>Callback URL</strong>
                <span>{currentPage}</span>
              </div>
            </div>

            <div className="api-button-row">
              <button type="button" className="api-button" onClick={() => void apiTestLogin()}>
                Sign In
              </button>
              <button type="button" className="api-button api-button-secondary" onClick={() => void apiTestLogout()}>
                Sign Out
              </button>
              <span className={`api-pill ${!isAuthenticated ? "api-pill-warn" : ""}`}>
                {isAuthenticated ? "Authenticated" : "Authentication required"}
              </span>
            </div>

            <p className="api-muted">
              If you built a local API client before the prod/dev split, repoint it to the environment values on this page. For localhost testing, `http://localhost:5173/` and `http://localhost:5173/api-test.html` are currently allowed in the production app client. Any other localhost port or callback path must be added in Cognito first.
            </p>
          </div>
        </section>

        <section className="api-card">
          <div className="api-card-inner api-section-stack">
            <div>
              <h2>Config</h2>
              <p className="api-muted">These are browser-safe identifiers. Do not put API keys or app client secrets in this page.</p>
            </div>
            <div className="api-kv">
              <div className="api-kv-row">
                <span>Bearer token</span>
                <span>Cognito ID token</span>
              </div>
              <div className="api-kv-row">
                <span>API base</span>
                <span>{config.apiBaseUrl}</span>
              </div>
              <div className="api-kv-row">
                <span>User pool</span>
                <span>{config.cognito.userPoolId}</span>
              </div>
              <div className="api-kv-row">
                <span>App client</span>
                <span>{config.cognito.userPoolClientId}</span>
              </div>
              <div className="api-kv-row">
                <span>Hosted UI domain</span>
                <span>{config.cognito.domain}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="api-card">
          <div className="api-card-inner api-section-stack">
            <div>
              <h2>Submit Request</h2>
              <p className="api-muted">Pick a workflow, upload the required media, and submit against the external API routes.</p>
            </div>

            <div className="api-inline-grid">
              <div className="api-field">
                <label htmlFor="workflow">Workflow</label>
                <select id="workflow" value={workflow} onChange={(event) => setWorkflow(event.target.value as Workflow)}>
                  <option value="image_full">Image full edit</option>
                  <option value="image_masked">Image masked edit</option>
                  <option value="video_reference">Reference video generation</option>
                </select>
              </div>

              {workflow === "image_full" ? (
                <div className="api-field">
                  <label htmlFor="imageModel">Model</label>
                  <select id="imageModel" value={imageModel} onChange={(event) => setImageModel(event.target.value)}>
                    {IMAGE_FULL_MODELS.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {workflow === "image_masked" ? (
                <div className="api-field">
                  <label htmlFor="maskedModel">Model</label>
                  <select id="maskedModel" value={maskedModel} onChange={(event) => setMaskedModel(event.target.value)}>
                    {IMAGE_MASKED_MODELS.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {workflow === "video_reference" ? (
                <div className="api-field">
                  <label htmlFor="videoModel">Video model</label>
                  <select id="videoModel" value={videoModel} onChange={(event) => setVideoModel(event.target.value)}>
                    {VIDEO_MODELS.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  {selectedVideoModel.note ? <small>{selectedVideoModel.note}</small> : null}
                </div>
              ) : null}
            </div>

            {workflow === "video_reference" && videoModel === "kling-o1" ? (
              <div className="api-field">
                <label htmlFor="klingMode">Kling O1 mode</label>
                <select id="klingMode" value={klingMode} onChange={(event) => setKlingMode(event.target.value as "std" | "pro")}>
                  <option value="pro">Pro</option>
                  <option value="std">Std</option>
                </select>
              </div>
            ) : null}

            {workflow === "video_reference" && videoModel === "kling-v3-omni-video" ? (
              <div className="api-field">
                <label htmlFor="klingV3Mode">Kling V3 mode</label>
                <select
                  id="klingV3Mode"
                  value={klingV3Mode}
                  onChange={(event) => setKlingV3Mode(event.target.value as "standard" | "pro")}
                >
                  <option value="pro">Pro</option>
                  <option value="standard">Standard</option>
                </select>
              </div>
            ) : null}

            {workflow === "video_reference" && ["wan2.7-videoedit", "wan2.7-i2v:start_only", "wan2.7-i2v:start_end"].includes(videoModel) ? (
              <div className="api-field">
                <label htmlFor="wan27Resolution">Wan 2.7 resolution</label>
                <select
                  id="wan27Resolution"
                  value={wan27Resolution}
                  onChange={(event) => setWan27Resolution(event.target.value as "720p" | "1080p")}
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </div>
            ) : null}

            {workflow === "video_reference" && ["happy-horse-video-edit", "happy-horse-image-to-video"].includes(videoModel) ? (
              <div className="api-field">
                <label htmlFor="happyHorseResolution">Happy Horse resolution</label>
                <select
                  id="happyHorseResolution"
                  value={happyHorseResolution}
                  onChange={(event) => setHappyHorseResolution(event.target.value as "720p" | "1080p")}
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </div>
            ) : null}

            {workflow === "video_reference" && ["sora-2-image-to-video", "wan2.7-i2v:start_only", "wan2.7-i2v:start_end", "happy-horse-image-to-video"].includes(videoModel) ? (
              <div className="api-inline-grid">
                {videoModel === "sora-2-image-to-video" ? (
                  <div className="api-field">
                    <label htmlFor="sora2Resolution">Sora 2 resolution</label>
                    <select
                      id="sora2Resolution"
                      value={sora2Resolution}
                      onChange={(event) => setSora2Resolution(event.target.value as "auto" | "720p" | "1080p")}
                    >
                      <option value="auto">auto</option>
                      <option value="720p">720p</option>
                      <option value="1080p">1080p</option>
                    </select>
                  </div>
                ) : null}
                <div className="api-field">
                  <label htmlFor="durationSeconds">Duration (seconds)</label>
                  <input
                    id="durationSeconds"
                    type="number"
                    min={videoModel === "happy-horse-image-to-video" ? 3 : 4}
                    max={videoModel === "happy-horse-image-to-video" ? 15 : 10}
                    step={1}
                    value={durationSeconds}
                    onChange={(event) =>
                      setDurationSeconds(
                        videoModel === "happy-horse-image-to-video"
                          ? Math.max(3, Math.min(15, Number(event.target.value) || 3))
                          : Math.max(4, Math.min(10, Number(event.target.value) || 4)),
                      )
                    }
                  />
                </div>
              </div>
            ) : null}

            {workflow === "video_reference" && (selectedVideoModel.apiModel ?? selectedVideoModel.value) === "wan2.7-i2v" ? (
              <div className="api-field">
                <label htmlFor="wan27NegativePrompt">Wan 2.7 negative prompt</label>
                <textarea
                  id="wan27NegativePrompt"
                  value={wan27NegativePrompt}
                  onChange={(event) => setWan27NegativePrompt(event.target.value)}
                  placeholder="Optional. Describe content or artifacts to avoid."
                />
              </div>
            ) : null}

            {workflow === "video_reference" ? (
              <div className="api-field">
                <label className="api-checkbox">
                  <input type="checkbox" checked={preserveFrames} onChange={(event) => setPreserveFrames(event.target.checked)} />
                  <span>Preserve source frames when model input FPS is lower than source FPS</span>
                </label>
              </div>
            ) : null}

            <div className="api-field">
              <label htmlFor="prompt">Prompt</label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  workflow === "video_reference"
                    ? "Describe the edit clearly and reference the uploaded media if the selected model requires it."
                    : "Describe the edit clearly."
                }
              />
            </div>

            <div className="api-inline-grid">
              <div className="api-field">
                <label htmlFor="imageFile">{workflow === "video_reference" ? "Edited first frame image" : "Image input"}</label>
                <input
                  id="imageFile"
                  type="file"
                  accept="image/*"
                  onChange={(event) => updatePreview(event.target.files?.[0] ?? null, setImageFile, imagePreview, setImagePreview)}
                />
              </div>

              {workflow === "video_reference" && selectedVideoModel.requiresLastFrame ? (
                <div className="api-field">
                  <label htmlFor="lastFrameFile">Edited last frame image</label>
                  <input
                    id="lastFrameFile"
                    type="file"
                    accept="image/*"
                    onChange={(event) => updatePreview(event.target.files?.[0] ?? null, setLastFrameFile, lastFramePreview, setLastFramePreview)}
                  />
                </div>
              ) : null}

              {workflow === "video_reference" && selectedVideoModelUsesSourceVideo ? (
                <div className="api-field">
                  <label htmlFor="videoFile">Source video</label>
                  <input
                    id="videoFile"
                    type="file"
                    accept="video/*"
                    onChange={(event) => updatePreview(event.target.files?.[0] ?? null, setVideoFile, videoPreview, setVideoPreview)}
                  />
                </div>
              ) : workflow !== "video_reference" ? (
                <div className="api-field">
                  <label htmlFor="maskFile">Optional mask</label>
                  <input
                    id="maskFile"
                    type="file"
                    accept="image/*"
                    onChange={(event) => updatePreview(event.target.files?.[0] ?? null, setMaskFile, maskPreview, setMaskPreview)}
                  />
                  <small>{workflow === "image_masked" ? "Required for masked edit." : "Ignored for full image edits."}</small>
                </div>
              ) : null}
            </div>

            <div className="api-field">
              <label htmlFor="referenceImages">Ordered reference images</label>
              <input
                id="referenceImages"
                type="file"
                accept="image/*"
                multiple
                disabled={!supportsReferenceImages || referenceImageFiles.length >= referenceImageLimit}
                onChange={(event) => {
                  addReferenceImages(event.target.files ?? []);
                  event.currentTarget.value = "";
                }}
              />
              {!supportsReferenceImages ? (
                <small>This route does not accept extra ordered reference images for the selected model.</small>
              ) : (
                <small>
                  Upload up to {referenceImageLimit} ordered reference image{referenceImageLimit === 1 ? "" : "s"}. The array order is preserved and used when the provider supports prompt tokens such as @Image1 or &lt;&lt;&lt;image_1&gt;&gt;&gt;.
                </small>
              )}
            </div>

            {referenceImagePreviews.length ? (
              <div className="api-reference-list">
                {referenceImagePreviews.map((preview, index) => (
                  <div key={preview.id} className="api-reference-item">
                    <img src={preview.url} alt={preview.name} className="api-reference-thumb" />
                    <div className="api-reference-meta">
                      <strong>
                        {workflow === "video_reference" && referenceTokenPrefix
                          ? referenceTokenPrefix === "<<<image_"
                            ? `<<<image_${index + 1}>>>`
                            : `${referenceTokenPrefix}${index + 1}`
                          : `Reference ${index + 1}`}
                      </strong>
                      <span>{preview.name}</span>
                    </div>
                    <div className="api-reference-actions">
                      <button type="button" className="api-button api-button-secondary" disabled={index === 0} onClick={() => moveReferenceImage(index, -1)}>
                        ←
                      </button>
                      <button
                        type="button"
                        className="api-button api-button-secondary"
                        disabled={index === referenceImagePreviews.length - 1}
                        onClick={() => moveReferenceImage(index, 1)}
                      >
                        →
                      </button>
                      <button type="button" className="api-button api-button-secondary" onClick={() => removeReferenceImage(index)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {referenceOrderingNotes.length ? (
              <div className="api-doc-panel">
                <h3>Reference order</h3>
                <ul className="api-doc-list">
                  {referenceOrderingNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="api-doc-panel">
              <h3>Request shape</h3>
              <p className="api-muted">This is the JSON body the playground will submit after it uploads your selected files and replaces the placeholder values with real asset keys.</p>
              <pre className="api-code">{formatJson(requestPreview)}</pre>
            </div>

            <div className="api-button-row">
              <button type="button" className="api-button" disabled={isSubmitting} onClick={() => void handleSubmit()}>
                {isSubmitting ? "Submitting…" : "Upload And Submit"}
              </button>
              <span className={`api-pill ${requestDetail?.status === "failed" ? "api-pill-warn" : ""}`}>{statusLabel(requestDetail)}</span>
            </div>

            <div className="api-preview-tile">
              <strong>Current activity</strong>
              <span>{activity}</span>
            </div>

            {error ? <div className="api-alert api-alert-error">{error}</div> : null}
            {successMessage ? <div className="api-alert api-alert-success">{successMessage}</div> : null}
          </div>
        </section>

        <section className="api-card">
          <div className="api-card-inner api-section-stack">
            <div>
              <h2>Local Media Preview</h2>
              <p className="api-muted">This only shows what you selected in the browser before upload.</p>
            </div>

            <div className="api-preview-grid">
              {imagePreview ? (
                <div className="api-preview-tile">
                  <strong>{imagePreview.name}</strong>
                  <img src={imagePreview.url} alt={imagePreview.name} className="api-preview-media" />
                </div>
              ) : null}

              {videoPreview ? (
                <div className="api-preview-tile">
                  <strong>{videoPreview.name}</strong>
                  <video src={videoPreview.url} controls className="api-preview-media" />
                </div>
              ) : null}

              {lastFramePreview ? (
                <div className="api-preview-tile">
                  <strong>{lastFramePreview.name}</strong>
                  <img src={lastFramePreview.url} alt={lastFramePreview.name} className="api-preview-media" />
                </div>
              ) : null}

              {maskPreview ? (
                <div className="api-preview-tile">
                  <strong>{maskPreview.name}</strong>
                  <img src={maskPreview.url} alt={maskPreview.name} className="api-preview-media" />
                </div>
              ) : null}

              {referenceImagePreviews.length ? (
                <div className="api-preview-tile api-preview-tile-span">
                  <strong>Ordered reference images</strong>
                  <div className="api-reference-preview-grid">
                    {referenceImagePreviews.map((preview, index) => (
                      <div key={preview.id} className="api-reference-preview-card">
                        <img src={preview.url} alt={preview.name} className="api-preview-media" />
                        <span>{`Reference ${index + 1}`}</span>
                        <small>{preview.name}</small>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="api-card">
          <div className="api-card-inner api-section-stack">
            <div>
              <h2>Request Result</h2>
              <p className="api-muted">The page polls the external API request record and shows the returned output asset when ready.</p>
            </div>

            <div className="api-kv">
              <div className="api-kv-row">
                <span>Request ID</span>
                <span>{requestDetail?.requestId ?? "n/a"}</span>
              </div>
              <div className="api-kv-row">
                <span>Status</span>
                <span>{requestDetail?.status ?? "n/a"}</span>
              </div>
              <div className="api-kv-row">
                <span>Provider</span>
                <span>{requestDetail?.provider ?? "n/a"}</span>
              </div>
              <div className="api-kv-row">
                <span>Model</span>
                <span>{requestDetail?.model ?? "n/a"}</span>
              </div>
            </div>

            {requestDetail?.outputAssets?.output?.url && requestDetail.outputAssets.output.contentType?.startsWith("image/") ? (
              <div className="api-output-tile">
                <div
                  role="button"
                  tabIndex={0}
                  className="api-output-preview-button"
                  onClick={() => setPreviewAsset(outputAsset)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setPreviewAsset(outputAsset);
                  }}
                  title="Open fullscreen preview"
                >
                  <img src={requestDetail.outputAssets.output.url} alt="API output" className="api-output-media" />
                </div>
                <a className="api-link" href={requestDetail.outputAssets.output.url} target="_blank" rel="noreferrer" download>
                  Open or download output
                </a>
              </div>
            ) : null}

            {requestDetail?.outputAssets?.output?.url && requestDetail.outputAssets.output.contentType?.startsWith("video/") ? (
              <div className="api-output-tile">
                <div
                  role="button"
                  tabIndex={0}
                  className="api-output-preview-button"
                  onClick={() => setPreviewAsset(outputAsset)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setPreviewAsset(outputAsset);
                  }}
                  title="Open fullscreen preview"
                >
                  <video src={requestDetail.outputAssets.output.url} controls className="api-output-media" />
                </div>
                <a className="api-link" href={requestDetail.outputAssets.output.url} target="_blank" rel="noreferrer" download>
                  Open or download output
                </a>
              </div>
            ) : null}

            {fullErrorMessage ? <div className="api-alert api-alert-error api-alert-block">{fullErrorMessage}</div> : null}

            <div className="api-log-panel">
              <div className="api-log-header">
                <h3>Processing Log</h3>
                <span>{logEntries.length ? `${logEntries.length} entries` : "Waiting for provider messages"}</span>
              </div>
              <div className="api-log-window" aria-live="polite">
                {logEntries.length ? (
                  logEntries.map((entry, index) => (
                    <div className={`api-log-entry ${entry.source === "error" ? "api-log-entry-error" : ""}`} key={`${entry.at ?? "log"}-${index}`}>
                      <span>{formatTimestamp(entry.at)}</span>
                      <strong>{entry.source}</strong>
                      <p>{entry.message}</p>
                    </div>
                  ))
                ) : (
                  <div className="api-log-empty">Submit a request to see upload, queue, provider and failure messages here.</div>
                )}
              </div>
            </div>

            <pre className="api-code">{formatJson(requestDetail ?? { note: "No request submitted yet." })}</pre>
          </div>
        </section>
      </div>

      {previewAsset ? (
        <div className="api-lightbox" role="dialog" aria-modal="true" aria-label={previewAsset.label} onClick={() => setPreviewAsset(null)}>
          <button type="button" className="api-lightbox-close" onClick={() => setPreviewAsset(null)}>
            Close
          </button>
          <div className="api-lightbox-frame" onClick={(event) => event.stopPropagation()}>
            {previewAsset.contentType?.startsWith("video/") ? (
              <video src={previewAsset.url} controls autoPlay className="api-lightbox-media" />
            ) : (
              <img src={previewAsset.url} alt={previewAsset.label} className="api-lightbox-media" />
            )}
            <a className="api-lightbox-link" href={previewAsset.url} target="_blank" rel="noreferrer" download>
              Open or download original asset
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

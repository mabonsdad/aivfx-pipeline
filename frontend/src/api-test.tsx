import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { apiTestCurrentUser, apiTestGetIdToken, apiTestLogin, apiTestLogout } from "./lib/apiTestAuth";
import { assertConfig, config } from "./lib/config";
import type { ApiRequestRecord } from "./types/api";
import "./api-test.css";

type Workflow = "image_full" | "image_masked" | "video_reference";

type UploadPreview = {
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
  label: string;
  mode: string;
  note?: string;
};

const IMAGE_FULL_MODELS = [
  { value: "nano_banana", label: "Nano Banana" },
  { value: "nano_banana_pro", label: "Nano Banana Pro" },
  { value: "chatgpt", label: "ChatGPT-image 1.5" },
  { value: "chatgpt_latest", label: "ChatGPT-image 2.0" },
] as const;

const IMAGE_MASKED_MODELS = [
  { value: "nano_banana_pro", label: "Nano Banana Pro" },
  { value: "chatgpt", label: "ChatGPT-image 1.5" },
  { value: "chatgpt_latest", label: "ChatGPT-image 2.0" },
  { value: "runware_flux_fill", label: "Runware Flux Fill" },
] as const;

const VIDEO_MODELS: readonly VideoModelOption[] = [
  { value: "ray-flash-2", label: "Luma Ray 2 Flash", mode: "flex_1" },
  { value: "ray-2", label: "Luma Ray 2", mode: "adhere_1" },
  { value: "runway-gen4.5", label: "Runway Gen-4.5", mode: "runway_i2v" },
  { value: "runway-gen4-aleph", label: "Runway Gen-4 Aleph", mode: "runway_aleph_v2v", note: "Uses source video plus a reference image. Prompt should describe the intended transformation while preserving timing and motion." },
  { value: "kling-2.6", label: "Kling 2.6", mode: "kling_start_only" },
  { value: "kling-o1", label: "Kling O1 Edit", mode: "kling_o1_video_edit", note: "Prompt should reference <<<video_1>>> and <<<image_1>>>." },
  { value: "kling-v3-omni-video", label: "Kling V3 Omni Video", mode: "kling_v3_omni_video_edit", note: "Prompt should reference <<<video_1>>> and <<<image_1>>>." },
  { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video", mode: "seedance_reference_to_video", note: "Prompt must reference @Video1 and @Image1." },
  { value: "veo-3.1-fast", label: "Veo 3.1 Fast", mode: "veo_start_only" },
  { value: "veo-3.1", label: "Veo 3.1", mode: "veo_start_only" },
  { value: "wan2.2-a14b", label: "Wan 2.2 A14B", mode: "wan_a14b_i2v" },
  { value: "wan2.2-animate", label: "Wan 2.2 Animate", mode: "wan_animate_replace" },
  { value: "wan2.7-videoedit", label: "Wan 2.7 VideoEdit", mode: "wan27_video_edit" },
] as const;

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

function App() {
  const [workflow, setWorkflow] = useState<Workflow>("image_full");
  const [prompt, setPrompt] = useState("");
  const [imageModel, setImageModel] = useState<string>("nano_banana_pro");
  const [maskedModel, setMaskedModel] = useState<string>("nano_banana_pro");
  const [videoModel, setVideoModel] = useState<string>("ray-flash-2");
  const [klingMode, setKlingMode] = useState<"std" | "pro">("pro");
  const [klingV3Mode, setKlingV3Mode] = useState<"standard" | "pro">("pro");
  const [wan27Resolution, setWan27Resolution] = useState<"720p" | "1080p">("720p");
  const [preserveFrames, setPreserveFrames] = useState(true);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<UploadPreview | null>(null);
  const [videoPreview, setVideoPreview] = useState<UploadPreview | null>(null);
  const [maskPreview, setMaskPreview] = useState<UploadPreview | null>(null);
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
  const outputAsset = requestDetail?.outputAssets?.output?.url
    ? {
        url: requestDetail.outputAssets.output.url,
        contentType: requestDetail.outputAssets.output.contentType,
        label: requestDetail.outputAssets.output.contentType?.startsWith("video/") ? "API video output" : "API image output",
      }
    : null;
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
      if (maskPreview) URL.revokeObjectURL(maskPreview.url);
    };
  }, [imagePreview, videoPreview, maskPreview]);

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
    setPreview({
      name: file.name,
      type: file.type,
      url: URL.createObjectURL(file),
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
    if (workflow === "video_reference" && (!imageFile || !videoFile)) {
      setError("Select both the edited first frame image and the source video.");
      return;
    }

    setIsSubmitting(true);
    setRequestId(null);
    setRequestDetail(null);

    try {
      if (workflow === "image_full") {
        setActivity("Uploading source image");
        const inputAssetKey = await uploadAsset(imageFile!, "image");
        setActivity("Submitting full image edit request");
        const created = await apiTestRequest<{ requestId: string; jobId: string }>("/api/v1/image-edits/full", {
          method: "POST",
          body: JSON.stringify({
            model: imageModel as "nano_banana" | "nano_banana_pro" | "chatgpt" | "chatgpt_latest",
            prompt: prompt.trim(),
            inputAssetKey,
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
        const dimensions = await readImageDimensions(imageFile!);
        setActivity("Submitting masked image edit request");
        const created = await apiTestRequest<{ requestId: string; jobId: string }>("/api/v1/image-edits/patch", {
          method: "POST",
          body: JSON.stringify({
            model: maskedModel as "nano_banana_pro" | "chatgpt" | "chatgpt_latest" | "runware_flux_fill",
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
          }),
        });
        setRequestId(created.requestId);
        setSuccessMessage(`Queued masked image edit: ${created.requestId}`);
        setActivity(`Queued masked image edit ${created.requestId}`);
      } else {
        setActivity("Uploading source video and first frame");
        const [videoAssetKey, firstFrameAssetKey] = await Promise.all([
          uploadAsset(videoFile!, "video"),
          uploadAsset(imageFile!, "image"),
        ]);
        setActivity("Submitting reference video generation request");
        const created = await apiTestRequest<{ requestId: string; jobId: string }>("/api/v1/video-generations/reference-video", {
          method: "POST",
          body: JSON.stringify({
            model: selectedVideoModel.value,
            mode: selectedVideoModel.mode,
            prompt: prompt.trim(),
            videoAssetKey,
            firstFrameAssetKey,
            replicateKlingMode: selectedVideoModel.value === "kling-o1" ? klingMode : undefined,
            replicateKlingV3Mode: selectedVideoModel.value === "kling-v3-omni-video" ? klingV3Mode : undefined,
            wan27Resolution: selectedVideoModel.value === "wan2.7-videoedit" ? wan27Resolution : undefined,
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
        <p className="api-test-subtitle">Use Cognito to sign-in, uploaded assets and create query to test and see the API schema/syntax being used.</p>
      </header>

      <div className="api-test-grid">
        <section className="api-card">
          <div className="api-card-inner api-section-stack">
            <div>
              <h2>Auth</h2>
              <p className="api-muted">
                Browser auth uses Cognito Hosted UI with PKCE. The callback for this page must be allowed in the Cognito app client.
              </p>
            </div>

            <div className="api-auth-row">
              <div className="api-preview-tile">
                <strong>Current user</strong>
                <span>{currentUserLabel}</span>
              </div>
              <div className="api-preview-tile">
                <strong>Callback URL</strong>
                <span>{window.location.href.split("#")[0]}</span>
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
              <p className="api-muted">Pick a simple workflow, upload the required media, and submit against the external API routes.</p>
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

            {workflow === "video_reference" && videoModel === "wan2.7-videoedit" ? (
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

              {workflow === "video_reference" ? (
                <div className="api-field">
                  <label htmlFor="videoFile">Source video</label>
                  <input
                    id="videoFile"
                    type="file"
                    accept="video/*"
                    onChange={(event) => updatePreview(event.target.files?.[0] ?? null, setVideoFile, videoPreview, setVideoPreview)}
                  />
                </div>
              ) : (
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
              )}
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

              {maskPreview ? (
                <div className="api-preview-tile">
                  <strong>{maskPreview.name}</strong>
                  <img src={maskPreview.url} alt={maskPreview.name} className="api-preview-media" />
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

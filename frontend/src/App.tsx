import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";

import { apiClient } from "./api/client";
import { currentUser, login, logout } from "./lib/auth";
import { useUiStore } from "./store/uiStore";
import type { FrameRecord, FrameVariant, SegmentGeneration, SegmentRecord, TaskDetail } from "./types/api";

type TabId = "timeline" | "frames" | "generate" | "merge" | "assets" | "report";

type NewTaskStage = "idle" | "creating" | "uploading" | "ingesting" | "error";

type LibraryAsset = {
  id: string;
  taskId: string;
  title: string;
  subtitle: string;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
  mediaType: "image" | "video";
  deletePayload:
    | { assetType: "upload" }
    | { assetType: "frame_capture"; frameId: string }
    | { assetType: "frame_variant"; frameId: string; variantId: string }
    | { assetType: "segment_generation"; genId: string }
    | { assetType: "export"; exportId: string };
};

type PatchEngine = "nano_banana_pro" | "runware_flux_fill" | "runware_ace_pp";

type PatchReferenceImage = {
  file: File;
  previewUrl: string;
  uploadedKey?: string;
  frameId?: string;
};

type ReportGenerationRow = {
  generation: SegmentGeneration;
  segment: SegmentRecord | null;
  startFrame: FrameRecord | null;
  endFrame: FrameRecord | null;
  startVariant: FrameVariant | null;
  endVariant: FrameVariant | null;
  originalUrl: string | null;
  maskUrl: string | null;
  editedUrl: string | null;
  endFrameUrl: string | null;
  generatedVideoUrl: string | null;
};

type EditFrameCandidate = {
  id: string;
  kind: "original" | "variant";
  imageUrl: string;
  label: string;
  createdAt?: string;
  variantId?: string;
  variant?: FrameVariant;
  isSelected: boolean;
};

function normalizeTaskNameInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 15);
}

function humanizeFilename(value: string): string {
  const withoutExt = value.replace(/\.[^/.]+$/, "");
  return withoutExt.replace(/[_-]+/g, " ").trim();
}

function keyBasenameFromS3Key(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function safeTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function truncateIdentifier(value: string, maxLength = 12): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function formatCompactTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown time";
  const asDate = new Date(iso);
  if (Number.isNaN(asDate.getTime())) return iso;
  return asDate.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function frameCount(task: TaskDetail | undefined): number {
  return task?.video?.editSource?.frameCount ?? 0;
}

function fpsValue(task: TaskDetail | undefined): number {
  const fps = task?.video?.editSource?.fps;
  if (!fps || !fps.den) return 30;
  return fps.num / fps.den;
}

function lumaModelMaxDurationSeconds(model: "ray-2" | "ray-flash-2" | "runway-aleph" | "kling-2.6"): number {
  if (model === "ray-2") return 10;
  if (model === "ray-flash-2") return 15;
  if (model === "kling-2.6") return 10;
  return 60;
}

function FrameSelectCard({
  title,
  frame,
  onSelect,
  onClear,
}: {
  title: string;
  frame: { frameId: string; frameIndex: number; timecode: string; imageUrl?: string } | null;
  onSelect: () => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <p className="mb-2 text-sm font-semibold">{title}</p>
      {frame?.imageUrl ? (
        <div className="relative">
          <img src={frame.imageUrl} alt={`${title} preview`} className="max-h-28 w-full rounded-md bg-bg object-contain" />
          <button
            onClick={onClear}
            className="absolute right-2 top-2 rounded bg-black/70 p-1 text-white"
            aria-label={`Remove ${title.toLowerCase()}`}
            title="Remove selected frame"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v9h-2V9Zm4 0h2v9h-2V9ZM7 9h2v9H7V9Z" />
            </svg>
          </button>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-ink/70">
              frame {frame.frameIndex} ({frame.timecode})
            </p>
            <a
              href={frame.imageUrl}
              target="_blank"
              rel="noreferrer"
              download
              className="rounded border border-ink/20 bg-white px-2 py-1 text-xs"
              title="Download full quality frame"
            >
              Download
            </a>
          </div>
        </div>
      ) : (
        <button onClick={onSelect} className="w-full rounded-md border border-ink/20 bg-bg px-3 py-4 text-left">
          <span className="block text-sm font-medium">Select</span>
          <span className="text-xs text-ink/60">from current video frame</span>
        </button>
      )}
    </div>
  );
}

function VideoThumbnail({
  videoUrl,
  label,
  onClick,
  disabled,
}: {
  videoUrl?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl(null);
    if (!videoUrl) return;

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = videoUrl;

    const capture = () => {
      if (cancelled) return;
      if (!video.videoWidth || !video.videoHeight) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        setThumbnailUrl(canvas.toDataURL("image/jpeg", 0.86));
      } catch {
        setThumbnailUrl(null);
      }
    };

    const handleLoadedData = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        capture();
        return;
      }
      const previewTime = Math.min(1, Math.max(0, video.duration / 3));
      if (previewTime <= 0) {
        capture();
        return;
      }
      video.currentTime = previewTime;
    };

    const handleSeeked = () => capture();
    const handleError = () => {
      if (!cancelled) setThumbnailUrl(null);
    };

    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);
    video.load();

    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      video.pause();
      video.src = "";
    };
  }, [videoUrl]);

  return (
    <button
      type="button"
      className="block w-full disabled:cursor-not-allowed disabled:opacity-60"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Video unavailable" : `Use ${label}`}
    >
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt={label} className="aspect-video w-full rounded-md bg-bg object-contain" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
          Video thumbnail unavailable
        </div>
      )}
    </button>
  );
}

function uploadFileWithProgress(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("content-type", contentType);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed due to network error"));
    xhr.send(file);
  });
}

export default function App() {
  const queryClient = useQueryClient();
  const {
    selectedTaskId,
    currentFrameIndex,
    selectedFrameId,
    selectedSegmentId,
    setSelectedTaskId,
    setCurrentFrameIndex,
    setSelectedFrameId,
    setSelectedSegmentId,
  } = useUiStore();

  const [isAuthed, setIsAuthed] = useState(false);
  const [tab, setTab] = useState<TabId>("timeline");
  const [reportTaskId, setReportTaskId] = useState<string | null>(null);
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("New VFX Task");
  const [newTaskFile, setNewTaskFile] = useState<File | null>(null);
  const [newTaskStage, setNewTaskStage] = useState<NewTaskStage>("idle");
  const [newTaskError, setNewTaskError] = useState<string | null>(null);
  const [newTaskUploadPercent, setNewTaskUploadPercent] = useState(0);
  const [pendingCreateJobId, setPendingCreateJobId] = useState<string | null>(null);
  const [uploadAssetsVisible, setUploadAssetsVisible] = useState(6);
  const [frameAssetsVisible, setFrameAssetsVisible] = useState(6);
  const [videoAssetsVisible, setVideoAssetsVisible] = useState(6);
  const [jobsVisible, setJobsVisible] = useState(6);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<"nano_banana" | "nano_banana_pro">("nano_banana_pro");
  const [patchPrompt, setPatchPrompt] = useState("");
  const [patchEngine, setPatchEngine] = useState<PatchEngine>("nano_banana_pro");
  const [runwareRepaintingScale, setRunwareRepaintingScale] = useState(0.7);
  const [patchReferenceImages, setPatchReferenceImages] = useState<{ first: PatchReferenceImage | null; last: PatchReferenceImage | null }>({
    first: null,
    last: null,
  });
  const [patchBrushSize, setPatchBrushSize] = useState(24);
  const [featherPx, setFeatherPx] = useState(24);
  const [maskHasPaint, setMaskHasPaint] = useState(false);
  const [lumaModel, setLumaModel] = useState<"ray-2" | "ray-flash-2" | "runway-aleph" | "kling-2.6">("ray-flash-2");
  const [advancedMode, setAdvancedMode] = useState("flex_1");
  const [lumaPrompt, setLumaPrompt] = useState("");
  const [firstFrameVariantId, setFirstFrameVariantId] = useState("");
  const [editSourceVariantIds, setEditSourceVariantIds] = useState<{ first: string | null; last: string | null }>({
    first: null,
    last: null,
  });
  const [selectedGenIds, setSelectedGenIds] = useState<string[]>([]);
  const [selectedPreviewGenId, setSelectedPreviewGenId] = useState<string>("");
  const [temporalFeatherFrames, setTemporalFeatherFrames] = useState(0);
  const [imagePreviewModal, setImagePreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [videoPreviewModal, setVideoPreviewModal] = useState<{ url: string; label: string } | null>(null);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [firstFrameId, setFirstFrameId] = useState<string | null>(null);
  const [lastFrameId, setLastFrameId] = useState<string | null>(null);
  const [editFrameTab, setEditFrameTab] = useState<"first" | "last">("first");
  const timelineVideoRef = useRef<HTMLVideoElement | null>(null);
  const compareOriginalRef = useRef<HTMLVideoElement | null>(null);
  const compareVariantRef = useRef<HTMLVideoElement | null>(null);
  const syncLockRef = useRef(false);
  const patchOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchDrawStateRef = useRef<{ drawing: boolean; x: number; y: number } | null>(null);

  useEffect(() => {
    currentUser().then((user) => setIsAuthed(!!user));
  }, []);

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: async () => (await apiClient.listTasks()).tasks,
    enabled: isAuthed,
  });
  const normalizedNewTaskName = useMemo(() => normalizeTaskNameInput(newTaskName), [newTaskName]);
  const taskNameAlreadyExists = useMemo(() => {
    const target = normalizedNewTaskName.toLowerCase();
    if (!target) return false;
    return (tasksQuery.data ?? []).some((taskItem) => taskItem.name.toLowerCase() === target);
  }, [normalizedNewTaskName, tasksQuery.data]);
  const showTaskNameExistsWarning =
    taskNameAlreadyExists &&
    newTaskStage !== "creating" &&
    newTaskStage !== "uploading" &&
    newTaskStage !== "ingesting";

  useEffect(() => {
    if (!selectedTaskId && tasksQuery.data?.length) {
      setSelectedTaskId(tasksQuery.data[0].taskId);
    }
  }, [selectedTaskId, setSelectedTaskId, tasksQuery.data]);

  const taskQuery = useQuery({
    queryKey: ["task", selectedTaskId],
    queryFn: async () => apiClient.getTask(selectedTaskId as string),
    enabled: isAuthed && !!selectedTaskId,
    refetchInterval: tab === "generate" ? 4 * 60 * 1000 : false,
  });
  const reportTaskQuery = useQuery({
    queryKey: ["task", "report", reportTaskId],
    queryFn: async () => apiClient.getTask(reportTaskId as string),
    enabled: isAuthed && tab === "report" && !!reportTaskId,
  });
  const pendingCreateJobQuery = useQuery({
    queryKey: ["job", pendingCreateJobId],
    queryFn: () => apiClient.getJob(pendingCreateJobId as string),
    enabled: isAuthed && !!pendingCreateJobId,
    refetchInterval: (q: { state: { data?: { status?: string } } }) => {
      const status = q?.state?.data?.status;
      return status === "queued" || status === "running" ? 2000 : false;
    },
  });
  const assetTaskQueries = useQueries({
    queries: (tasksQuery.data ?? []).map((taskItem) => ({
      queryKey: ["task", "assets", taskItem.taskId],
      queryFn: () => apiClient.getTask(taskItem.taskId),
      enabled: isAuthed && tab === "assets",
      refetchOnWindowFocus: false as const,
    })),
  });

  const task = taskQuery.data;
  const reportTask = reportTaskQuery.data;
  const assetTasks = useMemo(
    () => assetTaskQueries.map((query) => query.data).filter((item): item is TaskDetail => Boolean(item)),
    [assetTaskQueries],
  );
  const orderedSegments = useMemo(() => [...(task?.segments ?? [])].reverse(), [task?.segments]);
  const segmentsById = useMemo(
    () => new Map((task?.segments ?? []).map((segment) => [segment.segmentId, segment])),
    [task?.segments],
  );
  const reportSegmentsById = useMemo(
    () => new Map((reportTask?.segments ?? []).map((segment) => [segment.segmentId, segment])),
    [reportTask?.segments],
  );
  const assetsLoading = tab === "assets" && assetTaskQueries.some((query) => query.isPending || query.isFetching) && assetTasks.length === 0;
  const selectedSegment = task?.segments.find((s) => s.segmentId === selectedSegmentId) ?? null;
  const firstFrame = task && firstFrameId ? task.frames[firstFrameId] ?? null : null;
  const lastFrame = task && lastFrameId ? task.frames[lastFrameId] ?? null : null;
  const editFirstFrame = (firstFrameId ? task?.frames[firstFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.startFrameId] : null) ?? null;
  const editLastFrame = (lastFrameId ? task?.frames[lastFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.endFrameId] : null) ?? null;
  const activeEditFrame = editFrameTab === "first" ? editFirstFrame : editLastFrame;
  const activeEditVariants = useMemo(
    () =>
      [...(activeEditFrame?.variants ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [activeEditFrame?.variants],
  );
  const activeEditSourceVariantId = editSourceVariantIds[editFrameTab];
  const activeSelectedVariant = useMemo(
    () =>
      activeEditSourceVariantId
        ? activeEditVariants.find((variant) => variant.variantId === activeEditSourceVariantId) ?? null
        : null,
    [activeEditSourceVariantId, activeEditVariants],
  );
  const activeEditSourceImageUrl = activeSelectedVariant?.imageUrl ?? activeEditFrame?.imageUrl ?? null;
  const activeEditCandidates = useMemo<EditFrameCandidate[]>(() => {
    if (!activeEditFrame?.imageUrl) return [];
    const candidates: EditFrameCandidate[] = [
      {
        id: `${activeEditFrame.frameId}:original`,
        kind: "original",
        imageUrl: activeEditFrame.imageUrl,
        label: "Original frame",
        createdAt: activeEditFrame.createdAt,
        isSelected: !activeEditSourceVariantId,
      },
    ];
    for (const variant of activeEditVariants) {
      if (!variant.imageUrl) continue;
      candidates.push({
        id: variant.variantId,
        kind: "variant",
        imageUrl: variant.imageUrl,
        label: `${variant.model} / ${variant.type}`,
        createdAt: variant.createdAt,
        variantId: variant.variantId,
        variant,
        isSelected: activeEditSourceVariantId === variant.variantId,
      });
    }
    return candidates;
  }, [activeEditFrame, activeEditSourceVariantId, activeEditVariants]);
  const activeFrameDimensions = useMemo(() => {
    const width = task?.video?.editSource?.width;
    const height = task?.video?.editSource?.height;
    if (!activeEditFrame || !width || !height) return null;
    return { width, height };
  }, [activeEditFrame, task?.video?.editSource?.height, task?.video?.editSource?.width]);
  const activeFrameWidth = activeFrameDimensions?.width ?? null;
  const activeFrameHeight = activeFrameDimensions?.height ?? null;
  const activePatchReference = patchReferenceImages[editFrameTab];
  const reportRows = useMemo(() => {
    if (!reportTask) {
      return { standard: [] as ReportGenerationRow[], kling: [] as ReportGenerationRow[] };
    }
    const frameById = reportTask.frames ?? {};
    const allRows: ReportGenerationRow[] = Object.values(reportTask.segmentGenerations ?? {}).map((generation) => {
      const segment = reportSegmentsById.get(generation.segmentId) ?? null;
      const startFrame = segment ? frameById[segment.startFrameId] ?? null : null;
      const endFrame = segment ? frameById[segment.endFrameId] ?? null : null;
      const startVariantId = generation.sourceFirstFrameVariantId ?? startFrame?.selectedVariantId ?? null;
      const endVariantId = generation.sourceLastFrameVariantId ?? endFrame?.selectedVariantId ?? null;
      const startVariant = startVariantId ? startFrame?.variants.find((variant) => variant.variantId === startVariantId) ?? null : null;
      const endVariant = endVariantId ? endFrame?.variants.find((variant) => variant.variantId === endVariantId) ?? null : null;
      return {
        generation,
        segment,
        startFrame,
        endFrame,
        startVariant,
        endVariant,
        originalUrl: startFrame?.imageUrl ?? generation.sourceFirstFrameCaptureUrl ?? null,
        maskUrl: (startVariant?.patchMeta?.maskUrl as string | undefined) ?? null,
        editedUrl: startVariant?.imageUrl ?? generation.inputFirstFrameUrl ?? null,
        endFrameUrl: endVariant?.imageUrl ?? generation.inputLastFrameUrl ?? endFrame?.imageUrl ?? null,
        generatedVideoUrl: generation.downloadUrl ?? null,
      };
    });
    const sortScore = (row: ReportGenerationRow) => (row.generatedVideoUrl ? 0 : 1);
    allRows.sort((a, b) => sortScore(a) - sortScore(b) || safeTimestamp(b.generation.createdAt) - safeTimestamp(a.generation.createdAt));
    return {
      standard: allRows.filter((row) => row.generation.luma.model !== "kling-2.6"),
      kling: allRows.filter((row) => row.generation.luma.model === "kling-2.6"),
    };
  }, [reportSegmentsById, reportTask]);

  useEffect(() => {
    setFirstFrameId(null);
    setLastFrameId(null);
    setEditSourceVariantIds({ first: null, last: null });
    setPatchReferenceImages((previous) => {
      for (const item of [previous.first, previous.last]) {
        if (item?.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return { first: null, last: null };
    });
  }, [selectedTaskId]);

  useEffect(() => {
    setEditSourceVariantIds((previous) => {
      let changed = false;
      const next = { ...previous };
      if (previous.first && !editFirstFrame?.variants.some((variant) => variant.variantId === previous.first)) {
        next.first = null;
        changed = true;
      }
      if (previous.last && !editLastFrame?.variants.some((variant) => variant.variantId === previous.last)) {
        next.last = null;
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [editFirstFrame?.frameId, editFirstFrame?.variants, editLastFrame?.frameId, editLastFrame?.variants]);

  useEffect(() => {
    return () => {
      for (const item of [patchReferenceImages.first, patchReferenceImages.last]) {
        if (item?.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
    };
  }, [patchReferenceImages.first, patchReferenceImages.last]);

  useEffect(() => {
    if (firstFrameId && !task?.frames[firstFrameId]) setFirstFrameId(null);
    if (lastFrameId && !task?.frames[lastFrameId]) setLastFrameId(null);
  }, [firstFrameId, lastFrameId, task]);

  useEffect(() => {
    if (tab === "generate" && selectedTaskId) {
      queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    }
  }, [queryClient, selectedTaskId, tab]);

  useEffect(() => {
    if (tab === "assets") {
      setUploadAssetsVisible(6);
      setFrameAssetsVisible(6);
      setVideoAssetsVisible(6);
    }
  }, [tab]);

  useEffect(() => {
    if (!activeFrameWidth || !activeFrameHeight) {
      setMaskHasPaint(false);
      patchDrawStateRef.current = null;
      return;
    }
    const width = activeFrameWidth;
    const height = activeFrameHeight;
    const maskCanvas = patchMaskCanvasRef.current ?? document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext("2d");
    if (maskCtx) {
      maskCtx.fillStyle = "black";
      maskCtx.fillRect(0, 0, width, height);
    }
    patchMaskCanvasRef.current = maskCanvas;
    const overlay = patchOverlayCanvasRef.current;
    if (overlay) {
      overlay.width = width;
      overlay.height = height;
      const overlayCtx = overlay.getContext("2d");
      overlayCtx?.clearRect(0, 0, width, height);
    }
    patchDrawStateRef.current = null;
    setMaskHasPaint(false);
  }, [activeEditFrame?.frameId, activeFrameWidth, activeFrameHeight]);

  useEffect(() => {
    const status = pendingCreateJobQuery.data?.status;
    if (newTaskStage !== "ingesting" || !status) return;
    if (status === "complete") {
      setNewTaskStage("idle");
      setPendingCreateJobId(null);
      setNewTaskError(null);
      setIsNewTaskModalOpen(false);
      setTab("timeline");
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (selectedTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      }
      return;
    }
    if (status === "failed") {
      setNewTaskStage("error");
      setNewTaskError(pendingCreateJobQuery.data?.error || "Ingest failed");
      setPendingCreateJobId(null);
    }
  }, [newTaskStage, pendingCreateJobQuery.data, queryClient, selectedTaskId]);

  useEffect(() => {
    const frameId = activeEditFrame?.frameId ?? null;
    if (frameId && frameId !== selectedFrameId) {
      setSelectedFrameId(frameId);
    }
  }, [activeEditFrame?.frameId, selectedFrameId, setSelectedFrameId]);

  useEffect(() => {
    const maxFrame = Math.max(0, frameCount(task) - 1);
    if (currentFrameIndex > maxFrame) setCurrentFrameIndex(maxFrame);
  }, [currentFrameIndex, setCurrentFrameIndex, task]);

  useEffect(() => {
    if (!task?.video?.editSource) return;
    const videoEl = timelineVideoRef.current;
    if (!videoEl) return;
    const fps = fpsValue(task);
    const targetSeconds = currentFrameIndex / fps;
    if (Math.abs(videoEl.currentTime - targetSeconds) > 0.06) {
      videoEl.currentTime = targetSeconds;
    }
  }, [currentFrameIndex, task]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!task?.video?.editSource) return;
      if (ev.key === "ArrowRight") {
        setCurrentFrameIndex(Math.min(frameCount(task) - 1, currentFrameIndex + 1));
      } else if (ev.key === "ArrowLeft") {
        setCurrentFrameIndex(Math.max(0, currentFrameIndex - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentFrameIndex, setCurrentFrameIndex, task]);

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => apiClient.deleteTask(taskId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setSelectedTaskId(null);
    },
  });
  const deleteAssetMutation = useMutation({
    mutationFn: async ({
      taskId,
      payload,
    }: {
      taskId: string;
      payload: {
        assetType: "upload" | "frame_capture" | "frame_variant" | "segment_generation" | "export";
        frameId?: string;
        variantId?: string;
        genId?: string;
        exportId?: string;
      };
    }) => apiClient.deleteAsset(taskId, payload),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["task", "assets", variables.taskId] });
    },
  });

  const captureMutation = useMutation({
    mutationFn: async ({ frameIndex }: { frameIndex: number }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.captureFrame(selectedTaskId, frameIndex);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const createSegmentMutation = useMutation({
    mutationFn: async ({ startFrameIndex, endFrameExclusive }: { startFrameIndex: number; endFrameExclusive: number }) => {
      if (!selectedTaskId) throw new Error("Select task");
      const totalFrames = frameCount(task);
      if (totalFrames > 0 && (startFrameIndex < 0 || endFrameExclusive > totalFrames || endFrameExclusive <= startFrameIndex)) {
        throw new Error("Invalid frame range for segment");
      }
      const fps = fpsValue(task);
      const durationFrames = Math.max(1, endFrameExclusive - startFrameIndex);
      const durationSeconds = Math.max(1, Math.ceil(durationFrames / fps));
      const created = await apiClient.createSegment(selectedTaskId, {
        startFrameIndex,
        durationSeconds,
      });
      await apiClient.patchSegment(selectedTaskId, created.segmentId, {
        startFrameIndex,
        endFrameExclusive,
      });
      return created;
    },
    onSuccess: async (result) => {
      setSelectedSegmentId(result.segmentId);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const fullEditMutation = useMutation({
    mutationFn: async (frameId: string) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.fullEdit(selectedTaskId, frameId, {
        model,
        prompt,
        sourceVariantId: activeEditSourceVariantId ?? "original",
      });
    },
    onSuccess: (result) => setJobIds((prev) => Array.from(new Set([...prev, result.jobId]))),
  });

  const patchEditMutation = useMutation({
    mutationFn: async (frameId: string) => {
      if (!selectedTaskId) throw new Error("Select a task");
      if (!activeFrameDimensions) throw new Error("Frame dimensions unavailable");
      if (!maskHasPaint) throw new Error("Draw a mask before generating a patch variant");
      const patchRect = {
        x: 0,
        y: 0,
        width: activeFrameDimensions.width,
        height: activeFrameDimensions.height,
      };
      const init = await apiClient.patchInit(selectedTaskId, frameId, {
        patchRect,
        featherPx,
        bleedPx: 0,
        hasMask: true,
        sourceVariantId: activeEditSourceVariantId ?? "original",
      });
      if (!init.maskUploadUrl || !init.maskKey) {
        throw new Error("Mask upload URL missing");
      }
      const maskBlob = await new Promise<Blob>((resolve, reject) => {
        const canvas = patchMaskCanvasRef.current;
        if (!canvas) {
          reject(new Error("Mask canvas unavailable"));
          return;
        }
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Failed to export mask"));
            return;
          }
          resolve(blob);
        }, "image/png");
      });
      await fetch(init.maskUploadUrl, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: maskBlob,
      });

      let referenceImageKey: string | undefined;
      if (patchEngine === "runware_ace_pp") {
        const reference = activePatchReference;
        if (!reference?.file) {
          throw new Error("Runware ACE++ requires one reference image");
        }
        if (reference.uploadedKey && reference.frameId === frameId) {
          referenceImageKey = reference.uploadedKey;
        } else {
          const uploadResp = await apiClient.createReferenceUploads(selectedTaskId, frameId, {
            files: [{ filename: reference.file.name, contentType: reference.file.type || "image/png" }],
          });
          const upload = uploadResp.uploads[0];
          if (!upload) {
            throw new Error("Reference upload URL missing");
          }
          const uploadResult = await fetch(upload.uploadUrl, {
            method: "PUT",
            headers: { "content-type": reference.file.type || "image/png" },
            body: reference.file,
          });
          if (!uploadResult.ok) {
            throw new Error(`Reference upload failed (${uploadResult.status})`);
          }
          referenceImageKey = upload.key;
          setPatchReferenceImages((previous) => {
            const existing = previous[editFrameTab];
            if (!existing) return previous;
            return {
              ...previous,
              [editFrameTab]: {
                ...existing,
                uploadedKey: upload.key,
                frameId,
              },
            };
          });
        }
      }

      return apiClient.patchSubmit(selectedTaskId, frameId, {
        model: patchEngine,
        prompt: patchPrompt,
        patchKey: init.patchKey,
        maskKey: init.maskKey,
        patchRect,
        featherPx,
        bleedPx: 0,
        referenceImageKey,
        runwareRepaintingScale: patchEngine === "runware_ace_pp" ? runwareRepaintingScale : undefined,
        sourceVariantId: activeEditSourceVariantId ?? "original",
      });
    },
    onSuccess: (result) => setJobIds((prev) => Array.from(new Set([...prev, result.jobId]))),
  });

  const selectVariantMutation = useMutation({
    mutationFn: async ({ frameId, variantId }: { frameId: string; variantId: string }) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.selectVariant(selectedTaskId, frameId, variantId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const generateSegmentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !selectedSegmentId) throw new Error("Select a segment");
      return apiClient.generateSegment(selectedTaskId, selectedSegmentId, {
        lumaModel,
        mode: lumaModel === "runway-aleph" ? "aleph_default" : lumaModel === "kling-2.6" ? "kling_start_end" : advancedMode,
        prompt: lumaPrompt.trim() || undefined,
        firstFrameVariantId: firstFrameVariantId || undefined,
      });
    },
    onSuccess: (result) => {
      setJobIds((prev) => Array.from(new Set([...prev, result.jobId])));
      setTab("generate");
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.merge(selectedTaskId, {
        selectedSegmentGenerationIds: selectedGenIds,
        temporalFeatherFrames,
      });
    },
    onSuccess: (result) => {
      setJobIds((prev) => Array.from(new Set([...prev, result.jobId])));
      setTab("merge");
    },
  });

  const jobQueries = useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: ["job", jobId],
      queryFn: () => apiClient.getJob(jobId),
      refetchInterval: (q: { state: { data?: { status?: string } } }) => {
        const status = q?.state?.data?.status;
        return status === "queued" || status === "running" ? 3000 : false;
      },
    })),
  });

  const seenDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const jq of jobQueries) {
      const data = jq.data;
      if (!data) continue;
      if ((data.status === "complete" || data.status === "failed") && !seenDoneRef.current.has(data.jobId)) {
        seenDoneRef.current.add(data.jobId);
        queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      }
    }
  }, [jobQueries, queryClient, selectedTaskId]);
  const sortedJobs = useMemo(
    () =>
      jobQueries
        .map((query) => query.data)
        .filter((job): job is NonNullable<typeof job> => Boolean(job))
        .sort(
          (a, b) =>
            new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
            new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
        ),
    [jobQueries],
  );

  const segmentGenerations = useMemo(
    () =>
      Object.values(task?.segmentGenerations ?? {}).sort(
        (a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt),
      ),
    [task?.segmentGenerations],
  );
  const selectedSegmentGenerations = useMemo(
    () =>
      segmentGenerations
        .filter((gen) => !selectedSegmentId || gen.segmentId === selectedSegmentId)
        .sort((a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt)),
    [segmentGenerations, selectedSegmentId],
  );
  const selectedStartFrameVariants = useMemo(
    () =>
      selectedSegment && task
        ? [...(task.frames[selectedSegment.startFrameId]?.variants ?? [])].sort(
            (a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt),
          )
        : [],
    [selectedSegment, task],
  );
  const mergeGenerationOptions = useMemo(() => [...segmentGenerations], [segmentGenerations]);
  const selectedMergeGenerations = useMemo(
    () =>
      selectedGenIds
        .map((genId) => task?.segmentGenerations?.[genId])
        .filter((generation): generation is SegmentGeneration => Boolean(generation))
        .sort((a, b) => safeTimestamp(b.createdAt) - safeTimestamp(a.createdAt)),
    [selectedGenIds, task?.segmentGenerations],
  );
  const selectedPreviewGeneration =
    selectedSegmentGenerations.find((gen) => gen.genId === selectedPreviewGenId) ?? selectedSegmentGenerations[0] ?? null;
  const sortedExports = useMemo(
    () => [...(task?.exports ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [task?.exports],
  );
  const lumaHardLimitSeconds = lumaModelMaxDurationSeconds(lumaModel);
  const hasHardDurationLimit = lumaModel === "ray-2" || lumaModel === "ray-flash-2" || lumaModel === "kling-2.6";
  const lumaHardLimitFrames = Math.round(lumaHardLimitSeconds * fpsValue(task));
  const timelineDelta = useMemo(() => {
    const fps = fpsValue(task);
    const anchorA = firstFrame?.frameIndex ?? lastFrame?.frameIndex ?? null;
    const anchorB = firstFrame?.frameIndex != null && lastFrame?.frameIndex != null ? lastFrame.frameIndex : currentFrameIndex;
    if (anchorA == null) {
      return { frames: 0, seconds: 0, overLimit: false };
    }
    const frames = Math.abs(anchorB - anchorA);
    const seconds = frames / fps;
    return { frames, seconds, overLimit: hasHardDurationLimit && seconds > lumaHardLimitSeconds };
  }, [currentFrameIndex, firstFrame, hasHardDurationLimit, lastFrame, lumaHardLimitSeconds, task]);

  const selectedRange = useMemo(() => {
    if (!firstFrame || !lastFrame) return null;
    const fps = fpsValue(task);
    const start = Math.min(firstFrame.frameIndex, lastFrame.frameIndex);
    const end = Math.max(firstFrame.frameIndex, lastFrame.frameIndex);
    const durationFrames = end - start + 1;
    const durationSec = durationFrames / fps;
    return {
      startFrame: start,
      endFrameInclusive: end,
      endFrameExclusive: end + 1,
      durationFrames,
      durationSec,
      overLimit: hasHardDurationLimit && durationSec > lumaHardLimitSeconds,
    };
  }, [firstFrame, hasHardDurationLimit, lastFrame, lumaHardLimitSeconds, task]);

  const selectedSegmentOverLimit = useMemo(() => {
    if (!selectedSegment || !hasHardDurationLimit) return false;
    return selectedSegment.durationSec > lumaHardLimitSeconds + 1e-6;
  }, [hasHardDurationLimit, lumaHardLimitSeconds, selectedSegment]);

  const uploadAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      const original = taskItem.video?.original;
      if (!original?.downloadUrl) continue;
      assets.push({
        id: `upload:${taskItem.taskId}`,
        taskId: taskItem.taskId,
        title: humanizeFilename(keyBasenameFromS3Key(original.s3Key || original.filename || "orig.mp4")),
        subtitle: taskItem.name,
        createdAt: taskItem.createdAt,
        previewUrl: original.downloadUrl,
        downloadUrl: original.downloadUrl,
        mediaType: "video",
        deletePayload: { assetType: "upload" },
      });
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks]);

  const frameAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      for (const frame of Object.values(taskItem.frames ?? {})) {
        if (frame.imageUrl) {
          assets.push({
            id: `capture:${taskItem.taskId}:${frame.frameId}`,
            taskId: taskItem.taskId,
            title: humanizeFilename(keyBasenameFromS3Key(frame.captureKey)),
            subtitle: `${taskItem.name} · ${frame.timecode}`,
            createdAt: frame.createdAt ?? taskItem.updatedAt,
            previewUrl: frame.imageUrl,
            downloadUrl: frame.imageUrl,
            mediaType: "image",
            deletePayload: { assetType: "frame_capture", frameId: frame.frameId },
          });
        }
        for (const variant of frame.variants ?? []) {
          if (!variant.imageUrl) continue;
          assets.push({
            id: `variant:${taskItem.taskId}:${frame.frameId}:${variant.variantId}`,
            taskId: taskItem.taskId,
            title: humanizeFilename(keyBasenameFromS3Key(variant.outputKey)),
            subtitle: `${taskItem.name} · frame ${frame.frameIndex} · ${variant.model}/${variant.type}`,
            createdAt: variant.createdAt,
            previewUrl: variant.imageUrl,
            downloadUrl: variant.imageUrl,
            mediaType: "image",
            deletePayload: { assetType: "frame_variant", frameId: frame.frameId, variantId: variant.variantId },
          });
        }
      }
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks]);

  const outputVideoAssets = useMemo<LibraryAsset[]>(() => {
    const assets: LibraryAsset[] = [];
    for (const taskItem of assetTasks) {
      for (const generation of Object.values(taskItem.segmentGenerations ?? {})) {
        if (!generation.downloadUrl) continue;
        assets.push({
          id: `generation:${taskItem.taskId}:${generation.genId}`,
          taskId: taskItem.taskId,
          title: humanizeFilename(keyBasenameFromS3Key(generation.outputKey || `${generation.genId}.mp4`)),
          subtitle: `${taskItem.name} · ${generation.luma.model} · ${generation.luma.mode}`,
          createdAt: generation.createdAt,
          previewUrl: generation.downloadUrl,
          downloadUrl: generation.downloadUrl,
          mediaType: "video",
          deletePayload: { assetType: "segment_generation", genId: generation.genId },
        });
      }
      for (const exportItem of taskItem.exports ?? []) {
        if (!exportItem.downloadUrl) continue;
        assets.push({
          id: `export:${taskItem.taskId}:${exportItem.exportId}`,
          taskId: taskItem.taskId,
          title: humanizeFilename(keyBasenameFromS3Key(exportItem.outputKey || `${exportItem.exportId}.mp4`)),
          subtitle: taskItem.name,
          createdAt: exportItem.createdAt,
          previewUrl: exportItem.downloadUrl,
          downloadUrl: exportItem.downloadUrl,
          mediaType: "video",
          deletePayload: { assetType: "export", exportId: exportItem.exportId },
        });
      }
    }
    return assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [assetTasks]);

  const segmentWindow = useMemo(() => {
    if (!selectedSegment || !task) return null;
    const fps = fpsValue(task);
    const startSec = selectedSegment.startFrame / fps;
    const endSec = selectedSegment.endFrameExclusive / fps;
    return {
      startSec,
      endSec,
      startLabel: startSec.toFixed(2),
      endLabel: endSec.toFixed(2),
    };
  }, [selectedSegment, task]);

  const originalSegmentPreviewUrl = useMemo(() => {
    if (!task?.video?.editSource?.downloadUrl || !segmentWindow) return null;
    return `${task.video.editSource.downloadUrl}#t=${segmentWindow.startSec},${segmentWindow.endSec}`;
  }, [segmentWindow, task?.video?.editSource?.downloadUrl]);
  const timelinePlaybackUrl = task?.video?.previewSource?.downloadUrl ?? task?.video?.editSource?.downloadUrl ?? "";

  useEffect(() => {
    setSelectedGenIds((previous) => {
      const filtered = previous.filter((genId) => Boolean(task?.segmentGenerations?.[genId]));
      return filtered.length === previous.length ? previous : filtered;
    });
  }, [task?.segmentGenerations]);

  useEffect(() => {
    if (!selectedSegmentGenerations.length) {
      setSelectedPreviewGenId("");
      return;
    }
    const stillValid = selectedSegmentGenerations.some((gen) => gen.genId === selectedPreviewGenId);
    if (!stillValid) {
      setSelectedPreviewGenId(selectedSegmentGenerations[0].genId);
    }
  }, [selectedPreviewGenId, selectedSegmentGenerations]);

  useEffect(() => {
    const selectedId = selectedPreviewGeneration?.genId;
    if (!selectedId) return;
    setSelectedGenIds((previous) => {
      const selectedGeneration = task?.segmentGenerations?.[selectedId];
      const targetSegmentId = selectedGeneration?.segmentId;
      const filtered = previous.filter((genId) => {
        if (genId === selectedId) return false;
        if (!targetSegmentId) return true;
        const existing = task?.segmentGenerations?.[genId];
        return existing?.segmentId !== targetSegmentId;
      });
      return [selectedId, ...filtered];
    });
  }, [selectedPreviewGeneration?.genId, task?.segmentGenerations]);

  function selectSegmentGeneration(genId: string) {
    setSelectedPreviewGenId(genId);
    setSelectedGenIds((previous) => {
      const selectedGeneration = task?.segmentGenerations?.[genId];
      const targetSegmentId = selectedGeneration?.segmentId;
      const filtered = previous.filter((existingGenId) => {
        if (existingGenId === genId) return false;
        if (!targetSegmentId) return true;
        const existing = task?.segmentGenerations?.[existingGenId];
        return existing?.segmentId !== targetSegmentId;
      });
      return [genId, ...filtered];
    });
  }

  function syncOriginalToGenerated(generatedVideo: HTMLVideoElement) {
    const originalVideo = compareOriginalRef.current;
    if (!originalVideo || !segmentWindow) return;
    const targetTime = segmentWindow.startSec + generatedVideo.currentTime;
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    if (Math.abs(originalVideo.currentTime - targetTime) > 0.05) {
      originalVideo.currentTime = targetTime;
    }
    window.setTimeout(() => {
      syncLockRef.current = false;
    }, 0);
  }

  function keepOriginalWithinSegment(video: HTMLVideoElement) {
    if (!segmentWindow) return;
    if (video.currentTime < segmentWindow.startSec) {
      video.currentTime = segmentWindow.startSec;
    }
    if (video.currentTime >= segmentWindow.endSec) {
      video.currentTime = segmentWindow.startSec;
    }
  }

  function mapPointerToMaskCoordinates(event: PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) {
    const maskCanvas = patchMaskCanvasRef.current;
    if (!maskCanvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((event.clientX - rect.left) / rect.width) * maskCanvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * maskCanvas.height;
    return {
      x: Math.max(0, Math.min(maskCanvas.width - 1, x)),
      y: Math.max(0, Math.min(maskCanvas.height - 1, y)),
    };
  }

  function paintMaskStroke(x: number, y: number, prev: { x: number; y: number } | null) {
    const maskCanvas = patchMaskCanvasRef.current;
    const overlayCanvas = patchOverlayCanvasRef.current;
    if (!maskCanvas || !overlayCanvas) return;

    const maskCtx = maskCanvas.getContext("2d");
    const overlayCtx = overlayCanvas.getContext("2d");
    if (!maskCtx || !overlayCtx) return;

    maskCtx.strokeStyle = "white";
    maskCtx.fillStyle = "white";
    maskCtx.lineCap = "round";
    maskCtx.lineJoin = "round";
    maskCtx.lineWidth = patchBrushSize;

    overlayCtx.strokeStyle = "rgba(94, 176, 173, 0.85)";
    overlayCtx.fillStyle = "rgba(94, 176, 173, 0.85)";
    overlayCtx.lineCap = "round";
    overlayCtx.lineJoin = "round";
    overlayCtx.lineWidth = patchBrushSize;

    if (!prev) {
      maskCtx.beginPath();
      maskCtx.arc(x, y, patchBrushSize / 2, 0, Math.PI * 2);
      maskCtx.fill();
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, patchBrushSize / 2, 0, Math.PI * 2);
      overlayCtx.fill();
    } else {
      maskCtx.beginPath();
      maskCtx.moveTo(prev.x, prev.y);
      maskCtx.lineTo(x, y);
      maskCtx.stroke();
      overlayCtx.beginPath();
      overlayCtx.moveTo(prev.x, prev.y);
      overlayCtx.lineTo(x, y);
      overlayCtx.stroke();
    }
  }

  function clearPatchMask() {
    const maskCanvas = patchMaskCanvasRef.current;
    const overlayCanvas = patchOverlayCanvasRef.current;
    if (maskCanvas) {
      const maskCtx = maskCanvas.getContext("2d");
      if (maskCtx) {
        maskCtx.fillStyle = "black";
        maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
      }
    }
    if (overlayCanvas) {
      const overlayCtx = overlayCanvas.getContext("2d");
      overlayCtx?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
    patchDrawStateRef.current = null;
    setMaskHasPaint(false);
  }

  function setPatchReferenceForTab(tabKey: "first" | "last", file: File) {
    setPatchReferenceImages((previous) => {
      const existing = previous[tabKey];
      if (existing?.previewUrl) {
        URL.revokeObjectURL(existing.previewUrl);
      }
      return {
        ...previous,
        [tabKey]: {
          file,
          previewUrl: URL.createObjectURL(file),
          uploadedKey: undefined,
          frameId: undefined,
        },
      };
    });
  }

  function clearPatchReferenceForTab(tabKey: "first" | "last") {
    setPatchReferenceImages((previous) => {
      const existing = previous[tabKey];
      if (existing?.previewUrl) {
        URL.revokeObjectURL(existing.previewUrl);
      }
      return { ...previous, [tabKey]: null };
    });
  }

  function onPatchMaskPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = patchOverlayCanvasRef.current;
    if (!canvas) return;
    const coords = mapPointerToMaskCoordinates(event, canvas);
    if (!coords) return;
    patchDrawStateRef.current = { drawing: true, x: coords.x, y: coords.y };
    canvas.setPointerCapture(event.pointerId);
    paintMaskStroke(coords.x, coords.y, null);
    setMaskHasPaint(true);
  }

  function onPatchMaskPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = patchOverlayCanvasRef.current;
    const state = patchDrawStateRef.current;
    if (!canvas || !state?.drawing) return;
    const coords = mapPointerToMaskCoordinates(event, canvas);
    if (!coords) return;
    paintMaskStroke(coords.x, coords.y, { x: state.x, y: state.y });
    patchDrawStateRef.current = { drawing: true, x: coords.x, y: coords.y };
    setMaskHasPaint(true);
  }

  function onPatchMaskPointerUp(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = patchOverlayCanvasRef.current;
    if (!canvas) return;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    patchDrawStateRef.current = null;
  }

  function formatAssetDate(iso: string) {
    const asDate = new Date(iso);
    if (Number.isNaN(asDate.getTime())) return iso;
    return asDate.toLocaleString();
  }

  function describeSegment(segment: SegmentRecord): string {
    const endFrameInclusive = Math.max(segment.endFrameExclusive - 1, segment.startFrame);
    return `f${segment.startFrame}-f${endFrameInclusive} · ${segment.durationSec.toFixed(2)}s · ${segment.startTimecode}→${segment.endTimecode}`;
  }

  function describeGeneration(generation: SegmentGeneration): string {
    const segment = segmentsById.get(generation.segmentId);
    const segmentText = segment ? describeSegment(segment) : generation.segmentId;
    const outputLabel = generation.outputKey
      ? humanizeFilename(keyBasenameFromS3Key(generation.outputKey))
      : truncateIdentifier(generation.genId, 12);
    return `${outputLabel} · ${generation.luma.model}/${generation.luma.mode} · ${segmentText} · ${formatCompactTimestamp(generation.createdAt)}`;
  }

  function describeStartFrameVariant(variant: FrameVariant): string {
    const outputLabel = humanizeFilename(keyBasenameFromS3Key(variant.outputKey));
    return `${outputLabel} · ${variant.model}/${variant.type} · ${formatCompactTimestamp(variant.createdAt)} · ${truncateIdentifier(variant.variantId, 10)}`;
  }

  function formatResolution(resolution: { width: number; height: number } | null | undefined): string {
    if (!resolution) return "unknown";
    return `${resolution.width}x${resolution.height}`;
  }

  function describeFrame(frame: FrameRecord | null): string {
    if (!frame) return "Not available";
    return `frame ${frame.frameIndex} · ${frame.timecode}`;
  }

  function describeImageEditSettings(variant: FrameVariant | null): string {
    if (!variant) return "No edited frame selected";
    const settings = variant.generationSettings;
    const details = [
      `${variant.model}/${variant.type}`,
      settings?.provider ? `provider ${settings.provider}` : null,
      settings?.inputResolution ? `input ${formatResolution(settings.inputResolution)}` : null,
      settings?.outputResolution ? `output ${formatResolution(settings.outputResolution)}` : null,
      typeof settings?.runwareRepaintingScale === "number" ? `inpainting scale ${settings.runwareRepaintingScale.toFixed(2)}` : null,
      typeof settings?.featherPx === "number" ? `feather ${settings.featherPx}px` : null,
    ].filter(Boolean);
    return details.join(" · ");
  }

  function describeVideoGenerationSettings(generation: SegmentGeneration): string {
    const settings = generation.generationSettings;
    const details = [
      `${generation.luma.model}/${generation.luma.mode}`,
      settings?.mediaResolution ? `video ${formatResolution(settings.mediaResolution)}` : null,
      settings?.firstFrameResolution ? `frame ${formatResolution(settings.firstFrameResolution)}` : null,
      typeof settings?.requestedDurationSec === "number" ? `requested ${settings.requestedDurationSec.toFixed(2)}s` : null,
      typeof settings?.providerDurationSec === "number" ? `provider ${settings.providerDurationSec.toFixed(2)}s` : null,
    ].filter(Boolean);
    return details.join(" · ");
  }

  function openTaskReport(taskId: string) {
    setReportTaskId(taskId);
    setSelectedTaskId(taskId);
    setTab("report");
  }

  function selectEditCandidate(frameId: string, tabKey: "first" | "last", candidate: EditFrameCandidate) {
    const sourceVariantId = candidate.kind === "variant" ? candidate.variantId ?? null : null;
    setEditSourceVariantIds((previous) => ({ ...previous, [tabKey]: sourceVariantId }));
    const targetVariantId = candidate.kind === "original" ? "original" : candidate.variantId;
    if (!targetVariantId) return;
    selectVariantMutation.mutate({ frameId, variantId: targetVariantId });
    if (tabKey === "first") {
      setFirstFrameVariantId(sourceVariantId ?? "");
    }
  }

  async function handleDeleteAsset(item: LibraryAsset) {
    const ok = window.confirm(`Delete this asset?\n\n${item.title}`);
    if (!ok) return;
    try {
      await deleteAssetMutation.mutateAsync({ taskId: item.taskId, payload: item.deletePayload });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to delete asset");
    }
  }

  async function captureCurrentFrameFor(boundary: "first" | "last") {
    const result = await captureMutation.mutateAsync({ frameIndex: currentFrameIndex });
    setSelectedFrameId(result.frameId);
    setEditSourceVariantIds((previous) => ({ ...previous, [boundary]: null }));
    if (boundary === "first") {
      setFirstFrameId(result.frameId);
    } else {
      setLastFrameId(result.frameId);
    }
  }
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "timeline", label: "Timeline" },
    { id: "frames", label: "Frame Edit" },
    { id: "generate", label: "Generate" },
    { id: "merge", label: "Merge & Export" },
    { id: "assets", label: "Asset Library" },
  ];

  function openNewTaskModal() {
    setNewTaskName("New VFX Task");
    setNewTaskFile(null);
    setNewTaskStage("idle");
    setNewTaskError(null);
    setNewTaskUploadPercent(0);
    setPendingCreateJobId(null);
    setIsNewTaskModalOpen(true);
  }

  async function handleCreateTaskWithUpload() {
    if (!newTaskName.trim() || !newTaskFile) return;
    try {
      setNewTaskError(null);
      setNewTaskUploadPercent(0);
      const normalizedTaskName = normalizeTaskNameInput(newTaskName);
      if (!normalizedTaskName) {
        setNewTaskStage("error");
        setNewTaskError("Task name must include letters or numbers");
        return;
      }
      if (taskNameAlreadyExists) {
        setNewTaskStage("error");
        setNewTaskError("Task name already exists. Choose a unique name.");
        return;
      }
      setNewTaskStage("creating");
      setNewTaskName(normalizedTaskName);
      const created = await apiClient.createTask(normalizedTaskName);
      setSelectedTaskId(created.taskId);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });

      setNewTaskStage("uploading");
      const contentType = newTaskFile.type || "video/mp4";
      const upload = await apiClient.createVideoUpload(created.taskId, {
        filename: newTaskFile.name,
        contentType,
        sizeBytes: newTaskFile.size,
      });
      await uploadFileWithProgress(upload.uploadUrl, newTaskFile, contentType, setNewTaskUploadPercent);

      setNewTaskStage("ingesting");
      const ingest = await apiClient.ingestTask(created.taskId);
      setPendingCreateJobId(ingest.jobId);
      setJobIds((prev) => Array.from(new Set([...prev, ingest.jobId])));
    } catch (error) {
      setNewTaskStage("error");
      setNewTaskError(error instanceof Error ? error.message : "Task setup failed");
    }
  }

  if (!isAuthed) {
    return (
      <main className="min-h-screen bg-bg p-8 text-ink">
        <div className="mx-auto max-w-3xl rounded-2xl border border-ink/10 bg-card p-8 shadow-sm">
          <h1 className="text-3xl font-semibold">AI-assisted VFX Micro Pipeline</h1>
          <p className="mt-3 text-ink/70">Authenticate with Cognito to start creating tasks and processing video segments.</p>
          <button className="mt-6 rounded-lg bg-accent px-5 py-3 text-white" onClick={() => login()}>
            Sign In
          </button>
        </div>
      </main>
    );
  }

  if (tab === "report") {
    const reportPlaybackUrl = reportTask?.video?.editSource?.downloadUrl ?? reportTask?.video?.original?.downloadUrl ?? null;
    const segmentRows = [...(reportTask?.segments ?? [])].sort((a, b) => a.startFrame - b.startFrame);
    return (
      <main className="min-h-screen bg-bg text-ink">
        <div className="mx-auto w-full max-w-[1700px] space-y-4 p-4 md:p-6">
          <div className="flex items-center justify-between rounded-2xl border border-ink/10 bg-card p-4">
            <div>
              <h2 className="text-xl font-semibold">
                Task Report: {reportTask?.name ?? reportTaskId ?? "Task"}
              </h2>
              {reportTask ? <p className="text-sm text-ink/60">Updated {formatAssetDate(reportTask.updatedAt)}</p> : null}
            </div>
            <div className="flex items-center gap-3">
              <button
                className="rounded border border-ink/20 bg-white px-3 py-2 text-sm"
                onClick={() => {
                  if (reportTaskId) setSelectedTaskId(reportTaskId);
                  setTab("timeline");
                }}
              >
                Back to Task
              </button>
              <button onClick={() => logout()} className="text-sm text-ink/60 underline">
                Sign out
              </button>
            </div>
          </div>

          {reportTaskQuery.isPending ? <p className="text-sm text-ink/60">Loading report...</p> : null}
          {reportTaskQuery.error ? <p className="text-sm text-red-600">{(reportTaskQuery.error as Error).message}</p> : null}

          {reportTask ? (
            <>
              <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">Original Video</h3>
                {reportPlaybackUrl ? (
                  <video src={reportPlaybackUrl} controls className="w-full rounded border border-ink/10 bg-bg object-contain" />
                ) : (
                  <p className="text-sm text-ink/60">Original video not available.</p>
                )}
              </section>

              <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">Segment Frame Timecode Summary</h3>
                {segmentRows.length === 0 ? (
                  <p className="text-sm text-ink/60">No segments yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full table-auto text-sm">
                      <thead>
                        <tr className="border-b border-ink/10 text-left">
                          <th className="px-2 py-2">Segment</th>
                          <th className="px-2 py-2">Start</th>
                          <th className="px-2 py-2">End</th>
                          <th className="px-2 py-2">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {segmentRows.map((segment) => (
                          <tr key={segment.segmentId} className="border-b border-ink/10 align-top">
                            <td className="px-2 py-2 font-medium">{segment.segmentId}</td>
                            <td className="px-2 py-2">
                              frame {segment.startFrame} · {segment.startTimecode}
                            </td>
                            <td className="px-2 py-2">
                              frame {Math.max(segment.endFrameExclusive - 1, segment.startFrame)} · {segment.endTimecode}
                            </td>
                            <td className="px-2 py-2">
                              {segment.durationFrames}f / {segment.durationSec.toFixed(2)}s
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">Generation Report (Standard Providers)</h3>
                {reportRows.standard.length === 0 ? (
                  <p className="text-sm text-ink/60">No standard video generations yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full table-fixed">
                      <thead>
                        <tr className="border-b border-ink/10 text-left text-sm">
                          <th className="w-1/4 px-2 py-2">Original</th>
                          <th className="w-1/4 px-2 py-2">Mask</th>
                          <th className="w-1/4 px-2 py-2">Edited</th>
                          <th className="w-1/4 px-2 py-2">Generated Video</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportRows.standard.map((row) => (
                          <tr key={row.generation.genId} className="border-b border-ink/10 align-top">
                            <td className="px-2 py-3">
                              {row.originalUrl ? (
                                <img src={row.originalUrl} alt="Original frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No frame</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{describeFrame(row.startFrame)}</p>
                              <p className="text-[11px] text-ink/50">{row.segment ? `${row.segment.segmentId} · ${describeSegment(row.segment)}` : row.generation.segmentId}</p>
                            </td>
                            <td className="px-2 py-3">
                              {row.maskUrl ? (
                                <img src={row.maskUrl} alt="Patch mask" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No mask used</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">
                                {row.startVariant?.patchMeta ? `feather ${(row.startVariant.patchMeta.featherPx as number | undefined) ?? 0}px` : "No patch mask metadata"}
                              </p>
                            </td>
                            <td className="px-2 py-3">
                              {row.editedUrl ? (
                                <img src={row.editedUrl} alt="Edited frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No edited frame</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{describeImageEditSettings(row.startVariant)}</p>
                            </td>
                            <td className="px-2 py-3">
                              {row.generatedVideoUrl ? (
                                <video src={row.generatedVideoUrl} controls className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No generated video</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{describeVideoGenerationSettings(row.generation)}</p>
                              <p className="text-[11px] text-ink/50">{truncateIdentifier(row.generation.genId, 16)} · {formatCompactTimestamp(row.generation.createdAt)}</p>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="space-y-2 rounded-2xl border border-ink/10 bg-card p-4">
                <h3 className="text-lg font-semibold">Kling Start/End Report</h3>
                {reportRows.kling.length === 0 ? (
                  <p className="text-sm text-ink/60">No Kling generations yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full table-fixed">
                      <thead>
                        <tr className="border-b border-ink/10 text-left text-sm">
                          <th className="w-1/4 px-2 py-2">Original Start</th>
                          <th className="w-1/4 px-2 py-2">Edited Start</th>
                          <th className="w-1/4 px-2 py-2">End Frame</th>
                          <th className="w-1/4 px-2 py-2">Generated Video</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportRows.kling.map((row) => (
                          <tr key={row.generation.genId} className="border-b border-ink/10 align-top">
                            <td className="px-2 py-3">
                              {row.originalUrl ? (
                                <img src={row.originalUrl} alt="Original start frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No frame</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{describeFrame(row.startFrame)}</p>
                            </td>
                            <td className="px-2 py-3">
                              {row.editedUrl ? (
                                <img src={row.editedUrl} alt="Edited start frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No edited start frame</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{describeImageEditSettings(row.startVariant)}</p>
                            </td>
                            <td className="px-2 py-3">
                              {row.endFrameUrl ? (
                                <img src={row.endFrameUrl} alt="End frame" className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No end frame</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{describeFrame(row.endFrame)}</p>
                              <p className="text-[11px] text-ink/50">{row.endVariant ? describeImageEditSettings(row.endVariant) : "Using original end frame"}</p>
                            </td>
                            <td className="px-2 py-3">
                              {row.generatedVideoUrl ? (
                                <video src={row.generatedVideoUrl} controls className="w-full rounded border border-ink/10 bg-bg object-contain" />
                              ) : (
                                <div className="rounded border border-dashed border-ink/20 p-6 text-sm text-ink/50">No generated video</div>
                              )}
                              <p className="mt-2 text-xs text-ink/70">{describeVideoGenerationSettings(row.generation)}</p>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto grid max-w-[1500px] grid-cols-12 gap-4 p-4 md:p-6">
        <aside className="col-span-12 rounded-2xl border border-ink/10 bg-card p-4 md:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Tasks</h2>
            <button onClick={() => logout()} className="text-sm text-ink/60 underline">
              Sign out
            </button>
          </div>

          <button className="mb-4 w-full rounded-md bg-accent px-3 py-2 text-sm text-white" onClick={openNewTaskModal}>
            Add New Task
          </button>

          <div className="space-y-2">
            {(tasksQuery.data ?? []).map((taskItem) => (
              <div
                key={taskItem.taskId}
                className={`relative w-full rounded-lg border px-3 py-2 text-left ${
                  selectedTaskId === taskItem.taskId ? "border-accent bg-accent/10" : "border-ink/10 bg-white"
                }`}
              >
                <button
                  className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-ink/20 bg-white text-xs font-semibold text-ink/70"
                  title="Open task report"
                  aria-label={`Open report for ${taskItem.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openTaskReport(taskItem.taskId);
                  }}
                >
                  i
                </button>
                <button className="w-full pr-8 text-left" onClick={() => setSelectedTaskId(taskItem.taskId)}>
                  <p className="font-medium">{taskItem.name}</p>
                  <p
                    className={`text-xs uppercase tracking-wide ${
                      taskItem.status === "error"
                        ? "text-red-600"
                        : taskItem.status === "ingesting"
                          ? "text-amber-600"
                          : "text-ink/60"
                    }`}
                  >
                    {taskItem.status}
                  </p>
                </button>
                <button className="mt-1 text-xs text-red-600 underline" onClick={() => deleteTaskMutation.mutate(taskItem.taskId)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
          <button className="mt-4 text-sm text-accent underline" onClick={() => setTab("assets")}>
            Open Asset Library
          </button>
        </aside>

        <section className="col-span-12 space-y-4 md:col-span-9">
          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            <div className="mb-4 flex flex-wrap gap-2">
              {tabs.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`rounded-md px-3 py-2 text-sm ${tab === id ? "bg-ink text-white" : "bg-ink/10"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "timeline" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Timeline & Frame Range Selection</h3>
                {timelinePlaybackUrl ? (
                  <div className="mx-auto w-fit max-w-full">
                    <video
                      ref={timelineVideoRef}
                      className="max-h-[360px] max-w-full rounded-lg border border-ink/10"
                      src={timelinePlaybackUrl}
                      controls
                      onTimeUpdate={(e) => {
                        const totalFrames = frameCount(task);
                        if (!totalFrames) return;
                        const fps = fpsValue(task);
                        const nextFrame = Math.max(0, Math.min(totalFrames - 1, Math.round(e.currentTarget.currentTime * fps)));
                        if (nextFrame !== currentFrameIndex) {
                          setCurrentFrameIndex(nextFrame);
                        }
                      }}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-ink/70">Ingest must complete before timeline is available.</p>
                )}
                <div>
                  <label className="mb-1 block text-sm font-medium">Current frame: {currentFrameIndex}</label>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, frameCount(task) - 1)}
                    value={currentFrameIndex}
                    onChange={(e) => setCurrentFrameIndex(Number(e.target.value))}
                    className="w-full"
                  />
                </div>

                <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
                  <FrameSelectCard
                    title="First Frame"
                    frame={firstFrame}
                    onSelect={() => captureCurrentFrameFor("first")}
                    onClear={() => setFirstFrameId(null)}
                  />

                  <div className="flex w-24 flex-col items-center justify-center text-center">
                    <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>
                      {timelineDelta.frames} frames
                    </p>
                    <p className="my-1 text-xl text-ink/70">→</p>
                    <p className={`text-xs font-medium ${timelineDelta.overLimit ? "text-red-600" : "text-ink/70"}`}>
                      {timelineDelta.seconds.toFixed(2)}s
                    </p>
                    <p className="mt-1 text-[10px] text-ink/50">
                      {hasHardDurationLimit
                        ? `limit ${lumaHardLimitFrames}f / ${lumaHardLimitSeconds}s`
                        : "Runway input constrained by 64MB"}
                    </p>
                  </div>

                  <FrameSelectCard
                    title="Last Frame"
                    frame={lastFrame}
                    onSelect={() => captureCurrentFrameFor("last")}
                    onClear={() => setLastFrameId(null)}
                  />
                </div>

                {selectedRange ? (
                  <div className="space-y-2 rounded-lg border border-ink/10 bg-white p-3">
                    <p className={`text-xs ${selectedRange.overLimit ? "text-red-600" : "text-ink/70"}`}>
                      Selected range: {selectedRange.startFrame} {"->"} {selectedRange.endFrameInclusive} (
                      {selectedRange.durationFrames} frames / {selectedRange.durationSec.toFixed(2)}s)
                    </p>
                    <button
                      className="rounded-md bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={createSegmentMutation.isPending}
                      onClick={() =>
                        createSegmentMutation.mutate({
                          startFrameIndex: selectedRange.startFrame,
                          endFrameExclusive: selectedRange.endFrameExclusive,
                        })
                      }
                    >
                      Use Selected Frames as Segment
                    </button>
                    {selectedRange.overLimit ? (
                      <p className="text-xs text-red-600">
                        This exceeds the current Luma model limit ({lumaHardLimitSeconds}s for {lumaModel}). You can still save the segment, but generation will be blocked until under the hard limit.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid gap-2">
                  {task?.segments.map((seg) => (
                    <button
                      key={seg.segmentId}
                      onClick={() => {
                        setSelectedSegmentId(seg.segmentId);
                        setCurrentFrameIndex(seg.startFrame);
                      }}
                      className={`rounded-lg border p-3 text-left ${
                        seg.segmentId === selectedSegmentId ? "border-accent bg-accent/10" : "border-ink/10"
                      }`}
                    >
                      <p className="font-medium">{seg.segmentId}</p>
                      <p className="text-sm text-ink/70">
                        {seg.startFrame} {"->"} {seg.endFrameExclusive} ({seg.durationSec}s)
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tab === "frames" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Frame Capture & Edit</h3>

                <div className="flex gap-2">
                  <button
                    onClick={() => setEditFrameTab("first")}
                    className={`rounded-md px-3 py-2 text-sm ${editFrameTab === "first" ? "bg-ink text-white" : "bg-ink/10"}`}
                  >
                    First Frame
                  </button>
                  <button
                    onClick={() => setEditFrameTab("last")}
                    className={`rounded-md px-3 py-2 text-sm ${editFrameTab === "last" ? "bg-ink text-white" : "bg-ink/10"}`}
                  >
                    Last Frame (Optional)
                  </button>
                </div>

                <div className="space-y-3 rounded-lg border border-ink/10 bg-white p-3">
                  <p className="text-sm text-ink/70">
                    Working on: {editFrameTab === "first" ? "First Frame" : "Last Frame"}
                    {activeEditFrame ? ` (frame ${activeEditFrame.frameIndex}, ${activeEditFrame.timecode})` : ""}
                  </p>

                  {!activeEditFrame ? (
                    <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
                      Select frames in the Timeline tab first, then return here to edit.
                    </div>
                  ) : null}
                  <div className="space-y-3">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Describe the edit"
                      className="h-24 w-full rounded-md border border-ink/20 p-2"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value as "nano_banana" | "nano_banana_pro")}
                        className="rounded-md border border-ink/20 px-2 py-2"
                      >
                        <option value="nano_banana">std</option>
                        <option value="nano_banana_pro">pro</option>
                      </select>
                      <button
                        className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!activeEditFrame || fullEditMutation.isPending || !prompt.trim()}
                        onClick={() => activeEditFrame && fullEditMutation.mutate(activeEditFrame.frameId)}
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Comparison</p>
                  {activeEditFrame?.imageUrl ? (
                    <div
                      className="overflow-hidden rounded-md border border-ink/10 bg-bg"
                      style={{
                        aspectRatio:
                          task?.video?.editSource?.width && task?.video?.editSource?.height
                            ? `${task.video.editSource.width} / ${task.video.editSource.height}`
                            : undefined,
                      }}
                    >
                      <ReactCompareSlider
                        className="h-full w-full"
                        itemOne={
                          <ReactCompareSliderImage
                            src={activeEditFrame.imageUrl}
                            alt="Original"
                            style={{ height: "100%", width: "100%", objectFit: "contain", objectPosition: "center" }}
                          />
                        }
                        itemTwo={
                          <ReactCompareSliderImage
                            src={activeEditSourceImageUrl ?? activeEditFrame.imageUrl}
                            alt="Variant"
                            style={{ height: "100%", width: "100%", objectFit: "contain", objectPosition: "center" }}
                          />
                        }
                      />
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed border-ink/20 bg-bg p-6 text-sm text-ink/60">
                      Select a frame in the Timeline tab to start comparing edits.
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {activeEditCandidates.map((candidate) => (
                      <div
                        key={candidate.id}
                        className={`rounded border p-2 ${
                          candidate.isSelected ? "border-teal-500 bg-teal-50" : "border-ink/10"
                        }`}
                      >
                        <button
                          type="button"
                          className="block w-full"
                          onClick={() => {
                            setImagePreviewModal({ url: candidate.imageUrl, label: candidate.label });
                          }}
                          title="Preview image"
                        >
                          <img src={candidate.imageUrl} className="mb-2 w-full rounded bg-bg object-contain" />
                        </button>
                        <p className="text-xs font-medium text-ink/80">{candidate.label}</p>
                        <p className="text-[11px] text-ink/60">{formatCompactTimestamp(candidate.createdAt)}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded border border-ink/20 bg-white p-2 text-xs"
                            title="Preview"
                            onClick={() => setImagePreviewModal({ url: candidate.imageUrl, label: candidate.label })}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="rounded border border-ink/20 bg-white p-2 text-xs"
                            title="Use for editing"
                            onClick={() => {
                              if (!activeEditFrame) return;
                              selectEditCandidate(activeEditFrame.frameId, editFrameTab, candidate);
                            }}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 20h9" />
                              <path d="m16.5 3.5 4 4L8 20H4v-4L16.5 3.5Z" />
                            </svg>
                          </button>
                          <a
                            href={candidate.imageUrl}
                            target="_blank"
                            rel="noreferrer"
                            download
                            className="rounded border border-ink/20 bg-white p-2 text-xs"
                            title="Download full quality image"
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 3v12" />
                              <path d="m7 10 5 5 5-5" />
                              <path d="M4 21h16" />
                            </svg>
                          </a>
                          <button
                            type="button"
                            className="rounded border border-red-200 bg-white p-2 text-xs text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                            title={candidate.kind === "original" ? "Original frame cannot be deleted" : "Delete variant"}
                            disabled={candidate.kind === "original" || !activeEditFrame || !candidate.variantId}
                            onClick={() => {
                              if (!activeEditFrame || !candidate.variantId) return;
                              handleDeleteAsset({
                                id: `variant:${activeEditFrame.frameId}:${candidate.variantId}`,
                                taskId: selectedTaskId ?? "",
                                title: candidate.label,
                                subtitle: "",
                                createdAt: candidate.createdAt ?? new Date().toISOString(),
                                previewUrl: candidate.imageUrl,
                                downloadUrl: candidate.imageUrl,
                                mediaType: "image",
                                deletePayload: { assetType: "frame_variant", frameId: activeEditFrame.frameId, variantId: candidate.variantId },
                              });
                            }}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18" />
                              <path d="M8 6V4h8v2" />
                              <path d="m6 6 1 14h10l1-14" />
                              <path d="M10 11v6M14 11v6" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <details className="rounded-lg border border-ink/10 p-3">
                  <summary className="cursor-pointer text-sm font-medium">Advanced (Patch Tools)</summary>
                  <div className="mt-3 space-y-3">
                    {activeEditFrame?.imageUrl && activeFrameDimensions ? (
                      <div className="space-y-2">
                        <p className="text-xs text-ink/70">
                          Paint over areas to edit. Painted regions become the mask sent with the frame.
                        </p>
                        <div className="relative inline-block max-w-full overflow-hidden rounded-md border border-ink/20 bg-bg">
                          <img
                            src={activeEditSourceImageUrl ?? activeEditFrame.imageUrl}
                            alt="Patch mask base frame"
                            className="block max-h-[420px] max-w-full select-none"
                            draggable={false}
                          />
                          <canvas
                            ref={patchOverlayCanvasRef}
                            width={activeFrameDimensions.width}
                            height={activeFrameDimensions.height}
                            className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                            onPointerDown={onPatchMaskPointerDown}
                            onPointerMove={onPatchMaskPointerMove}
                            onPointerUp={onPatchMaskPointerUp}
                            onPointerLeave={onPatchMaskPointerUp}
                            onPointerCancel={onPatchMaskPointerUp}
                          />
                        </div>
                        <div className="grid gap-2 md:grid-cols-3">
                          <label className="text-xs text-ink/70">
                            Patch engine
                            <select
                              value={patchEngine}
                              onChange={(e) => setPatchEngine(e.target.value as PatchEngine)}
                              className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                            >
                              <option value="nano_banana_pro">Google Nano Banana Pro</option>
                              <option value="runware_flux_fill">Runware FLUX Fill</option>
                              <option value="runware_ace_pp">Runware ACE++ + FLUX Fill</option>
                            </select>
                          </label>
                          <label className="text-xs text-ink/70">
                            Brush size
                            <select
                              value={patchBrushSize}
                              onChange={(e) => setPatchBrushSize(Number(e.target.value))}
                              className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                            >
                              {[8, 12, 16, 24, 32, 48, 64].map((size) => (
                                <option key={size} value={size}>
                                  {size}px
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="text-xs text-ink/70">
                            Feather edge
                            <select
                              value={featherPx}
                              onChange={(e) => setFeatherPx(Number(e.target.value))}
                              className="mt-1 block w-full rounded border border-ink/20 px-2 py-1 text-sm"
                            >
                              {[0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160, 200].map((value) => (
                                <option key={value} value={value}>
                                  {value}px
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="flex items-end">
                            <button
                              type="button"
                              className="w-full rounded border border-ink/20 bg-white px-3 py-2 text-sm"
                              onClick={clearPatchMask}
                            >
                              Clear mask
                            </button>
                          </div>
                        </div>
                        {patchEngine === "runware_ace_pp" ? (
                          <div className="space-y-2 rounded border border-ink/10 bg-white p-2">
                            <p className="text-xs text-ink/70">
                              ACE++ local editing needs one reference image plus your painted mask.
                            </p>
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                setPatchReferenceForTab(editFrameTab, file);
                              }}
                              className="text-xs"
                            />
                            {activePatchReference?.previewUrl ? (
                              <div className="flex items-start gap-2">
                                <img
                                  src={activePatchReference.previewUrl}
                                  alt="Runware ACE++ reference"
                                  className="max-h-20 rounded border border-ink/10 bg-bg object-contain"
                                />
                                <div className="space-y-1">
                                  <p className="text-xs text-ink/60">{activePatchReference.file.name}</p>
                                  <button
                                    type="button"
                                    className="rounded border border-ink/20 px-2 py-1 text-xs"
                                    onClick={() => clearPatchReferenceForTab(editFrameTab)}
                                  >
                                    Remove reference
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <p className="text-xs text-ink/60">No ACE++ reference image selected.</p>
                            )}
                            <label className="text-xs text-ink/70">
                              Repainting scale
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={runwareRepaintingScale}
                                onChange={(e) => setRunwareRepaintingScale(Number(e.target.value))}
                                className="mt-1 block w-full"
                              />
                              <span className="mt-1 block text-[11px] text-ink/60">{runwareRepaintingScale.toFixed(2)}</span>
                            </label>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-sm text-ink/60">Select a frame above to enable mask painting.</p>
                    )}
                    <textarea
                      value={patchPrompt}
                      onChange={(e) => setPatchPrompt(e.target.value)}
                      placeholder="Describe the masked edit"
                      className="h-20 w-full rounded-md border border-ink/20 p-2"
                    />
                    <button
                      className="rounded-md bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        !activeEditFrame ||
                        patchEditMutation.isPending ||
                        !patchPrompt.trim() ||
                        !maskHasPaint ||
                        (patchEngine === "runware_ace_pp" && !activePatchReference?.file)
                      }
                      onClick={() => activeEditFrame && patchEditMutation.mutate(activeEditFrame.frameId)}
                    >
                      Generate Patch Variant
                    </button>
                    {!maskHasPaint ? <p className="text-xs text-ink/60">Draw a mask before generating a patch variant.</p> : null}
                    {patchEngine === "runware_ace_pp" && !activePatchReference?.file ? (
                      <p className="text-xs text-ink/60">Select one reference image to use ACE++ local editing.</p>
                    ) : null}
                    {patchEditMutation.error ? <p className="text-xs text-red-600">{patchEditMutation.error.message}</p> : null}
                  </div>
                </details>
              </div>
            )}

            {tab === "generate" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Segment Generate</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  <select
                    value={selectedSegmentId ?? ""}
                    onChange={(e) => setSelectedSegmentId(e.target.value || null)}
                    className="rounded-md border border-ink/20 px-3 py-2"
                  >
                    <option value="">Select segment</option>
                    {orderedSegments.map((segment) => (
                      <option key={segment.segmentId} value={segment.segmentId}>
                        {segment.segmentId} · {describeSegment(segment)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={lumaModel}
                    onChange={(e) => setLumaModel(e.target.value as "ray-2" | "ray-flash-2" | "runway-aleph" | "kling-2.6")}
                    className="rounded-md border border-ink/20 px-3 py-2"
                  >
                    <option value="ray-2">ray-2</option>
                    <option value="ray-flash-2">ray-flash-2</option>
                    <option value="runway-aleph">runway-aleph</option>
                    <option value="kling-2.6">kling-2.6 (start/end frames)</option>
                  </select>
                  {lumaModel === "runway-aleph" ? (
                    <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/70">
                      Runway now uses Act Two (first-frame character + reference video motion) with Aleph fallback if Act Two input validation fails.
                    </div>
                  ) : lumaModel === "kling-2.6" ? (
                    <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/70">
                      Kling 2.6 uses start and end frames + duration. It automatically uses selected first/last frame edits when available.
                    </div>
                  ) : (
                    <select value={advancedMode} onChange={(e) => setAdvancedMode(e.target.value)} className="rounded-md border border-ink/20 px-3 py-2">
                      {[
                        "adhere_1",
                        "adhere_2",
                        "adhere_3",
                        "flex_1",
                        "flex_2",
                        "flex_3",
                        "reimagine_1",
                        "reimagine_2",
                        "reimagine_3",
                      ].map((mode) => (
                        <option key={mode} value={mode}>
                          mode: {mode}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <textarea
                  value={lumaPrompt}
                  onChange={(e) => setLumaPrompt(e.target.value)}
                  placeholder="Optional generation prompt"
                  className="h-20 w-full rounded-md border border-ink/20 p-2"
                />

                {selectedSegment && task ? (
                  <select
                    value={firstFrameVariantId}
                    onChange={(e) => setFirstFrameVariantId(e.target.value)}
                    className="rounded-md border border-ink/20 px-3 py-2"
                  >
                    <option value="">Use selected/original frame</option>
                    {selectedStartFrameVariants.map((variant) => (
                      <option key={variant.variantId} value={variant.variantId}>
                        {describeStartFrameVariant(variant)}
                      </option>
                    ))}
                  </select>
                ) : null}

                {selectedSegmentOverLimit ? (
                  <p className="text-xs text-red-600">
                    Selected segment is {selectedSegment?.durationSec.toFixed(2)}s, exceeding the {lumaModel} limit of {lumaHardLimitSeconds}s.
                  </p>
                ) : null}

                <button
                  className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!selectedSegmentId || selectedSegmentOverLimit}
                  onClick={() => generateSegmentMutation.mutate()}
                >
                  Generate Segment Variant
                </button>

                <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Video Comparison</p>
                  {segmentWindow ? (
                    <p className="text-xs text-ink/70">
                      Showing selected segment only: {segmentWindow.startLabel}s to {segmentWindow.endLabel}s.
                    </p>
                  ) : null}
                  {originalSegmentPreviewUrl && selectedPreviewGeneration?.downloadUrl ? (
                    <div
                      className="overflow-hidden rounded-md border border-ink/10 bg-bg"
                      style={{
                        aspectRatio:
                          task?.video?.editSource?.width && task?.video?.editSource?.height
                            ? `${task.video.editSource.width} / ${task.video.editSource.height}`
                            : undefined,
                      }}
                    >
                      <ReactCompareSlider
                        className="h-full w-full"
                        itemOne={
                          <video
                            ref={compareOriginalRef}
                            src={originalSegmentPreviewUrl}
                            muted
                            playsInline
                            className="h-full w-full object-contain"
                            onLoadedMetadata={(e) => {
                              if (segmentWindow) {
                                e.currentTarget.currentTime = segmentWindow.startSec;
                              }
                            }}
                            onTimeUpdate={(e) => keepOriginalWithinSegment(e.currentTarget)}
                          />
                        }
                        itemTwo={
                          <video
                            ref={compareVariantRef}
                            src={selectedPreviewGeneration.downloadUrl}
                            controls
                            playsInline
                            className="h-full w-full object-contain"
                            onLoadedMetadata={(e) => {
                              e.currentTarget.currentTime = 0;
                              syncOriginalToGenerated(e.currentTarget);
                            }}
                            onTimeUpdate={(e) => syncOriginalToGenerated(e.currentTarget)}
                            onSeeking={(e) => syncOriginalToGenerated(e.currentTarget)}
                            onPlay={(e) => {
                              syncOriginalToGenerated(e.currentTarget);
                              compareOriginalRef.current?.play().catch(() => undefined);
                            }}
                            onPause={() => {
                              compareOriginalRef.current?.pause();
                            }}
                          />
                        }
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-ink/60">Select a segment and generated variant to compare.</p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {selectedSegmentGenerations.map((gen, index) => (
                      <div
                        key={gen.genId}
                        className={`rounded border p-2 ${
                          gen.status === "failed"
                            ? "border-orange-400 bg-orange-50"
                            : selectedPreviewGeneration?.genId === gen.genId
                              ? "border-teal-500 bg-teal-50"
                              : "border-ink/10"
                        }`}
                      >
                        <div className="mb-2 flex items-center justify-between text-xs">
                          <span className={`uppercase text-ink/60 ${index === 0 ? "font-semibold" : ""}`}>{gen.status}</span>
                          <span className="text-[11px] text-ink/50">{truncateIdentifier(gen.genId, 14)}</span>
                        </div>
                        <VideoThumbnail
                          videoUrl={gen.downloadUrl ?? undefined}
                          label={describeGeneration(gen)}
                          disabled={!gen.downloadUrl}
                          onClick={() => selectSegmentGeneration(gen.genId)}
                        />
                        <p className="mt-2 text-xs font-medium text-ink/80">
                          {gen.luma.model} / {gen.luma.mode}
                        </p>
                        <p className="text-[11px] text-ink/60">{formatCompactTimestamp(gen.createdAt)}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded border border-ink/20 bg-white p-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={!gen.downloadUrl}
                            title="Preview"
                            onClick={() => {
                              if (!gen.downloadUrl) return;
                              setVideoPreviewModal({ url: gen.downloadUrl, label: describeGeneration(gen) });
                            }}
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                          {gen.downloadUrl ? (
                            <a
                              href={gen.downloadUrl}
                              target="_blank"
                              rel="noreferrer"
                              download
                              className="rounded border border-ink/20 bg-white p-2 text-xs"
                              title="Download full quality video"
                            >
                              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 3v12" />
                                <path d="m7 10 5 5 5-5" />
                                <path d="M4 21h16" />
                              </svg>
                            </a>
                          ) : null}
                          <button
                            type="button"
                            className="rounded border border-red-200 bg-white p-2 text-xs text-red-700"
                            title="Delete generated video"
                            disabled={!task?.taskId}
                            onClick={() =>
                              handleDeleteAsset({
                                id: `generation:${task?.taskId ?? ""}:${gen.genId}`,
                                taskId: task?.taskId ?? "",
                                title: describeGeneration(gen),
                                subtitle: `${gen.luma.model}/${gen.luma.mode}`,
                                createdAt: gen.createdAt,
                                previewUrl: gen.downloadUrl ?? "",
                                downloadUrl: gen.downloadUrl ?? "",
                                mediaType: "video",
                                deletePayload: { assetType: "segment_generation", genId: gen.genId },
                              })
                            }
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18" />
                              <path d="M8 6V4h8v2" />
                              <path d="m6 6 1 14h10l1-14" />
                              <path d="M10 11v6M14 11v6" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {selectedSegmentGenerations.length === 0 ? (
                    <p className="text-sm text-ink/60">No generated variants for this segment yet.</p>
                  ) : null}
                </div>
              </div>
            )}

            {tab === "merge" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Merge & Export</h3>
                <label className="block text-sm">Add generated segment (latest first)</label>
                <select
                  value=""
                  onChange={(e) => {
                    const genId = e.target.value;
                    if (!genId) return;
                    setSelectedGenIds((prev) => (prev.includes(genId) ? prev : [...prev, genId]));
                  }}
                  className="w-full rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="">Select generation</option>
                  {mergeGenerationOptions.map((generation) => (
                    <option key={generation.genId} value={generation.genId}>
                      {describeGeneration(generation)}
                    </option>
                  ))}
                </select>
                <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                  <p className="text-sm font-medium">Selected generations ({selectedMergeGenerations.length})</p>
                  {selectedMergeGenerations.length === 0 ? (
                    <p className="text-sm text-ink/60">No generations selected yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedMergeGenerations.map((generation) => (
                        <div
                          key={generation.genId}
                          className={`flex items-center justify-between gap-3 rounded border p-2 ${
                            generation.status === "failed"
                              ? "border-orange-400 bg-orange-50"
                              : "border-teal-500 bg-teal-50"
                          }`}
                        >
                          <div>
                            <p className="text-sm font-semibold">{describeGeneration(generation)}</p>
                            <p className="text-xs text-ink/50">{generation.genId}</p>
                          </div>
                          <button
                            className="rounded border border-ink/20 bg-white px-2 py-1 text-xs"
                            onClick={() => setSelectedGenIds((prev) => prev.filter((id) => id !== generation.genId))}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <label className="block text-sm">Temporal feather frames (0-30)</label>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={temporalFeatherFrames}
                  onChange={(e) => setTemporalFeatherFrames(Number(e.target.value))}
                  className="w-40 rounded-md border border-ink/20 px-3 py-2"
                />
                <button
                  className="rounded-md bg-accent2 px-4 py-2 text-white"
                  disabled={selectedMergeGenerations.length === 0}
                  onClick={() => mergeMutation.mutate()}
                >
                  Merge Selected Generations
                </button>
                <div className="space-y-2">
                  {sortedExports.map((exp) => (
                    <div key={exp.exportId} className="rounded border border-ink/10 p-3">
                      <p className="font-medium">{humanizeFilename(keyBasenameFromS3Key(exp.outputKey || `${exp.exportId}.mp4`))}</p>
                      <p className="text-xs text-ink/60">
                        {exp.exportId} · {formatCompactTimestamp(exp.createdAt)}
                      </p>
                      {exp.downloadUrl ? (
                        <a className="text-sm text-accent underline" href={exp.downloadUrl}>
                          Download merged video
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === "assets" && (
              <div className="space-y-6">
                <h3 className="text-lg font-semibold">Asset Library</h3>
                {assetsLoading ? <p className="text-sm text-ink/60">Loading assets...</p> : null}
                <div className="space-y-3 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Uploads</p>
                  {uploadAssets.length === 0 ? (
                    <p className="text-sm text-ink/60">No uploads found.</p>
                  ) : (
                    <div className="space-y-2">
                      {uploadAssets.slice(0, uploadAssetsVisible).map((item, index) => (
                        <div
                          key={item.id}
                          className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                            index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                          }`}
                        >
                          <video src={item.previewUrl} className="max-h-20 w-full rounded bg-bg object-contain" muted />
                          <div>
                            <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                            <p className="text-xs text-ink/60">{item.subtitle}</p>
                            <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                              👁
                            </a>
                            <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                              ⬇
                            </a>
                            <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                              🗑
                            </button>
                          </div>
                        </div>
                      ))}
                      {uploadAssetsVisible < uploadAssets.length ? (
                        <button className="text-sm text-accent underline" onClick={() => setUploadAssetsVisible((count) => count + 6)}>
                          More...
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Output Frames & Edits</p>
                  {frameAssets.length === 0 ? (
                    <p className="text-sm text-ink/60">No frame assets found.</p>
                  ) : (
                    <div className="space-y-2">
                      {frameAssets.slice(0, frameAssetsVisible).map((item, index) => (
                        <div
                          key={item.id}
                          className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                            index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                          }`}
                        >
                          <img src={item.previewUrl} className="max-h-20 w-full rounded bg-bg object-contain" />
                          <div>
                            <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                            <p className="text-xs text-ink/60">{item.subtitle}</p>
                            <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                              👁
                            </a>
                            <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                              ⬇
                            </a>
                            <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                              🗑
                            </button>
                          </div>
                        </div>
                      ))}
                      {frameAssetsVisible < frameAssets.length ? (
                        <button className="text-sm text-accent underline" onClick={() => setFrameAssetsVisible((count) => count + 6)}>
                          More...
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-ink/10 p-3">
                  <p className="font-medium">Output Videos</p>
                  {outputVideoAssets.length === 0 ? (
                    <p className="text-sm text-ink/60">No output videos found.</p>
                  ) : (
                    <div className="space-y-2">
                      {outputVideoAssets.slice(0, videoAssetsVisible).map((item, index) => (
                        <div
                          key={item.id}
                          className={`grid gap-2 rounded border p-2 md:grid-cols-[140px_1fr_auto] md:items-center ${
                            index === 0 ? "border-accent/40 bg-accent/5" : "border-ink/10"
                          }`}
                        >
                          <video src={item.previewUrl} className="max-h-20 w-full rounded bg-bg object-contain" muted />
                          <div>
                            <p className={`text-sm ${index === 0 ? "font-semibold" : "font-medium"}`}>{item.title}</p>
                            <p className="text-xs text-ink/60">{item.subtitle}</p>
                            <p className="text-xs text-ink/50">{formatAssetDate(item.createdAt)}</p>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <a href={item.previewUrl} target="_blank" rel="noreferrer" title="Preview">
                              👁
                            </a>
                            <a href={item.downloadUrl} target="_blank" rel="noreferrer" download title="Download">
                              ⬇
                            </a>
                            <button onClick={() => handleDeleteAsset(item)} title="Delete" className="text-red-600">
                              🗑
                            </button>
                          </div>
                        </div>
                      ))}
                      {videoAssetsVisible < outputVideoAssets.length ? (
                        <button className="text-sm text-accent underline" onClick={() => setVideoAssetsVisible((count) => count + 6)}>
                          More...
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Jobs</h3>
            <div className="space-y-2 text-sm">
              {sortedJobs.length === 0 && <p className="text-ink/60">No jobs yet.</p>}
              {sortedJobs.slice(0, jobsVisible).map((job) => {
                return (
                  <div
                    key={job.jobId}
                    className={`rounded border p-2 ${job.status === "failed" ? "border-orange-400 bg-orange-50" : "border-ink/10"}`}
                  >
                    <p className="font-medium">
                      {job.jobId} <span className="text-ink/60">({job.type})</span>
                    </p>
                    <p className="text-xs uppercase">{job.status} - {job.progress}%</p>
                    {job.error ? <p className="text-xs text-red-600">{job.error}</p> : null}
                  </div>
                );
              })}
              {jobsVisible < sortedJobs.length ? (
                <button className="text-sm text-accent underline" onClick={() => setJobsVisible((count) => count + 6)}>
                  More...
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
      {imagePreviewModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setImagePreviewModal(null)}
        >
          <div className="relative flex h-[90vh] w-[90vw] items-center justify-center">
            <button
              className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white"
              onClick={() => setImagePreviewModal(null)}
            >
              x
            </button>
            <img
              src={imagePreviewModal.url}
              alt={imagePreviewModal.label}
              className="h-full w-full object-contain"
              onClick={() => setImagePreviewModal(null)}
            />
          </div>
        </div>
      ) : null}
      {videoPreviewModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setVideoPreviewModal(null)}
        >
          <div
            className="relative w-[90vw] max-w-6xl rounded-lg border border-ink/20 bg-black p-3"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="absolute right-2 top-2 rounded bg-black/70 px-3 py-1 text-sm text-white"
              onClick={() => setVideoPreviewModal(null)}
            >
              x
            </button>
            <video
              src={videoPreviewModal.url}
              controls
              autoPlay
              className="h-[80vh] w-full rounded object-contain"
            />
          </div>
        </div>
      ) : null}
      {isNewTaskModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-ink/10 bg-card p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Create Task & Upload Video</h3>
              <button
                className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => setIsNewTaskModalOpen(false)}
                disabled={newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
              >
                Close
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Task name</label>
                <input
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  maxLength={15}
                  className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
                  disabled={newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
                />
                <p className="mt-1 text-xs text-ink/60">
                  Final name: <span className="font-medium">{normalizedNewTaskName || "(invalid)"}</span> (max 15 chars)
                </p>
                {showTaskNameExistsWarning ? <p className="text-xs text-red-600">Name already used by another task.</p> : null}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Video file</label>
                <input
                  type="file"
                  accept="video/*"
                  onChange={(e) => setNewTaskFile(e.target.files?.[0] ?? null)}
                  disabled={newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
                />
              </div>
              {newTaskStage === "uploading" ? (
                <div>
                  <p className="mb-1 text-sm text-ink/70">Uploading: {newTaskUploadPercent}%</p>
                  <div className="h-2 w-full overflow-hidden rounded bg-ink/10">
                    <div className="h-full bg-accent" style={{ width: `${newTaskUploadPercent}%` }} />
                  </div>
                </div>
              ) : null}
              {newTaskStage === "ingesting" ? (
                <div>
                  <p className="mb-1 text-sm text-ink/70">
                    Ingesting: {pendingCreateJobQuery.data?.progress ?? 0}% ({pendingCreateJobQuery.data?.status ?? "queued"})
                  </p>
                  <div className="h-2 w-full overflow-hidden rounded bg-ink/10">
                    <div className="h-full bg-accent2" style={{ width: `${pendingCreateJobQuery.data?.progress ?? 0}%` }} />
                  </div>
                </div>
              ) : null}
              {newTaskError ? <p className="text-sm text-red-600">{newTaskError}</p> : null}
              <button
                className="w-full rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !newTaskName.trim() ||
                  !normalizedNewTaskName ||
                  taskNameAlreadyExists ||
                  !newTaskFile ||
                  newTaskStage === "creating" ||
                  newTaskStage === "uploading" ||
                  newTaskStage === "ingesting"
                }
                onClick={handleCreateTaskWithUpload}
              >
                {newTaskStage === "creating"
                  ? "Creating task..."
                  : newTaskStage === "uploading"
                    ? "Uploading..."
                    : newTaskStage === "ingesting"
                      ? "Ingesting..."
                      : "Create Task and Ingest"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

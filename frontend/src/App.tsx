import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";

import { apiClient } from "./api/client";
import { currentUser, login, logout } from "./lib/auth";
import { useUiStore } from "./store/uiStore";
import type { TaskDetail } from "./types/api";

type TabId = "timeline" | "frames" | "generate" | "merge";

type NewTaskStage = "idle" | "creating" | "uploading" | "ingesting" | "error";

function frameCount(task: TaskDetail | undefined): number {
  return task?.video?.editSource?.frameCount ?? 0;
}

function fpsValue(task: TaskDetail | undefined): number {
  const fps = task?.video?.editSource?.fps;
  if (!fps || !fps.den) return 30;
  return fps.num / fps.den;
}

function lumaModelMaxDurationSeconds(model: "ray-2" | "ray-flash-2"): number {
  return model === "ray-2" ? 10 : 15;
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
          <img src={frame.imageUrl} alt={`${title} preview`} className="h-28 w-full rounded-md object-cover" />
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
          <p className="mt-2 text-xs text-ink/70">
            frame {frame.frameIndex} ({frame.timecode})
          </p>
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
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("New VFX Task");
  const [newTaskFile, setNewTaskFile] = useState<File | null>(null);
  const [newTaskStage, setNewTaskStage] = useState<NewTaskStage>("idle");
  const [newTaskError, setNewTaskError] = useState<string | null>(null);
  const [newTaskUploadPercent, setNewTaskUploadPercent] = useState(0);
  const [pendingCreateJobId, setPendingCreateJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<"nano_banana" | "nano_banana_pro">("nano_banana");
  const [patchPrompt, setPatchPrompt] = useState("");
  const [patchBrushSize, setPatchBrushSize] = useState(24);
  const [featherPx, setFeatherPx] = useState(24);
  const [maskHasPaint, setMaskHasPaint] = useState(false);
  const [lumaModel, setLumaModel] = useState<"ray-2" | "ray-flash-2">("ray-2");
  const [advancedMode, setAdvancedMode] = useState("flex_1");
  const [lumaPrompt, setLumaPrompt] = useState("");
  const [firstFrameVariantId, setFirstFrameVariantId] = useState("");
  const [selectedGenIds, setSelectedGenIds] = useState<string[]>([]);
  const [selectedPreviewGenId, setSelectedPreviewGenId] = useState<string>("");
  const [temporalFeatherFrames, setTemporalFeatherFrames] = useState(0);
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
  const pendingCreateJobQuery = useQuery({
    queryKey: ["job", pendingCreateJobId],
    queryFn: () => apiClient.getJob(pendingCreateJobId as string),
    enabled: isAuthed && !!pendingCreateJobId,
    refetchInterval: (q: { state: { data?: { status?: string } } }) => {
      const status = q?.state?.data?.status;
      return status === "queued" || status === "running" ? 2000 : false;
    },
  });

  const task = taskQuery.data;
  const selectedSegment = task?.segments.find((s) => s.segmentId === selectedSegmentId) ?? null;
  const firstFrame = task && firstFrameId ? task.frames[firstFrameId] ?? null : null;
  const lastFrame = task && lastFrameId ? task.frames[lastFrameId] ?? null : null;
  const editFirstFrame = (firstFrameId ? task?.frames[firstFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.startFrameId] : null) ?? null;
  const editLastFrame = (lastFrameId ? task?.frames[lastFrameId] : null) ?? (selectedSegment ? task?.frames[selectedSegment.endFrameId] : null) ?? null;
  const activeEditFrame = editFrameTab === "first" ? editFirstFrame : editLastFrame;
  const activeFrameDimensions = useMemo(() => {
    const width = task?.video?.editSource?.width;
    const height = task?.video?.editSource?.height;
    if (!activeEditFrame || !width || !height) return null;
    return { width, height };
  }, [activeEditFrame, task?.video?.editSource?.height, task?.video?.editSource?.width]);

  useEffect(() => {
    setFirstFrameId(null);
    setLastFrameId(null);
  }, [selectedTaskId]);

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
    if (!activeFrameDimensions) {
      setMaskHasPaint(false);
      patchDrawStateRef.current = null;
      return;
    }
    const { width, height } = activeFrameDimensions;
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
  }, [activeEditFrame?.frameId, activeFrameDimensions]);

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
      return apiClient.fullEdit(selectedTaskId, frameId, { model, prompt });
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

      return apiClient.patchSubmit(selectedTaskId, frameId, {
        model,
        prompt: patchPrompt,
        patchKey: init.patchKey,
        maskKey: init.maskKey,
        patchRect,
        featherPx,
        bleedPx: 0,
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
        mode: advancedMode,
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

  const segmentGenerations = useMemo(() => Object.values(task?.segmentGenerations ?? {}), [task]);
  const selectedSegmentGenerations = useMemo(
    () => segmentGenerations.filter((gen) => !selectedSegmentId || gen.segmentId === selectedSegmentId),
    [segmentGenerations, selectedSegmentId],
  );
  const selectedPreviewGeneration =
    selectedSegmentGenerations.find((gen) => gen.genId === selectedPreviewGenId) ?? selectedSegmentGenerations[0] ?? null;
  const lumaHardLimitSeconds = lumaModelMaxDurationSeconds(lumaModel);
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
    return { frames, seconds, overLimit: seconds > lumaHardLimitSeconds };
  }, [currentFrameIndex, firstFrame, lastFrame, lumaHardLimitSeconds, task]);

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
      overLimit: durationSec > lumaHardLimitSeconds,
    };
  }, [firstFrame, lastFrame, lumaHardLimitSeconds, task]);

  const selectedSegmentOverLimit = useMemo(() => {
    if (!selectedSegment) return false;
    return selectedSegment.durationSec > lumaHardLimitSeconds + 1e-6;
  }, [lumaHardLimitSeconds, selectedSegment]);

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

  function syncComparePlayhead(source: HTMLVideoElement, target: HTMLVideoElement) {
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    if (Math.abs(target.currentTime - source.currentTime) > 0.08) {
      target.currentTime = source.currentTime;
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

  async function captureCurrentFrameFor(boundary: "first" | "last") {
    const result = await captureMutation.mutateAsync({ frameIndex: currentFrameIndex });
    setSelectedFrameId(result.frameId);
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
      setNewTaskStage("creating");
      const created = await apiClient.createTask(newTaskName.trim());
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
                className={`w-full rounded-lg border px-3 py-2 text-left ${
                  selectedTaskId === taskItem.taskId ? "border-accent bg-accent/10" : "border-ink/10 bg-white"
                }`}
              >
                <button className="w-full text-left" onClick={() => setSelectedTaskId(taskItem.taskId)}>
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
                {task?.video?.editSource?.downloadUrl ? (
                  <div className="mx-auto w-fit max-w-full">
                    <video
                      ref={timelineVideoRef}
                      className="max-h-[360px] max-w-full rounded-lg border border-ink/10"
                      src={task.video.editSource.downloadUrl}
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
                      limit {lumaHardLimitFrames}f / {lumaHardLimitSeconds}s
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
                            src={
                              activeEditFrame.variants.find((v) => v.variantId === activeEditFrame.selectedVariantId)?.imageUrl ??
                              activeEditFrame.variants[0]?.imageUrl ??
                              activeEditFrame.imageUrl
                            }
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
                  <div className="grid grid-cols-2 gap-2">
                    {activeEditFrame?.variants.map((variant) => (
                      <div key={variant.variantId} className="rounded border border-ink/10 p-2">
                        {variant.imageUrl ? <img src={variant.imageUrl} className="mb-2 h-28 w-full object-contain" /> : null}
                        <p className="text-xs text-ink/70">{variant.type} / {variant.model}</p>
                        <button
                          className="mt-1 rounded bg-ink px-2 py-1 text-xs text-white"
                          onClick={() => selectVariantMutation.mutate({ frameId: activeEditFrame.frameId, variantId: variant.variantId })}
                        >
                          {activeEditFrame.selectedVariantId === variant.variantId ? "Selected" : "Select"}
                        </button>
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
                            src={activeEditFrame.imageUrl}
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
                      disabled={!activeEditFrame || patchEditMutation.isPending || !patchPrompt.trim() || !maskHasPaint}
                      onClick={() => activeEditFrame && patchEditMutation.mutate(activeEditFrame.frameId)}
                    >
                      Generate Patch Variant
                    </button>
                    {!maskHasPaint ? <p className="text-xs text-ink/60">Draw a mask before generating a patch variant.</p> : null}
                    {patchEditMutation.error ? <p className="text-xs text-red-600">{patchEditMutation.error.message}</p> : null}
                  </div>
                </details>
              </div>
            )}

            {tab === "generate" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Segment Generate (Luma)</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  <select
                    value={selectedSegmentId ?? ""}
                    onChange={(e) => setSelectedSegmentId(e.target.value || null)}
                    className="rounded-md border border-ink/20 px-3 py-2"
                  >
                    <option value="">Select segment</option>
                    {task?.segments.map((segment) => (
                      <option key={segment.segmentId} value={segment.segmentId}>
                        {segment.segmentId} ({segment.durationSec}s)
                      </option>
                    ))}
                  </select>
                  <select
                    value={lumaModel}
                    onChange={(e) => setLumaModel(e.target.value as "ray-2" | "ray-flash-2")}
                    className="rounded-md border border-ink/20 px-3 py-2"
                  >
                    <option value="ray-2">ray-2</option>
                    <option value="ray-flash-2">ray-flash-2</option>
                  </select>
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
                </div>

                <textarea
                  value={lumaPrompt}
                  onChange={(e) => setLumaPrompt(e.target.value)}
                  placeholder="Optional Luma prompt"
                  className="h-20 w-full rounded-md border border-ink/20 p-2"
                />

                {selectedSegment && task ? (
                  <select
                    value={firstFrameVariantId}
                    onChange={(e) => setFirstFrameVariantId(e.target.value)}
                    className="rounded-md border border-ink/20 px-3 py-2"
                  >
                    <option value="">Use selected/original frame</option>
                    {(task.frames[selectedSegment.startFrameId]?.variants ?? []).map((variant) => (
                      <option key={variant.variantId} value={variant.variantId}>
                        {variant.variantId} ({variant.model}/{variant.type})
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
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border border-ink/10 p-2">
                      <p className="mb-2 text-sm font-medium">Original segment</p>
                      {originalSegmentPreviewUrl ? (
                        <video
                          ref={compareOriginalRef}
                          src={originalSegmentPreviewUrl}
                          controls
                          className="w-full"
                          onLoadedMetadata={(e) => {
                            if (segmentWindow) {
                              e.currentTarget.currentTime = segmentWindow.startSec;
                            }
                          }}
                          onTimeUpdate={(e) => {
                            keepOriginalWithinSegment(e.currentTarget);
                            const other = compareVariantRef.current;
                            if (other) syncComparePlayhead(e.currentTarget, other);
                          }}
                          onSeeking={(e) => {
                            keepOriginalWithinSegment(e.currentTarget);
                            const other = compareVariantRef.current;
                            if (other) syncComparePlayhead(e.currentTarget, other);
                          }}
                          onPlay={() => {
                            const other = compareVariantRef.current;
                            if (other?.src) other.play().catch(() => undefined);
                          }}
                          onPause={() => {
                            compareVariantRef.current?.pause();
                          }}
                        />
                      ) : (
                        <p className="text-sm text-ink/60">Select a segment to preview the original clip.</p>
                      )}
                    </div>
                    <div className="rounded-md border border-ink/10 p-2">
                      <p className="mb-2 text-sm font-medium">Generated segment</p>
                      {selectedPreviewGeneration?.downloadUrl ? (
                        <video
                          ref={compareVariantRef}
                          src={selectedPreviewGeneration.downloadUrl}
                          controls
                          className="w-full"
                          onTimeUpdate={(e) => {
                            const other = compareOriginalRef.current;
                            if (other) syncComparePlayhead(e.currentTarget, other);
                          }}
                          onSeeking={(e) => {
                            const other = compareOriginalRef.current;
                            if (other) syncComparePlayhead(e.currentTarget, other);
                          }}
                          onPlay={() => {
                            const other = compareOriginalRef.current;
                            if (other?.src) other.play().catch(() => undefined);
                          }}
                          onPause={() => {
                            compareOriginalRef.current?.pause();
                          }}
                        />
                      ) : (
                        <p className="text-sm text-ink/60">No generated variants yet for this segment.</p>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {selectedSegmentGenerations.map((gen) => (
                      <div key={gen.genId} className="rounded border border-ink/10 p-2">
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span>{gen.genId}</span>
                          <span className="uppercase text-ink/60">{gen.status}</span>
                        </div>
                        {gen.downloadUrl ? <video src={gen.downloadUrl} controls className="mb-2 h-28 w-full object-contain" /> : null}
                        <div className="flex items-center justify-between gap-2">
                          <button
                            className="rounded bg-ink px-2 py-1 text-xs text-white"
                            onClick={() => setSelectedPreviewGenId(gen.genId)}
                          >
                            {selectedPreviewGeneration?.genId === gen.genId ? "Selected" : "Compare"}
                          </button>
                          <label className="text-xs text-ink/70">
                            <input
                              type="checkbox"
                              checked={selectedGenIds.includes(gen.genId)}
                              onChange={(e) => {
                                setSelectedGenIds((prev) =>
                                  e.target.checked ? Array.from(new Set([...prev, gen.genId])) : prev.filter((id) => id !== gen.genId),
                                );
                              }}
                            />{" "}
                            Merge
                          </label>
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
                  disabled={selectedGenIds.length === 0}
                  onClick={() => mergeMutation.mutate()}
                >
                  Merge Selected Generations
                </button>
                <div className="space-y-2">
                  {task?.exports.map((exp) => (
                    <div key={exp.exportId} className="rounded border border-ink/10 p-3">
                      <p className="font-medium">{exp.exportId}</p>
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
          </div>

          <div className="rounded-2xl border border-ink/10 bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Jobs</h3>
            <div className="space-y-2 text-sm">
              {jobQueries.length === 0 && <p className="text-ink/60">No jobs yet.</p>}
              {jobQueries.map((jq) => {
                const job = jq.data;
                if (!job) return null;
                return (
                  <div key={job.jobId} className="rounded border border-ink/10 p-2">
                    <p className="font-medium">
                      {job.jobId} <span className="text-ink/60">({job.type})</span>
                    </p>
                    <p className="text-xs uppercase">{job.status} - {job.progress}%</p>
                    {job.error ? <p className="text-xs text-red-600">{job.error}</p> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
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
                  className="w-full rounded-md border border-ink/20 bg-white px-3 py-2"
                  disabled={newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
                />
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
                disabled={!newTaskName.trim() || !newTaskFile || newTaskStage === "creating" || newTaskStage === "uploading" || newTaskStage === "ingesting"}
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

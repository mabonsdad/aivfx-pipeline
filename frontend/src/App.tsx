import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";

import { apiClient } from "./api/client";
import { currentUser, login, logout } from "./lib/auth";
import { useUiStore } from "./store/uiStore";
import type { TaskDetail } from "./types/api";

type TabId = "upload" | "timeline" | "frames" | "generate" | "merge";

const MODE_MAP = {
  very_low: "adhere_1",
  low: "adhere_2",
  medium: "flex_1",
  high: "flex_2",
  very_high: "reimagine_1",
} as const;

function frameCount(task: TaskDetail | undefined): number {
  return task?.video?.editSource?.frameCount ?? 0;
}

function fpsValue(task: TaskDetail | undefined): number {
  const fps = task?.video?.editSource?.fps;
  if (!fps || !fps.den) return 30;
  return fps.num / fps.den;
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
  const [tab, setTab] = useState<TabId>("upload");
  const [taskName, setTaskName] = useState("New VFX Task");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [segmentDuration, setSegmentDuration] = useState<5 | 6 | 10>(5);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<"nano_banana" | "nano_banana_pro">("nano_banana");
  const [patchPrompt, setPatchPrompt] = useState("");
  const [patchRect, setPatchRect] = useState({ x: 0, y: 0, width: 256, height: 256 });
  const [featherPx, setFeatherPx] = useState(24);
  const [bleedPx, setBleedPx] = useState(32);
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [customPatchFile, setCustomPatchFile] = useState<File | null>(null);
  const [lumaModel, setLumaModel] = useState<"ray-2" | "ray-flash-2">("ray-2");
  const [modifyStrength, setModifyStrength] = useState<keyof typeof MODE_MAP>("medium");
  const [advancedMode, setAdvancedMode] = useState("flex_1");
  const [useAdvancedMode, setUseAdvancedMode] = useState(false);
  const [lumaPrompt, setLumaPrompt] = useState("");
  const [firstFrameVariantId, setFirstFrameVariantId] = useState("");
  const [selectedGenIds, setSelectedGenIds] = useState<string[]>([]);
  const [temporalFeatherFrames, setTemporalFeatherFrames] = useState(0);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const timelineVideoRef = useRef<HTMLVideoElement | null>(null);

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
  });

  const task = taskQuery.data;
  const selectedFrame = task && selectedFrameId ? task.frames[selectedFrameId] : null;
  const selectedSegment = task?.segments.find((s) => s.segmentId === selectedSegmentId) ?? null;

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

  const createTaskMutation = useMutation({
    mutationFn: async () => apiClient.createTask(taskName.trim()),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setSelectedTaskId(result.taskId);
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => apiClient.deleteTask(taskId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setSelectedTaskId(null);
    },
  });

  const ingestMutation = useMutation({
    mutationFn: (taskId: string) => apiClient.ingestTask(taskId),
    onSuccess: async (result) => {
      setJobIds((prev) => Array.from(new Set([...prev, result.jobId])));
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      setTab("timeline");
    },
  });

  const captureMutation = useMutation({
    mutationFn: async (frameIndex: number) => {
      if (!selectedTaskId) throw new Error("Select a task");
      return apiClient.captureFrame(selectedTaskId, frameIndex);
    },
    onSuccess: async (result) => {
      setSelectedFrameId(result.frameId);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
      setTab("frames");
    },
  });

  const createSegmentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId) throw new Error("Select task");
      return apiClient.createSegment(selectedTaskId, {
        startFrameIndex: currentFrameIndex,
        durationSeconds: segmentDuration,
      });
    },
    onSuccess: async (result) => {
      setSelectedSegmentId(result.segmentId);
      await queryClient.invalidateQueries({ queryKey: ["task", selectedTaskId] });
    },
  });

  const fullEditMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !selectedFrameId) throw new Error("Capture/select a frame first");
      return apiClient.fullEdit(selectedTaskId, selectedFrameId, { model, prompt });
    },
    onSuccess: (result) => setJobIds((prev) => Array.from(new Set([...prev, result.jobId]))),
  });

  const patchEditMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTaskId || !selectedFrameId) throw new Error("Capture/select a frame first");
      const init = await apiClient.patchInit(selectedTaskId, selectedFrameId, {
        patchRect,
        featherPx,
        bleedPx,
        hasMask: !!maskFile,
      });

      if (customPatchFile) {
        await fetch(init.patchUploadUrl, {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body: customPatchFile,
        });
      }

      if (maskFile && init.maskUploadUrl) {
        await fetch(init.maskUploadUrl, {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body: maskFile,
        });
      }

      return apiClient.patchSubmit(selectedTaskId, selectedFrameId, {
        model,
        prompt: patchPrompt,
        patchKey: init.patchKey,
        maskKey: init.maskKey,
        patchRect,
        featherPx,
        bleedPx,
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
        mode: useAdvancedMode ? advancedMode : MODE_MAP[modifyStrength],
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
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "upload", label: "Upload & Ingest" },
    { id: "timeline", label: "Timeline" },
    { id: "frames", label: "Frame Edit" },
    { id: "generate", label: "Generate" },
    { id: "merge", label: "Merge & Export" },
  ];

  async function handleUploadThenIngest() {
    if (!selectedTaskId || !uploadFile) return;
    const upload = await apiClient.createVideoUpload(selectedTaskId, {
      filename: uploadFile.name,
      contentType: uploadFile.type || "video/mp4",
      sizeBytes: uploadFile.size,
    });
    await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { "content-type": uploadFile.type || "video/mp4" },
      body: uploadFile,
    });
    ingestMutation.mutate(selectedTaskId);
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

          <div className="mb-4 flex gap-2">
            <input
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              className="w-full rounded-md border border-ink/20 bg-white px-2 py-1"
            />
            <button
              className="rounded-md bg-accent px-3 py-1 text-sm text-white"
              onClick={() => createTaskMutation.mutate()}
            >
              Create
            </button>
          </div>

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
                  <p className="text-xs uppercase tracking-wide text-ink/60">{taskItem.status}</p>
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

            {tab === "upload" && (
              <div className="space-y-3">
                <h3 className="text-lg font-semibold">Upload & Ingest</h3>
                <input type="file" accept="video/*" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
                <button
                  className="rounded-lg bg-accent px-4 py-2 text-white"
                  disabled={!selectedTaskId || !uploadFile || ingestMutation.isPending}
                  onClick={handleUploadThenIngest}
                >
                  Upload and Ingest
                </button>
                <p className="text-sm text-ink/70">Status: {task?.status ?? "no task selected"}</p>
              </div>
            )}

            {tab === "timeline" && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Timeline & Segment Selection</h3>
                {task?.video?.editSource?.downloadUrl ? (
                  <video
                    ref={timelineVideoRef}
                    className="max-h-[360px] w-full rounded-lg border border-ink/10"
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
                <div className="flex flex-wrap gap-2">
                  <select
                    value={segmentDuration}
                    onChange={(e) => setSegmentDuration(Number(e.target.value) as 5 | 6 | 10)}
                    className="rounded-md border border-ink/20 bg-white px-3 py-2"
                  >
                    <option value={5}>5s</option>
                    <option value={6}>6s</option>
                    <option value={10}>10s</option>
                  </select>
                  <button className="rounded-md bg-accent2 px-4 py-2 text-white" onClick={() => createSegmentMutation.mutate()}>
                    Add Segment @ Frame {currentFrameIndex}
                  </button>
                  <button className="rounded-md bg-ink px-4 py-2 text-white" onClick={() => captureMutation.mutate(currentFrameIndex)}>
                    Capture Current Frame
                  </button>
                </div>

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

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                    <p className="font-medium">Capture</p>
                    <button className="rounded-md bg-ink px-4 py-2 text-white" onClick={() => captureMutation.mutate(currentFrameIndex)}>
                      Capture Frame {currentFrameIndex}
                    </button>
                    <div className="max-h-52 space-y-2 overflow-auto">
                      {Object.values(task?.frames ?? {}).map((frame) => (
                        <button
                          key={frame.frameId}
                          onClick={() => setSelectedFrameId(frame.frameId)}
                          className={`w-full rounded-md border px-3 py-2 text-left ${
                            frame.frameId === selectedFrameId ? "border-accent bg-accent/10" : "border-ink/10"
                          }`}
                        >
                          <p className="text-sm font-medium">{frame.timecode}</p>
                          <p className="text-xs text-ink/60">frame {frame.frameIndex}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2 rounded-lg border border-ink/10 p-3">
                    <p className="font-medium">Full-frame edit</p>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value as "nano_banana" | "nano_banana_pro")}
                      className="w-full rounded-md border border-ink/20 px-2 py-2"
                    >
                      <option value="nano_banana">Nano Banana (gemini-3.1-flash-image-preview)</option>
                      <option value="nano_banana_pro">Nano Banana Pro (gemini-3-pro-image-preview)</option>
                    </select>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Describe the edit"
                      className="h-24 w-full rounded-md border border-ink/20 p-2"
                    />
                    <button className="rounded-md bg-accent px-4 py-2 text-white" onClick={() => fullEditMutation.mutate()}>
                      Generate Full Variant
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 rounded-lg border border-ink/10 p-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="font-medium">Patch edit</p>
                    <div className="grid grid-cols-2 gap-2">
                      <input type="number" value={patchRect.x} onChange={(e) => setPatchRect((s) => ({ ...s, x: Number(e.target.value) }))} className="rounded border border-ink/20 px-2 py-1" placeholder="x" />
                      <input type="number" value={patchRect.y} onChange={(e) => setPatchRect((s) => ({ ...s, y: Number(e.target.value) }))} className="rounded border border-ink/20 px-2 py-1" placeholder="y" />
                      <input type="number" value={patchRect.width} onChange={(e) => setPatchRect((s) => ({ ...s, width: Number(e.target.value) }))} className="rounded border border-ink/20 px-2 py-1" placeholder="w" />
                      <input type="number" value={patchRect.height} onChange={(e) => setPatchRect((s) => ({ ...s, height: Number(e.target.value) }))} className="rounded border border-ink/20 px-2 py-1" placeholder="h" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input type="number" value={featherPx} min={0} max={200} onChange={(e) => setFeatherPx(Number(e.target.value))} className="rounded border border-ink/20 px-2 py-1" placeholder="feather px" />
                      <input type="number" value={bleedPx} min={0} max={300} onChange={(e) => setBleedPx(Number(e.target.value))} className="rounded border border-ink/20 px-2 py-1" placeholder="bleed px" />
                    </div>
                    <textarea
                      value={patchPrompt}
                      onChange={(e) => setPatchPrompt(e.target.value)}
                      placeholder="Describe patch edit"
                      className="h-20 w-full rounded-md border border-ink/20 p-2"
                    />
                    <label className="block text-xs text-ink/70">Optional custom patch PNG</label>
                    <input type="file" accept="image/png" onChange={(e) => setCustomPatchFile(e.target.files?.[0] ?? null)} />
                    <label className="block text-xs text-ink/70">Optional mask PNG</label>
                    <input type="file" accept="image/png" onChange={(e) => setMaskFile(e.target.files?.[0] ?? null)} />
                    <button className="rounded-md bg-accent2 px-4 py-2 text-white" onClick={() => patchEditMutation.mutate()}>
                      Generate Patch Variant
                    </button>
                  </div>

                  <div className="space-y-2">
                    <p className="font-medium">Image comparison</p>
                    {selectedFrame?.imageUrl && selectedFrame.variants.length > 0 && (
                      <ReactCompareSlider
                        itemOne={<ReactCompareSliderImage src={selectedFrame.imageUrl} alt="Original" />}
                        itemTwo={
                          <ReactCompareSliderImage
                            src={
                              selectedFrame.variants.find((v) => v.variantId === selectedFrame.selectedVariantId)?.imageUrl ??
                              selectedFrame.variants[0].imageUrl ??
                              selectedFrame.imageUrl
                            }
                            alt="Variant"
                          />
                        }
                      />
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      {selectedFrame?.variants.map((variant) => (
                        <div key={variant.variantId} className="rounded border border-ink/10 p-2">
                          {variant.imageUrl ? <img src={variant.imageUrl} className="mb-2 h-28 w-full object-contain" /> : null}
                          <p className="text-xs text-ink/70">{variant.type} / {variant.model}</p>
                          <button
                            className="mt-1 rounded bg-ink px-2 py-1 text-xs text-white"
                            onClick={() => selectVariantMutation.mutate({ frameId: selectedFrame.frameId, variantId: variant.variantId })}
                          >
                            {selectedFrame.selectedVariantId === variant.variantId ? "Selected" : "Select"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
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
                  <select
                    value={modifyStrength}
                    onChange={(e) => setModifyStrength(e.target.value as keyof typeof MODE_MAP)}
                    className="rounded-md border border-ink/20 px-3 py-2"
                    disabled={useAdvancedMode}
                  >
                    <option value="very_low">Very Low (adhere_1)</option>
                    <option value="low">Low (adhere_2)</option>
                    <option value="medium">Medium (flex_1)</option>
                    <option value="high">High (flex_2)</option>
                    <option value="very_high">Very High (reimagine_1)</option>
                  </select>
                  <label className="flex items-center gap-2 rounded-md border border-ink/20 px-3 py-2">
                    <input type="checkbox" checked={useAdvancedMode} onChange={(e) => setUseAdvancedMode(e.target.checked)} />
                    Advanced mode
                  </label>
                  {useAdvancedMode && (
                    <select value={advancedMode} onChange={(e) => setAdvancedMode(e.target.value)} className="rounded-md border border-ink/20 px-3 py-2 md:col-span-2">
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
                        <option key={mode} value={mode}>{mode}</option>
                      ))}
                    </select>
                  )}
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

                <button className="rounded-md bg-accent px-4 py-2 text-white" onClick={() => generateSegmentMutation.mutate()}>
                  Generate Segment Variant
                </button>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-ink/10 p-3">
                    <p className="mb-2 font-medium">Original (edit source)</p>
                    {task?.video?.editSource?.downloadUrl ? <video src={task.video.editSource.downloadUrl} controls className="w-full" /> : null}
                  </div>
                  <div className="rounded-lg border border-ink/10 p-3">
                    <p className="mb-2 font-medium">Generated variants</p>
                    <div className="space-y-2">
                      {segmentGenerations.map((gen) => (
                        <label key={gen.genId} className="block rounded border border-ink/10 p-2">
                          <div className="mb-1 flex items-center justify-between text-sm">
                            <span>{gen.genId}</span>
                            <span className="uppercase text-ink/60">{gen.status}</span>
                          </div>
                          {gen.downloadUrl ? <video src={gen.downloadUrl} controls className="mb-2 w-full" /> : null}
                          <input
                            type="checkbox"
                            checked={selectedGenIds.includes(gen.genId)}
                            onChange={(e) => {
                              setSelectedGenIds((prev) =>
                                e.target.checked ? Array.from(new Set([...prev, gen.genId])) : prev.filter((id) => id !== gen.genId),
                              );
                            }}
                          />{" "}
                          Include in merge
                        </label>
                      ))}
                    </div>
                  </div>
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
    </main>
  );
}

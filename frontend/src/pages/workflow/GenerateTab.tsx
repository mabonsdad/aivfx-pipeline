import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { CompareIcon, CopyIcon, DeleteIcon, DownloadIcon, IconActionButton, PreviewIcon } from "../../components/layout/MediaActionButtons";
import { PendingButtonLabel, Spinner, StatusNotice } from "../../components/layout/UiFeedback";
import FrameLimitInfoButton from "../../components/workflow/FrameLimitInfoButton";
import { copyTextToClipboard } from "../../lib/clipboard";
import type {
  HappyHorseResolutionId,
  ReplicateKlingModeId,
  ReplicateKlingV3ModeId,
  Sora2ResolutionId,
  VideoModelId,
  Wan27ResolutionId,
} from "../../lib/generated/videoContracts";
import type { GenerateInputMode } from "../../lib/generationModeRegistry";
import type { ChunkedGenerationRun, CustomReportOutputRef, SegmentGeneration, SegmentRecord, TaskDetail } from "../../types/api";

type VideoModel = VideoModelId;

type PendingGenerationCard = {
  jobId: string;
  segmentId: string;
  genId?: string;
  model: string;
  mode: string;
  status: "queued" | "running" | "failed";
  progress: number;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
};

export type GenerateTabCtx = {
  viewMode: "create" | "outputs";
  onNext: () => void;
  nextDisabled: boolean;
  nextWarning: string | null;
  generationModelByInput: Record<GenerateInputMode, VideoModel>;
  generationInputMode: GenerateInputMode;
  editVideoReferenceWarning: string | null;
  openEditVideoReferencePicker: () => void;
  supportsGenerationAudioReference: boolean;
  generationAudioReference: TaskDetail["generationAudioReference"] | null;
  uploadGenerationAudioReference: (file: File) => Promise<void>;
  selectedSegment: SegmentRecord | null;
  isWholeVideoSelection: boolean;
  wholeVideoNeedsChunking: boolean;
  wholeVideoSinglePassLimitSeconds: number;
  describeSegment: (segment: SegmentRecord) => string;
  lumaModel: VideoModel;
  setGenerationModelByInput: (
    update:
      | Record<GenerateInputMode, VideoModel>
      | ((previous: Record<GenerateInputMode, VideoModel>) => Record<GenerateInputMode, VideoModel>),
  ) => void;
  generationModelOptions: Array<{ value: VideoModel; label: string }>;
  advancedMode: string;
  setAdvancedMode: (value: string) => void;
  replicateKlingMode: ReplicateKlingModeId;
  setReplicateKlingMode: (value: ReplicateKlingModeId) => void;
  replicateKlingV3Mode: ReplicateKlingV3ModeId;
  setReplicateKlingV3Mode: (value: ReplicateKlingV3ModeId) => void;
  wan27Resolution: Wan27ResolutionId;
  setWan27Resolution: (value: Wan27ResolutionId) => void;
  happyHorseResolution: HappyHorseResolutionId;
  setHappyHorseResolution: (value: HappyHorseResolutionId) => void;
  wan27NegativePrompt: string;
  setWan27NegativePrompt: (value: string) => void;
  sora2Resolution: Sora2ResolutionId;
  setSora2Resolution: (value: Sora2ResolutionId) => void;
  preserveFrames: boolean;
  setPreserveFrames: (value: boolean) => void;
  lumaPrompt: string;
  setLumaPrompt: (value: string) => void;
  promptWizardSupported: boolean;
  improvePromptWithWizard: () => Promise<{ userAdvice: string; warnings: string[] }>;
  isPromptWizardPending: boolean;
  lumaContinuationPrompt: string;
  setLumaContinuationPrompt: (value: string) => void;
  generationPromptPlaceholder: string;
  generationPromptError: string | null;
  missingRouteInputsMessage: string | null;
  autoModelTestSupported: boolean;
  autoModelTestModels: Array<{ id: string; label: string; disabledReason: string | null }>;
  autoModelTestWarning: string | null;
  autoModelTestError: string | null;
  runAutoModelTest: (selectedModelIds: string[]) => Promise<void>;
  isAutoModelTestRunning: boolean;
  generationInputNote: string;
  generationHelp: { title: string; lines: string[] };
  selectedStartSourceLabel: string;
  selectedEndSourceLabel: string | null;
  selectedSegmentOverLimit: boolean;
  selectedSegmentLimitMessage: string | null;
  selectedSegmentId: string | null;
  generateSegmentMutation: { mutate: () => void; isPending?: boolean };
  generateChunkedSegmentMutation: { mutate: () => void; isPending?: boolean };
  selectedSegmentChunkedGenerationRuns: ChunkedGenerationRun[];
  pauseChunkedGeneration: (payload: { runId: string; reason?: string }) => void;
  resumeChunkedGeneration: (payload: { runId: string }) => void;
  restartChunkedGeneration: (payload: { runId: string; fromChunkIndex: number; prompt?: string }) => void;
  saveChunkedGenerationDraft: (payload: { runId: string }) => void;
  cancelChunkedGeneration: (payload: { runId: string; reason?: string }) => void;
  isChunkedGenerationMutationPending: boolean;
  frameVariantImageUrl: (frameId: string | null | undefined, variantId: string | null | undefined) => string | null;
  segmentWindow: { startSec: number; endSec: number; startLabel: string; endLabel: string } | null;
  originalSegmentPreviewUrl: string | null;
  originalSegmentCompareUrl: string | null;
  uploadManualGeneratedVideo: (file: File) => Promise<string>;
  selectedPreviewGeneration: SegmentGeneration | null;
  task: TaskDetail | undefined;
  originalPreviewIsSegmentClip: boolean;
  selectedSegmentGenerations: SegmentGeneration[];
  pendingGenerations: PendingGenerationCard[];
  removeFailedPendingGenerationJob: (payload: { jobId: string; genId?: string }) => Promise<void>;
  requestCancelPendingGenerationJob: (jobId: string) => Promise<void>;
  selectedReportOutputs: Record<string, { taskId: string; ref: CustomReportOutputRef }>;
  reportOutputRefKey: (ref: CustomReportOutputRef) => string;
  toggleCustomReportOutput: (taskId: string, ref: CustomReportOutputRef) => void;
  generationCardsVisible: number;
  truncateIdentifier: (value: string, maxLength?: number) => string;
  selectSegmentGeneration: (genId: string) => void;
  describeGeneration: (generation: SegmentGeneration) => string;
  generationThumbnailUrl: (generation: SegmentGeneration) => string | null;
  formatCompactTimestamp: (iso: string | undefined) => string;
  setVideoPreviewModal: (value: { url: string; label: string; taskId?: string; generationId?: string } | null) => void;
  setVideoCompareModal: (value: {
    originalUrl: string;
    compareUrl: string;
    label: string;
    posterUrl?: string | null;
    originalPosterUrl?: string | null;
    segmentStartSec?: number;
    originalIsSegmentClip?: boolean;
    originalSegmentId?: string;
    compareGenerationId?: string;
    preferGenerationInputMediaAsOriginal?: boolean;
  } | null) => void;
  openVideoCleanupModal: (generation: SegmentGeneration) => void;
  extendGeneration: (payload: {
    generationId: string;
    alignmentFrameIndex: number;
    anchorFramesFromEnd: number;
    durationSeconds?: number;
    prompt?: string;
    inputMode?: GenerateInputMode;
    continueToRangeEnd?: boolean;
    useSourceLastFrame?: boolean;
    lastFrameVariantId?: string;
  }) => void;
  isExtendingGeneration: boolean;
  extendGenerationError: string | null;
  lengthenGeneration: (payload: {
    generationId: string;
    model: string;
    direction: "start" | "end";
    durationSeconds: number;
    prompt: string;
    inputMode: "start_end" | "edit_video";
    selectedReferenceIds?: string[];
  }) => void;
  isLengtheningGeneration: boolean;
  lengthenGenerationError: string | null;
  editVideoSelectedReferenceIds: string[];
  onAssetError: (url?: string) => void;
  handleDeleteAsset: (item: {
    id: string;
    taskId: string;
    title: string;
    subtitle: string;
    createdAt: string;
    previewUrl: string;
    downloadUrl: string;
    mediaType: "image" | "video";
    deletePayload: { assetType: "segment_generation"; genId: string };
  }) => Promise<void>;
  setGenerationCardsVisible: (update: number | ((count: number) => number)) => void;
};

type GenerateTabProps = {
  ctx: GenerateTabCtx;
};

type ExtendModalState =
  | { tool: "extend"; generation: SegmentGeneration }
  | { tool: "lengthen"; generation: SegmentGeneration; inputMode: "start_end" | "edit_video" };

function asFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function estimateGenerationDurationFrames(generation: SegmentGeneration, fps: number, fallbackDurationFrames: number): number {
  const storedFrameCount = asFiniteNumber(generation.generationSettings?.storedOutput?.frameCount);
  if (storedFrameCount != null && storedFrameCount > 0) {
    return Math.max(1, Math.round(storedFrameCount));
  }
  const durationSec =
    asFiniteNumber(generation.generationSettings?.storedOutput?.durationSec) ??
    asFiniteNumber(generation.providerDurationSec) ??
    asFiniteNumber(generation.generationSettings?.providerDurationSec) ??
    asFiniteNumber(generation.requestedDurationSec);
  if (durationSec != null && durationSec > 0 && fps > 0) {
    return Math.max(1, Math.round(durationSec * fps));
  }
  return Math.max(1, fallbackDurationFrames);
}

const CLIP_LENGTHEN_MODEL_OPTIONS: Record<
  "start_end" | "edit_video",
  Record<"start" | "end", Array<{ value: string; label: string }>>
> = {
  start_end: {
    start: [
      { value: "ltx-2.3-pro", label: "LTX 2.3 Pro" },
      { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video" },
    ],
    end: [
      { value: "ltx-2.3-pro", label: "LTX 2.3 Pro" },
      { value: "wan2.7-i2v", label: "Wan 2.7 I2V" },
      { value: "veo-3.1", label: "Veo 3.1" },
      { value: "veo-3.1-fast", label: "Veo 3.1 Fast" },
    ],
  },
  edit_video: {
    start: [
      { value: "ltx-2.3-pro", label: "LTX 2.3 Pro" },
      { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video" },
    ],
    end: [
      { value: "ltx-2.3-pro", label: "LTX 2.3 Pro" },
      { value: "seedance-2.0-reference-to-video", label: "Seedance 2.0 Reference to Video" },
      { value: "veo-3.1", label: "Veo 3.1" },
      { value: "veo-3.1-fast", label: "Veo 3.1 Fast" },
    ],
  },
};

export default function GenerateTab({ ctx }: GenerateTabProps) {
  const {
    onNext,
    nextDisabled,
    nextWarning,
    generationInputMode,
    editVideoReferenceWarning,
    openEditVideoReferencePicker,
    supportsGenerationAudioReference,
    generationAudioReference,
    uploadGenerationAudioReference,
    selectedSegment,
    wholeVideoNeedsChunking,
    lumaModel,
    describeSegment,
    setGenerationModelByInput,
    generationModelOptions,
    advancedMode,
    setAdvancedMode,
    replicateKlingMode,
    setReplicateKlingMode,
    replicateKlingV3Mode,
    setReplicateKlingV3Mode,
    wan27Resolution,
    setWan27Resolution,
    happyHorseResolution,
    setHappyHorseResolution,
    wan27NegativePrompt,
    setWan27NegativePrompt,
    sora2Resolution,
    setSora2Resolution,
    preserveFrames,
    setPreserveFrames,
    lumaPrompt,
    setLumaPrompt,
    promptWizardSupported,
    improvePromptWithWizard,
    isPromptWizardPending,
    lumaContinuationPrompt,
    setLumaContinuationPrompt,
    generationPromptPlaceholder,
    generationPromptError,
    missingRouteInputsMessage,
    autoModelTestSupported,
    autoModelTestModels,
    autoModelTestWarning,
    autoModelTestError,
    runAutoModelTest,
    isAutoModelTestRunning,
    generationHelp,
    selectedSegmentOverLimit,
    selectedSegmentLimitMessage,
    selectedSegmentId,
    generateSegmentMutation,
    generateChunkedSegmentMutation,
    selectedSegmentChunkedGenerationRuns,
    pauseChunkedGeneration,
    resumeChunkedGeneration,
    restartChunkedGeneration,
    saveChunkedGenerationDraft,
    cancelChunkedGeneration,
    isChunkedGenerationMutationPending,
    frameVariantImageUrl,
    segmentWindow,
    originalSegmentPreviewUrl,
    originalSegmentCompareUrl,
    uploadManualGeneratedVideo,
    selectedPreviewGeneration,
    task,
    originalPreviewIsSegmentClip,
    selectedSegmentGenerations,
    pendingGenerations,
    removeFailedPendingGenerationJob,
    requestCancelPendingGenerationJob,
    generationCardsVisible,
    truncateIdentifier,
    selectSegmentGeneration,
    describeGeneration,
    generationThumbnailUrl,
    formatCompactTimestamp,
    setVideoPreviewModal,
    setVideoCompareModal,
    onAssetError,
    extendGeneration,
    isExtendingGeneration,
    extendGenerationError,
    lengthenGeneration,
    isLengtheningGeneration,
    lengthenGenerationError,
    editVideoSelectedReferenceIds,
    handleDeleteAsset,
    setGenerationCardsVisible,
  } = ctx;
  const latestChunkedRun = selectedSegmentChunkedGenerationRuns[0] ?? null;
  const [isChunkSessionOpen, setIsChunkSessionOpen] = useState(false);
  const [chunkPromptDrafts, setChunkPromptDrafts] = useState<Record<number, string>>({});
  const [manualUploadPending, setManualUploadPending] = useState(false);
  const [manualUploadError, setManualUploadError] = useState<string | null>(null);
  const [audioReferenceUploadPending, setAudioReferenceUploadPending] = useState(false);
  const [audioReferenceUploadError, setAudioReferenceUploadError] = useState<string | null>(null);
  const [promptWizardAdvice, setPromptWizardAdvice] = useState<string | null>(null);
  const [promptWizardWarnings, setPromptWizardWarnings] = useState<string[]>([]);
  const [promptWizardError, setPromptWizardError] = useState<string | null>(null);
  const [isMultiModelModalOpen, setIsMultiModelModalOpen] = useState(false);
  const [selectedAutoModelIds, setSelectedAutoModelIds] = useState<string[]>([]);
  const [cancellingPendingJobIds, setCancellingPendingJobIds] = useState<Record<string, boolean>>({});
  const [extendModal, setExtendModal] = useState<ExtendModalState | null>(null);
  const [extendAlignmentFrame, setExtendAlignmentFrame] = useState("");
  const [extendAnchorFramesFromEnd, setExtendAnchorFramesFromEnd] = useState("5");
  const [extendDurationSeconds, setExtendDurationSeconds] = useState("");
  const [extendPrompt, setExtendPrompt] = useState("");
  const [extendContinueToRangeEnd, setExtendContinueToRangeEnd] = useState(false);
  const [clipLengthenDirection, setClipLengthenDirection] = useState<"start" | "end">("end");
  const [clipLengthenModel, setClipLengthenModel] = useState("ltx-2.3-pro");
  const [clipLengthenDurationSeconds, setClipLengthenDurationSeconds] = useState("6");
  const [clipLengthenPrompt, setClipLengthenPrompt] = useState("");
  const lastSavedRunRef = useRef<string | null>(null);
  const promptDraftRunIdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const audioReferenceInputRef = useRef<HTMLInputElement | null>(null);
  const isPreparingChunkPlan = Boolean(generateChunkedSegmentMutation.isPending);
  const canStartChunkedGeneration =
    Boolean(selectedSegmentId) &&
    !generationPromptError &&
    generationInputMode === "start_video" &&
    ["ray-3.2-720p", "ray-3.2-1080p", "kling-o1", "kling-v3-omni-video", "seedance-2.0-reference-to-video", "wan2.7-videoedit"].includes(lumaModel);
  const canStartSinglePassGeneration =
    Boolean(selectedSegmentId) &&
    !selectedSegmentOverLimit &&
    !wholeVideoNeedsChunking &&
    !generationPromptError;
  const selectedGenerationIds = new Set(selectedSegmentGenerations.map((generation) => generation.genId));
  const pendingGenerationCards = pendingGenerations.filter((job) => !job.genId || !selectedGenerationIds.has(job.genId));
  const totalOutputCards = pendingGenerationCards.length + selectedSegmentGenerations.length;
  const visiblePendingGenerationCards = pendingGenerationCards.slice(0, generationCardsVisible);
  const visibleGenerationSlots = Math.max(0, generationCardsVisible - visiblePendingGenerationCards.length);
  const visibleSegmentGenerations = selectedSegmentGenerations.slice(0, visibleGenerationSlots);
  const sourceFrameCount = task?.video?.editSource?.frameCount ?? 0;
  const sourceFps = task?.video?.editSource?.fps?.den ? task.video.editSource.fps.num / task.video.editSource.fps.den : 30;
  const enabledAutoModelIds = useMemo(
    () => autoModelTestModels.filter((model) => !model.disabledReason).map((model) => model.id),
    [autoModelTestModels],
  );
  const selectedAutoModelIdsSet = useMemo(() => new Set(selectedAutoModelIds), [selectedAutoModelIds]);

  useEffect(() => {
    if (!autoModelTestSupported) {
      setIsMultiModelModalOpen(false);
      setSelectedAutoModelIds([]);
      return;
    }
    setSelectedAutoModelIds((previous) => {
      const valid = previous.filter((id) => enabledAutoModelIds.includes(id));
      if (valid.length) return valid;
      return enabledAutoModelIds;
    });
  }, [autoModelTestSupported, enabledAutoModelIds]);

  useEffect(() => {
    if (!latestChunkedRun) return;
    if (promptDraftRunIdRef.current !== latestChunkedRun.runId) {
      promptDraftRunIdRef.current = latestChunkedRun.runId;
      const seededPrompts = Object.fromEntries(
        latestChunkedRun.chunks.map((chunk) => [chunk.chunkIndex, chunk.prompt ?? ""]),
      ) as Record<number, string>;
      setChunkPromptDrafts(seededPrompts);
      return;
    }
    setChunkPromptDrafts((previous) => {
      const next = { ...previous };
      for (const chunk of latestChunkedRun.chunks) {
        if (typeof next[chunk.chunkIndex] !== "string") {
          next[chunk.chunkIndex] = chunk.prompt ?? "";
        }
      }
      return next;
    });
  }, [latestChunkedRun?.chunks, latestChunkedRun?.runId]);

  useEffect(() => {
    if (!latestChunkedRun?.runId || latestChunkedRun.saveStatus !== "complete" || !latestChunkedRun.savedGenerationId) return;
    const saveMarker = `${latestChunkedRun.runId}:${latestChunkedRun.savedGenerationId}`;
    if (lastSavedRunRef.current === saveMarker) return;
    lastSavedRunRef.current = saveMarker;
    selectSegmentGeneration(latestChunkedRun.savedGenerationId);
    setIsChunkSessionOpen(false);
  }, [latestChunkedRun?.runId, latestChunkedRun?.saveStatus, latestChunkedRun?.savedGenerationId, selectSegmentGeneration]);

  const extendModalGeneration = extendModal?.generation ?? null;
  const extendModalInputMode = extendModal?.tool === "lengthen" ? extendModal.inputMode : null;
  const clipLengthenModelOptions = useMemo(
    () => (extendModalInputMode ? CLIP_LENGTHEN_MODEL_OPTIONS[extendModalInputMode][clipLengthenDirection] : []),
    [clipLengthenDirection, extendModalInputMode],
  );
  const currentClipDurationFrames = useMemo(() => {
    if (!extendModalGeneration) return 0;
    return estimateGenerationDurationFrames(extendModalGeneration, sourceFps, selectedSegment?.durationFrames ?? 1);
  }, [extendModalGeneration, selectedSegment?.durationFrames, sourceFps]);
  const currentClipDurationSeconds = sourceFps > 0 ? currentClipDurationFrames / sourceFps : 0;
  const clipLengthenModelConfig = useMemo(() => {
    if (!extendModalInputMode) {
      return { fixedDuration: null as number | null, maxAdditionalSeconds: 0, disabledReason: null as string | null, note: null as string | null };
    }
    if (clipLengthenModel === "ltx-2.3-pro") {
      return {
        fixedDuration: null,
        maxAdditionalSeconds: 20,
        disabledReason: null,
        note:
          clipLengthenDirection === "start"
            ? "LTX can prepend new motion before the current clip."
            : "LTX can add new duration to the end of the current clip.",
      };
    }
    if (clipLengthenModel === "wan2.7-i2v") {
      if (currentClipDurationSeconds < 2 || currentClipDurationSeconds > 10) {
        return {
          fixedDuration: null,
          maxAdditionalSeconds: 0,
          disabledReason: "Wan 2.7 continuation needs the current clip to be between 2 and 10 seconds.",
          note: "Wan 2.7 continues the clip forward from the current end.",
        };
      }
      return {
        fixedDuration: null,
        maxAdditionalSeconds: Math.max(0, 15 - Math.ceil(currentClipDurationSeconds)),
        disabledReason: null,
        note: "Wan 2.7 continues the clip forward from the current end.",
      };
    }
    if (clipLengthenModel === "seedance-2.0-reference-to-video") {
      if (currentClipDurationSeconds <= 0 || currentClipDurationSeconds > 15) {
        return {
          fixedDuration: null,
          maxAdditionalSeconds: 0,
          disabledReason: "Seedance continuation needs the current clip to be 15 seconds or shorter.",
          note:
            clipLengthenDirection === "start"
              ? "Seedance can generate a clip that leads naturally into the current video and can also use the current reference images."
              : "Seedance continues from the current clip and can also use the current reference images.",
        };
      }
      return {
        fixedDuration: null,
        maxAdditionalSeconds: Math.max(0, 15 - Math.ceil(currentClipDurationSeconds)),
        disabledReason: null,
        note:
          clipLengthenDirection === "start"
            ? "Seedance can generate a clip that leads naturally into the current video and can also use the current reference images."
            : "Seedance continues from the current clip and can also use the current reference images.",
      };
    }
    if (clipLengthenModel === "veo-3.1" || clipLengthenModel === "veo-3.1-fast") {
      return {
        fixedDuration: 7,
        maxAdditionalSeconds: 7,
        disabledReason: clipLengthenDirection === "start" ? "Veo currently supports end-only extension." : null,
        note: "Veo extension adds a fixed 7 second continuation at the end.",
      };
    }
    return {
      fixedDuration: null,
      maxAdditionalSeconds: 0,
      disabledReason: "Model is not available for clip lengthening.",
      note: null,
    };
  }, [clipLengthenDirection, clipLengthenModel, currentClipDurationSeconds, extendModalInputMode]);
  const clipLengthenPromptAdvice = useMemo(() => {
    if (!extendModalInputMode) return null;
    if (clipLengthenModel === "ltx-2.3-pro") {
      return clipLengthenDirection === "start"
        ? "Prompt the motion and camera state immediately before the current clip so it can flow into the existing first frame."
        : "Prompt the action and camera movement that should continue naturally after the current last frame.";
    }
    if (clipLengthenModel === "seedance-2.0-reference-to-video") {
      return clipLengthenDirection === "start"
        ? "Describe the moment just before @Video1 and say it should transition seamlessly into @Video1 without restarting the scene."
        : "Describe what happens after @Video1 and say it should continue naturally from @Video1 without restarting the scene.";
    }
    if (clipLengthenModel === "wan2.7-i2v") {
      return "Describe the next beat after the current clip and keep the motion/camera continuation explicit.";
    }
    if (clipLengthenModel === "veo-3.1" || clipLengthenModel === "veo-3.1-fast") {
      return "Describe the next 7 seconds after the current clip and keep the continuation of motion and camera explicit.";
    }
    return null;
  }, [clipLengthenDirection, clipLengthenModel, extendModalInputMode]);
  const parsedAlignmentFrame = Number(extendAlignmentFrame);
  const parsedAnchorFramesFromEnd = Number(extendAnchorFramesFromEnd);
  const parsedDurationSeconds = extendDurationSeconds.trim() ? Number(extendDurationSeconds) : undefined;
  const extendDurationIsValid =
    extendContinueToRangeEnd ||
    parsedDurationSeconds === undefined ||
    (Number.isInteger(parsedDurationSeconds) && parsedDurationSeconds >= 1 && parsedDurationSeconds <= 15);
  const canSubmitExtension =
    extendModal?.tool === "extend" &&
    Boolean(extendModalGeneration) &&
    Number.isInteger(parsedAlignmentFrame) &&
    parsedAlignmentFrame >= 0 &&
    (sourceFrameCount <= 0 || parsedAlignmentFrame < sourceFrameCount) &&
    Number.isInteger(parsedAnchorFramesFromEnd) &&
    parsedAnchorFramesFromEnd >= 1 &&
    parsedAnchorFramesFromEnd <= 60 &&
    extendDurationIsValid;
  const parsedClipLengthenDuration = clipLengthenModelConfig.fixedDuration ?? Number(clipLengthenDurationSeconds);
  const clipLengthenDurationIsValid =
    clipLengthenModelConfig.fixedDuration != null
      ? true
      : Number.isInteger(parsedClipLengthenDuration) &&
        parsedClipLengthenDuration >= 1 &&
        parsedClipLengthenDuration <= clipLengthenModelConfig.maxAdditionalSeconds;
  const canSubmitClipLengthen =
    extendModal?.tool === "lengthen" &&
    Boolean(extendModalGeneration) &&
    clipLengthenModelOptions.some((option: { value: string; label: string }) => option.value === clipLengthenModel) &&
    !clipLengthenModelConfig.disabledReason &&
    clipLengthenDurationIsValid &&
    Boolean(clipLengthenPrompt.trim());

  useEffect(() => {
    if (!extendModalGeneration || !selectedSegment) return;
    const segmentStartFrame = selectedSegment.startFrame;
    const segmentEndFrameExclusive = selectedSegment.endFrameExclusive;
    const segmentDurationFrames = Math.max(1, selectedSegment.durationFrames);
    const estimatedGeneratedFrames = estimateGenerationDurationFrames(extendModalGeneration, sourceFps, segmentDurationFrames);
    const anchorFramesFromEndDefault = Math.min(5, Math.max(1, estimatedGeneratedFrames - 1));
    const estimatedAnchorFrameIndex = Math.max(0, estimatedGeneratedFrames - 1 - anchorFramesFromEndDefault);
    const maxSourceFrame = sourceFrameCount > 0 ? Math.max(0, sourceFrameCount - 1) : segmentEndFrameExclusive - 1;
    const defaultAlignment = Math.max(segmentStartFrame, Math.min(Math.max(segmentStartFrame, maxSourceFrame), segmentStartFrame + estimatedAnchorFrameIndex));
    const remainingFrames = sourceFrameCount > 0 ? Math.max(1, sourceFrameCount - defaultAlignment) : segmentDurationFrames;
    const maxDurationSecondsFromRemaining = Math.max(1, Math.floor(remainingFrames / Math.max(1, sourceFps)));
    const baseDurationSeconds = Math.max(1, Math.ceil(selectedSegment.durationSec ?? estimatedGeneratedFrames / Math.max(1, sourceFps)));
    const defaultDuration = Math.max(1, Math.min(Math.min(15, Math.max(1, maxDurationSecondsFromRemaining)), baseDurationSeconds));
    setExtendAlignmentFrame(String(defaultAlignment));
    setExtendAnchorFramesFromEnd(String(anchorFramesFromEndDefault));
    setExtendDurationSeconds(String(defaultDuration));
    setExtendPrompt(extendModalGeneration.luma.prompt ?? "");
    setExtendContinueToRangeEnd(false);
    setClipLengthenDirection("end");
    setClipLengthenPrompt(extendModalGeneration.luma.prompt ?? "");
    setClipLengthenDurationSeconds("6");
  }, [extendModalGeneration, selectedSegment, sourceFps, sourceFrameCount]);

  useEffect(() => {
    if (!extendModalInputMode) return;
    const fallbackModel = clipLengthenModelOptions[0]?.value ?? "ltx-2.3-pro";
    if (!clipLengthenModelOptions.some((option: { value: string; label: string }) => option.value === clipLengthenModel)) {
      setClipLengthenModel(fallbackModel);
      return;
    }
    if (clipLengthenModelConfig.fixedDuration != null) {
      const fixedValue = String(clipLengthenModelConfig.fixedDuration);
      if (clipLengthenDurationSeconds !== fixedValue) {
        setClipLengthenDurationSeconds(fixedValue);
      }
      return;
    }
    if (!clipLengthenDurationSeconds.trim()) {
      setClipLengthenDurationSeconds(String(Math.min(6, Math.max(1, clipLengthenModelConfig.maxAdditionalSeconds || 1))));
      return;
    }
    const numeric = Number(clipLengthenDurationSeconds);
    if (!Number.isFinite(numeric) || numeric < 1) {
      setClipLengthenDurationSeconds("1");
      return;
    }
    if (clipLengthenModelConfig.maxAdditionalSeconds > 0 && numeric > clipLengthenModelConfig.maxAdditionalSeconds) {
      setClipLengthenDurationSeconds(String(clipLengthenModelConfig.maxAdditionalSeconds));
    }
  }, [clipLengthenDurationSeconds, clipLengthenModel, clipLengthenModelConfig.fixedDuration, clipLengthenModelConfig.maxAdditionalSeconds, clipLengthenModelOptions, extendModalInputMode]);

  function openExtendModal(generation: SegmentGeneration) {
    if (selectedPreviewGeneration?.genId !== generation.genId) {
      selectSegmentGeneration(generation.genId);
    }
    if (generationInputMode === "start_video") {
      setExtendModal({ tool: "extend", generation });
      return;
    }
    if (generationInputMode === "start_end" || generationInputMode === "edit_video") {
      setExtendModal({ tool: "lengthen", generation, inputMode: generationInputMode });
    }
  }

  function submitExtensionFromGenerate() {
    if (!canSubmitExtension || !extendModalGeneration) return;
    extendGeneration({
      generationId: extendModalGeneration.genId,
      alignmentFrameIndex: parsedAlignmentFrame,
      anchorFramesFromEnd: parsedAnchorFramesFromEnd,
      durationSeconds: extendContinueToRangeEnd ? undefined : parsedDurationSeconds,
      prompt: extendPrompt.trim() || undefined,
      inputMode: generationInputMode,
      continueToRangeEnd: extendContinueToRangeEnd,
      useSourceLastFrame: false,
      lastFrameVariantId: undefined,
    });
  }

  function submitClipLengthenFromGenerate() {
    if (!canSubmitClipLengthen || !extendModalGeneration || !extendModalInputMode) return;
    lengthenGeneration({
      generationId: extendModalGeneration.genId,
      model: clipLengthenModel,
      direction: clipLengthenDirection,
      durationSeconds: clipLengthenModelConfig.fixedDuration ?? Number(clipLengthenDurationSeconds),
      prompt: clipLengthenPrompt.trim(),
      inputMode: extendModalInputMode,
      selectedReferenceIds: extendModalInputMode === "edit_video" ? editVideoSelectedReferenceIds.slice(0, 9) : [],
    });
  }

  function triggerDirectDownload(url: string, filename?: string) {
    const link = document.createElement("a");
    link.href = url;
    if (filename) link.download = filename;
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function handleManualGeneratedVideoUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setManualUploadPending(true);
    setManualUploadError(null);
    try {
      await uploadManualGeneratedVideo(file);
    } catch (error) {
      setManualUploadError(error instanceof Error ? error.message : "Failed to upload generated video");
    } finally {
      setManualUploadPending(false);
    }
  }

  async function handleAudioReferenceUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAudioReferenceUploadPending(true);
    setAudioReferenceUploadError(null);
    try {
      await uploadGenerationAudioReference(file);
    } catch (error) {
      setAudioReferenceUploadError(error instanceof Error ? error.message : "Failed to upload audio reference");
    } finally {
      setAudioReferenceUploadPending(false);
    }
  }

  async function handlePromptWizardClick() {
    setPromptWizardAdvice(null);
    setPromptWizardWarnings([]);
    setPromptWizardError(null);
    if (!lumaPrompt.trim()) {
      setPromptWizardError("Write a draft prompt first, then use the Prompt Wizard to improve it.");
      return;
    }
    if (!promptWizardSupported) {
      setPromptWizardError("Prompt Wizard is currently available for start-video, start/end, and edit-video modes.");
      return;
    }
    try {
      const result = await improvePromptWithWizard();
      setPromptWizardAdvice(result.userAdvice || null);
      setPromptWizardWarnings(result.warnings);
    } catch {
      setPromptWizardError("Couldn’t improve the prompt. Your original prompt has not been changed.");
    }
  }

  function MagicWandIcon() {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20 20 4" />
        <path d="m14 4 1.2-2.2L16.4 4l2.2 1.2L16.4 6.4 15.2 8l-1.2-1.6L11.8 5.2 14 4Z" />
        <path d="m5 13 .8-1.5L6.6 13l1.5.8-1.5.8L5.8 16l-.8-1.4L3.6 13.8 5 13Z" />
      </svg>
    );
  }

  return (
    <div className="space-y-4">
      <input ref={uploadInputRef} type="file" accept="video/*" className="hidden" onChange={(event) => void handleManualGeneratedVideoUpload(event)} />
      <input ref={audioReferenceInputRef} type="file" accept="audio/*" className="hidden" onChange={(event) => void handleAudioReferenceUpload(event)} />
      <div className="rounded-xl border border-ink/15 bg-white">
        <div className="grid gap-3 p-3 lg:grid-cols-[1.65fr_1fr]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!originalSegmentPreviewUrl}
                onClick={() => {
                  if (!originalSegmentPreviewUrl) return;
                  triggerDirectDownload(originalSegmentPreviewUrl);
                }}
              >
                Download Source Video
              </button>
              <button
                type="button"
                className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedSegmentId || manualUploadPending}
                onClick={() => uploadInputRef.current?.click()}
              >
                <PendingButtonLabel isPending={manualUploadPending} idle="Upload Generated Video" pending="Uploading video..." />
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <select
                value={lumaModel}
                onChange={(e) => {
                  const nextModel = e.target.value as VideoModel;
                  setGenerationModelByInput((previous) => ({ ...previous, [generationInputMode]: nextModel }));
                }}
                className="rounded-md border border-ink/20 px-3 py-2"
              >
                {generationModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {lumaModel === "ray-3.2-720p" || lumaModel === "ray-3.2-1080p" ? (
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
              ) : lumaModel === "kling-o1" ? (
                <select
                  value={replicateKlingMode}
                  onChange={(e) => setReplicateKlingMode(e.target.value as ReplicateKlingModeId)}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="std">Kling mode: std</option>
                  <option value="pro">Kling mode: pro</option>
                </select>
              ) : lumaModel === "kling-v3-omni-video" ? (
                <select
                  value={replicateKlingV3Mode}
                  onChange={(e) => setReplicateKlingV3Mode(e.target.value as ReplicateKlingV3ModeId)}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="standard">Kling mode: standard</option>
                  <option value="pro">Kling mode: pro</option>
                </select>
              ) : lumaModel === "wan2.7-videoedit" || lumaModel === "wan2.7-i2v" ? (
                <select
                  value={wan27Resolution}
                  onChange={(e) => setWan27Resolution(e.target.value as Wan27ResolutionId)}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="720p">Resolution: 720p</option>
                  <option value="1080p">Resolution: 1080p</option>
                </select>
              ) : lumaModel === "happy-horse-video-edit" || lumaModel === "happy-horse-image-to-video" ? (
                <select
                  value={happyHorseResolution}
                  onChange={(e) => setHappyHorseResolution(e.target.value as HappyHorseResolutionId)}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="720p">Resolution: 720p</option>
                  <option value="1080p">Resolution: 1080p</option>
                </select>
              ) : lumaModel === "sora-2-image-to-video" ? (
                <select
                  value={sora2Resolution}
                  onChange={(e) => setSora2Resolution(e.target.value as Sora2ResolutionId)}
                  className="rounded-md border border-ink/20 px-3 py-2"
                >
                  <option value="auto">Resolution: auto</option>
                  <option value="720p">Resolution: 720p</option>
                  <option value="1080p">Resolution: 1080p</option>
                </select>
              ) : (
                <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                  Extra mode controls are only used by selected models.
                </div>
              )}
            </div>
            {lumaModel === "wan2.2-animate" ? (
              <div className="rounded-md border border-ink/20 bg-bg px-3 py-2 text-xs text-ink/60">
                Text prompt is unavailable for Wan2.2 Animate in this flow. Generation uses the selected start frame plus motion from the current working range.
              </div>
            ) : (
              <div className="space-y-3">
                {generationInputMode === "edit_video" && editVideoReferenceWarning ? (
                  <StatusNotice variant="warning">
                    <p className="text-xs">{editVideoReferenceWarning}</p>
                  </StatusNotice>
                ) : null}
                <label className="block space-y-1">
                  <span className="flex items-center justify-between gap-2 text-xs font-medium text-ink/75">
                    <span>Opening prompt</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {generationInputMode === "edit_video" ? (
                        <>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md border border-ink/20 bg-white px-2 py-1 text-[11px] text-ink/75"
                            onClick={openEditVideoReferencePicker}
                          >
                            Add / edit reference images
                          </button>
                          {supportsGenerationAudioReference ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded-md border border-ink/20 bg-white px-2 py-1 text-[11px] text-ink/75 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={audioReferenceUploadPending}
                              onClick={() => audioReferenceInputRef.current?.click()}
                            >
                              <PendingButtonLabel
                                isPending={audioReferenceUploadPending}
                                idle={generationAudioReference ? "Replace audio reference" : "Add audio reference"}
                                pending="Uploading audio..."
                              />
                            </button>
                          ) : null}
                        </>
                      ) : null}
                      <button
                        type="button"
                        title="Improve prompt"
                        aria-label="Improve prompt with Prompt Wizard"
                        className="inline-flex items-center gap-1 rounded-md border border-ink/20 bg-white px-2 py-1 text-[11px] text-ink/75 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={isPromptWizardPending || !promptWizardSupported}
                        onClick={() => void handlePromptWizardClick()}
                      >
                        {isPromptWizardPending ? <Spinner className="h-3 w-3" /> : <MagicWandIcon />}
                        <span>Improve</span>
                      </button>
                    </div>
                  </span>
                  <textarea
                    value={lumaPrompt}
                    onChange={(e) => setLumaPrompt(e.target.value)}
                    placeholder={generationPromptPlaceholder}
                    className="h-20 w-full rounded-md border border-ink/20 p-2"
                  />
                  {generationInputMode === "edit_video" ? (
                    <p className="text-[11px] text-ink/60">
                      If using reference images, describe their purpose in the prompt in the order they appear above.
                      {supportsGenerationAudioReference
                        ? ` ${generationAudioReference ? "Use @Audio1 to reference the uploaded audio file." : "You can also upload one audio reference and call it @Audio1 in the prompt."}`
                        : ""}
                    </p>
                  ) : null}
                </label>
                {promptWizardAdvice ? (
                  <StatusNotice variant="info">
                    <p className="text-xs">{promptWizardAdvice}</p>
                  </StatusNotice>
                ) : null}
                {promptWizardWarnings.length ? (
                  <StatusNotice variant="warning">
                    <div className="space-y-1">
                      {promptWizardWarnings.map((warning) => (
                        <p key={warning} className="text-xs">
                          {warning}
                        </p>
                      ))}
                    </div>
                  </StatusNotice>
                ) : null}
                {promptWizardError ? (
                  <StatusNotice variant="warning">
                    <p className="text-xs">{promptWizardError}</p>
                  </StatusNotice>
                ) : null}
                {lumaModel === "wan2.7-i2v" ? (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink/75">Negative prompt (optional)</span>
                    <textarea
                      value={wan27NegativePrompt}
                      onChange={(e) => setWan27NegativePrompt(e.target.value)}
                      placeholder="Optional. Describe content or artifacts to avoid."
                      className="h-16 w-full rounded-md border border-ink/20 p-2"
                    />
                  </label>
                ) : null}
                {wholeVideoNeedsChunking ? (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink/75">Continuation prompt for later chunks (optional)</span>
                    <textarea
                      value={lumaContinuationPrompt}
                      onChange={(e) => setLumaContinuationPrompt(e.target.value)}
                      placeholder="Optional. If left blank, later chunks reuse the opening prompt. Use this to soften the edit once the transformation is established."
                      className="h-20 w-full rounded-md border border-ink/20 p-2"
                    />
                  </label>
                ) : null}
              </div>
            )}
            {generationPromptError ? (
              <StatusNotice variant="error">
                <p className="text-xs">{generationPromptError}</p>
              </StatusNotice>
            ) : null}
            {missingRouteInputsMessage ? (
              <StatusNotice variant="warning">
                <p className="text-xs">{missingRouteInputsMessage}</p>
              </StatusNotice>
            ) : null}
            {manualUploadError ? (
              <StatusNotice variant="error">
                <p className="text-xs">{manualUploadError}</p>
              </StatusNotice>
            ) : null}
            {audioReferenceUploadError ? (
              <StatusNotice variant="error">
                <p className="text-xs">{audioReferenceUploadError}</p>
              </StatusNotice>
            ) : null}
          </div>
          <div className="rounded-lg border border-ink/15 bg-bg p-3">
            <p className="text-sm font-semibold">{generationHelp.title}</p>
            <div className="mt-2 space-y-2 text-xs text-ink/70">
              {generationHelp.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            {generationInputMode === "start_video" ? (
              <label className="mt-3 flex items-start gap-3 rounded-md border border-ink/20 bg-white px-3 py-2 text-sm text-ink/80">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={preserveFrames}
                  onChange={(e) => setPreserveFrames(e.target.checked)}
                />
                <span>
                  <span className="block font-medium text-ink">Preserve source frames</span>
                  <span className="block text-xs text-ink/65">
                    Change source fps to match AI model, to avoid dropping or resampling frames, then revert fps after generation.
                  </span>
                </span>
              </label>
            ) : null}
          </div>
        </div>
      </div>

      {selectedSegmentOverLimit && selectedSegmentLimitMessage ? (
        <StatusNotice variant="warning">
          <div className="flex items-start gap-2">
            <p className="text-xs">{selectedSegmentLimitMessage}</p>
            {generationInputMode === "start_video" ? <FrameLimitInfoButton label="Frame limits for video generation" mode={generationInputMode} /> : null}
          </div>
        </StatusNotice>
      ) : null}

      {wholeVideoNeedsChunking ? (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-950">Chunked Whole-Video Generation</p>
              <p className="text-xs text-amber-900">The app will split this range into overlapping chunks and reuse the continuation prompt unless you override it in the session.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !canStartChunkedGeneration ||
                  isChunkedGenerationMutationPending
                }
                onClick={() => {
                  setIsChunkSessionOpen(true);
                  generateChunkedSegmentMutation.mutate();
                }}
              >
                <PendingButtonLabel
                  isPending={isChunkedGenerationMutationPending}
                  idle="Start Chunked Generation"
                  pending="Starting chunked generation..."
                />
              </button>
              {latestChunkedRun ? (
                <button
                  type="button"
                  className="rounded-md border border-ink/20 bg-white px-4 py-2 text-sm"
                  onClick={() => setIsChunkSessionOpen(true)}
                >
                  Open Chunk Session
                </button>
              ) : null}
            </div>
          </div>
          {isPreparingChunkPlan ? (
            <StatusNotice variant="loading" title="Preparing chunked generation">
              <p className="text-sm">Preparing chunk plan and creating the first chunk. This can take a short while before the chunk list appears.</p>
            </StatusNotice>
          ) : null}
          {generationInputMode !== "start_video" ? (
            <StatusNotice variant="warning">
              <p className="text-xs">Switch to `start frame + video` for the long-video chunked flow.</p>
            </StatusNotice>
          ) : null}
          {!["ray-3.2-720p", "ray-3.2-1080p", "kling-o1", "kling-v3-omni-video", "seedance-2.0-reference-to-video", "wan2.7-videoedit"].includes(lumaModel) ? (
            <StatusNotice variant="warning">
              <p className="text-xs">This model is not in the first chunked-release set. Use one of the first-frame + source-video models for whole-video generation.</p>
            </StatusNotice>
          ) : null}

          {latestChunkedRun ? (
            <div className="rounded-md border border-amber-300 bg-white/70 p-3 text-xs text-ink/75">
              Latest run: {latestChunkedRun.model} · {latestChunkedRun.chunks.length} chunks · status {latestChunkedRun.status.toUpperCase()}
              {latestChunkedRun.savedGenerationId ? " · stitched draft saved to grid" : ""}
            </div>
          ) : null}
        </div>
      ) : null}

      {isChunkSessionOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-5 py-4">
              <div className="space-y-1">
                <p className="text-lg font-semibold text-ink">Chunked Generation Session</p>
                <p className="text-sm text-ink/65">
                  {latestChunkedRun
                    ? `${latestChunkedRun.model} · ${latestChunkedRun.chunks.length} chunks · status ${latestChunkedRun.status.toUpperCase()}`
                    : "Preparing chunk plan and first chunk"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {latestChunkedRun ? (
                  <>
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.status !== "running" || isChunkedGenerationMutationPending}
                      onClick={() => pauseChunkedGeneration({ runId: latestChunkedRun.runId, reason: "Paused from chunk session" })}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.status !== "paused" && latestChunkedRun.status !== "failed"}
                      onClick={() => resumeChunkedGeneration({ runId: latestChunkedRun.runId })}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.status !== "complete" || latestChunkedRun.saveStatus === "queued" || latestChunkedRun.saveStatus === "running"}
                      onClick={() => saveChunkedGenerationDraft({ runId: latestChunkedRun.runId })}
                    >
                      <PendingButtonLabel
                        isPending={latestChunkedRun.saveStatus === "queued" || latestChunkedRun.saveStatus === "running"}
                        idle="Save Draft To Grid"
                        pending="Saving draft..."
                      />
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={latestChunkedRun.saveStatus === "queued" || latestChunkedRun.saveStatus === "running"}
                      onClick={() => {
                        cancelChunkedGeneration({ runId: latestChunkedRun.runId, reason: "Canceled from chunk session" });
                        setIsChunkSessionOpen(false);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : null}
                <button type="button" className="rounded-md border border-ink/20 px-3 py-2 text-sm" onClick={() => setIsChunkSessionOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div className="space-y-3 overflow-y-auto px-5 py-4">
              {!latestChunkedRun ? (
                <StatusNotice variant="loading" title="Preparing chunk session" className="px-4 py-5">
                  <p className="text-sm">Preparing the chunk plan and queuing the first chunk. This can take a short while before the timeline appears.</p>
                </StatusNotice>
              ) : (
                <>
                  <StatusNotice variant="info" title="Chunk session output">
                    <p className="text-sm">Save only creates one stitched draft video back in Outputs. Individual chunks stay inside this session.</p>
                  </StatusNotice>
                  {latestChunkedRun.saveError ? (
                    <StatusNotice variant="error">
                      <p className="text-sm">Save failed: {latestChunkedRun.saveError}</p>
                    </StatusNotice>
                  ) : null}
                  <div className="overflow-x-auto pb-2">
                    <div className="flex min-w-max gap-4">
                      {latestChunkedRun.chunks.map((chunk) => {
                        const anchorUrl = frameVariantImageUrl(chunk.anchorFrameId, chunk.anchorVariantId);
                        const chunkGeneration = chunk.generationId ? task?.segmentGenerations?.[chunk.generationId] ?? null : null;
                        const chunkThumbnail = chunkGeneration ? generationThumbnailUrl(chunkGeneration) : null;
                        const promptValue = chunkPromptDrafts[chunk.chunkIndex] ?? chunk.prompt ?? "";
                        const providerInputTiming = chunkGeneration?.generationSettings?.providerInputTiming ?? null;
                        const storedOutputTiming = chunkGeneration?.generationSettings?.storedOutput ?? null;
                        const sourceClipLabel =
                          providerInputTiming?.fps && providerInputTiming?.durationSec
                            ? `${providerInputTiming.fps.num}/${providerInputTiming.fps.den} fps · ${providerInputTiming.durationSec.toFixed?.(2) ?? providerInputTiming.durationSec}s`
                            : null;
                        const storedClipLabel =
                          storedOutputTiming?.fps && storedOutputTiming?.durationSec
                            ? `${storedOutputTiming.fps.num}/${storedOutputTiming.fps.den} fps · ${storedOutputTiming.durationSec.toFixed?.(2) ?? storedOutputTiming.durationSec}s`
                            : null;
                        return (
                          <div
                            key={`${latestChunkedRun.runId}-${chunk.chunkIndex}`}
                            className="flex w-[320px] shrink-0 flex-col rounded-xl border border-ink/15 bg-white p-4"
                          >
                            <div className="mb-3 flex items-start justify-between gap-3">
                              <p className="text-sm font-semibold text-ink">
                                Chunk {chunk.chunkIndex + 1} (f{chunk.segmentStartFrame} - f{Math.max(chunk.segmentStartFrame, chunk.segmentEndFrameExclusive - 1)})
                              </p>
                              <span className="rounded-full bg-bg px-2 py-1 text-[11px] uppercase tracking-wide text-ink/60">{chunk.status}</span>
                            </div>
                            {chunk.coverageStartFrame != null && chunk.coverageEndFrameExclusive != null ? (
                              <p className="mb-2 text-xs text-ink/60">
                                Keeps f{chunk.coverageStartFrame} - f{Math.max(chunk.coverageStartFrame, chunk.coverageEndFrameExclusive - 1)}
                              </p>
                            ) : null}
                            {chunk.actualOutputStartFrame != null ? (
                              <p className="mb-2 text-xs text-ink/55">Returned video appears to start at source f{chunk.actualOutputStartFrame}</p>
                            ) : null}
                        {anchorUrl ? (
                              <img src={anchorUrl} alt={`Chunk ${chunk.chunkIndex + 1} anchor`} className="aspect-video w-full rounded-md bg-bg object-contain" loading="lazy" decoding="async" />
                            ) : (
                              <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/55">
                                Anchor frame pending
                              </div>
                            )}
                            <label className="mt-3 block space-y-1">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/55">Prompt</span>
                              <textarea
                                value={promptValue}
                                onChange={(e) =>
                                  setChunkPromptDrafts((previous) => ({ ...previous, [chunk.chunkIndex]: e.target.value }))
                                }
                                className="h-28 w-full rounded-md border border-ink/15 p-2 text-sm"
                              />
                            </label>
                            {sourceClipLabel || storedClipLabel ? (
                              <div className="mt-3 rounded-md border border-ink/10 bg-bg p-2">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink/55">Prepared clip timing</p>
                              <div className="mt-2 space-y-1 text-[11px] text-ink/60">
                                {sourceClipLabel ? <p>Prepared input: {sourceClipLabel}</p> : null}
                                {storedClipLabel ? <p>Stored output: {storedClipLabel}</p> : null}
                              </div>
                              </div>
                            ) : null}
                            <div className="mt-3 rounded-md border border-ink/10 bg-bg p-2">
                              {chunkGeneration?.downloadUrl ? (
                                <>
                                  {chunkThumbnail ? (
                                    <img
                                      src={chunkThumbnail}
                                      alt={`Chunk ${chunk.chunkIndex + 1} generated preview`}
                                      className="aspect-video w-full rounded-md bg-white object-contain"
                                      loading="lazy"
                                      decoding="async"
                                      onError={(event) => onAssetError(event.currentTarget.currentSrc || event.currentTarget.src)}
                                    />
                                  ) : (
                                    <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-ink/20 bg-white text-xs text-ink/55">
                                      Video thumbnail unavailable
                                    </div>
                                  )}
                                  <div className="mt-2 flex items-center gap-2">
                                    <IconActionButton
                                      title="Preview chunk"
                                      onClick={() =>
                                        setVideoPreviewModal({
                                          url: chunkGeneration.downloadUrl as string,
                                          label: `Chunk ${chunk.chunkIndex + 1} · ${chunkGeneration.luma.model}`,
                                        })
                                      }
                                    >
                                      <PreviewIcon />
                                    </IconActionButton>
                                    <IconActionButton href={chunkGeneration.downloadUrl} download title="Download chunk">
                                      <DownloadIcon />
                                    </IconActionButton>
                                    <button
                                      type="button"
                                      className="ml-auto rounded-md border border-ink/20 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                                      disabled={isChunkedGenerationMutationPending}
                                      onClick={() =>
                                        restartChunkedGeneration({
                                          runId: latestChunkedRun.runId,
                                          fromChunkIndex: chunk.chunkIndex,
                                          prompt: promptValue.trim() || undefined,
                                        })
                                      }
                                    >
                                      Restart From Here
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <div className="space-y-2">
                                  <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-ink/20 bg-white text-xs text-ink/55">
                                    {chunk.status === "failed"
                                      ? "No output was produced for this chunk."
                                      : chunk.status === "complete"
                                        ? "Preview URLs are still being prepared."
                                        : "Generated video will appear here when this chunk completes."}
                                  </div>
                                  <button
                                    type="button"
                                    className="w-full rounded-md border border-ink/20 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={isChunkedGenerationMutationPending}
                                    onClick={() =>
                                      restartChunkedGeneration({
                                        runId: latestChunkedRun.runId,
                                        fromChunkIndex: chunk.chunkIndex,
                                        prompt: promptValue.trim() || undefined,
                                      })
                                    }
                                  >
                                    Restart From Here
                                  </button>
                                </div>
                              )}
                            </div>
                            {chunk.error ? (
                              <div className="mt-2">
                                <StatusNotice variant="error">
                                  <p className="text-xs">{chunk.error}</p>
                                </StatusNotice>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-md bg-accent px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canStartSinglePassGeneration || Boolean(generateSegmentMutation.isPending)}
          onClick={() => generateSegmentMutation.mutate()}
        >
          <PendingButtonLabel
            isPending={Boolean(generateSegmentMutation.isPending)}
            idle="Generate Output"
            pending="Starting generation..."
          />
        </button>
        {autoModelTestSupported ? (
          <button
            type="button"
            className="rounded-md border border-accent bg-white px-4 py-2 text-sm text-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isAutoModelTestRunning}
            onClick={() => setIsMultiModelModalOpen(true)}
          >
            <PendingButtonLabel
              isPending={isAutoModelTestRunning}
              idle="Multi model generate"
              pending="Running multi model..."
            />
          </button>
        ) : null}
      </div>

      {autoModelTestError ? (
        <StatusNotice variant="error">
          <p className="text-xs">{autoModelTestError}</p>
        </StatusNotice>
      ) : null}

      <div className="space-y-2 rounded-lg border border-ink/10 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">Generated outputs</p>
            <p className="text-xs text-ink/60">
              Select the output to carry forward. Use the compare action on any thumbnail to open source vs output review.
            </p>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visiblePendingGenerationCards.map((job) => (
            <div
              key={`pending-${job.jobId}`}
              className={`rounded border p-2 ${job.status === "failed" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1 uppercase text-ink/70">
                  {job.status === "queued" || job.status === "running" ? <Spinner className="h-3 w-3" /> : null}
                  {job.status}
                </span>
                <span className="text-[11px] text-ink/50">{job.progress}%</span>
              </div>
              <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-ink/20 bg-white text-xs text-ink/60">
                Generated output pending
              </div>
              <p className="mt-2 text-xs font-medium text-ink/80">
                {job.model} / {job.mode}
              </p>
              <p className="text-[11px] text-ink/60">{formatCompactTimestamp(job.updatedAt ?? job.createdAt)}</p>
              {job.error ? (
                <p className="mt-1 line-clamp-3 text-[11px] text-red-700" title={job.error}>
                  {job.error}
                </p>
              ) : null}
              <div className="mt-2 flex items-center gap-2">
                <button type="button" className="rounded border border-ink/20 bg-white px-3 py-2 text-xs text-ink/60" disabled>
                  Waiting...
                </button>
                <IconActionButton
                  title={job.status === "failed" ? "Remove failed placeholder" : "Cancel job"}
                  tone="danger"
                  disabled={Boolean(cancellingPendingJobIds[job.jobId])}
                  onClick={() => {
                    if (job.status === "failed") {
                      void removeFailedPendingGenerationJob({ jobId: job.jobId, genId: job.genId });
                      return;
                    }
                    setCancellingPendingJobIds((previous) => ({ ...previous, [job.jobId]: true }));
                    void requestCancelPendingGenerationJob(job.jobId).finally(() => {
                      setCancellingPendingJobIds((previous) => {
                        const next = { ...previous };
                        delete next[job.jobId];
                        return next;
                      });
                    });
                  }}
                >
                  <DeleteIcon />
                </IconActionButton>
              </div>
            </div>
          ))}
          {visibleSegmentGenerations.map((gen, index) => {
              const isSelected = selectedPreviewGeneration?.genId === gen.genId;
              const thumbnailUrl = generationThumbnailUrl(gen);
              const copyablePrompt = gen.luma.prompt?.trim() ?? "";
              return (
            <div
              key={gen.genId}
              className={`rounded border p-2 ${
                gen.status === "failed"
                  ? "border-red-200 bg-red-50"
                  : isSelected
                    ? "border-teal-500 bg-teal-50"
                    : "border-ink/10"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                {gen.status === "complete" ? (
                  <button
                    type="button"
                    className={`rounded border px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
                      isSelected ? "border-teal-500 bg-teal-50 text-ink" : "border-ink/20 bg-white text-ink"
                    }`}
                    disabled={!gen.downloadUrl}
                    onClick={() => selectSegmentGeneration(gen.genId)}
                  >
                    {isSelected ? "Selected" : "Select"}
                  </button>
                ) : (
                  <span className={`uppercase text-ink/60 ${index === 0 ? "font-semibold" : ""}`}>{gen.status}</span>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-ink/50">{truncateIdentifier(gen.genId, 14)}</span>
                </div>
              </div>
              <button
                type="button"
                className="block w-full disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!gen.downloadUrl}
                onClick={() => selectSegmentGeneration(gen.genId)}
                title={gen.downloadUrl ? `Use ${describeGeneration(gen)}` : "Video unavailable"}
              >
                {thumbnailUrl ? (
                  <img
                    src={thumbnailUrl}
                    alt={describeGeneration(gen)}
                    className="aspect-video w-full rounded-md bg-bg object-contain"
                    loading="lazy"
                    decoding="async"
                    onError={(event) => onAssetError(event.currentTarget.currentSrc || event.currentTarget.src)}
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-ink/20 bg-bg text-xs text-ink/60">
                    {gen.downloadUrl ? "Video thumbnail unavailable" : "Video unavailable"}
                  </div>
                )}
              </button>
              <p className="mt-2 text-xs font-medium text-ink/80">{gen.luma.model} / {gen.luma.mode}</p>
              {gen.manualUpload ? <p className="text-[11px] text-teal-700">Manual upload</p> : null}
              <p className="text-[11px] text-ink/60">{formatCompactTimestamp(gen.finishedAt ?? gen.createdAt)}</p>
              {gen.status === "failed" && gen.error ? (
                <p className="mt-1 line-clamp-3 text-[11px] text-red-700" title={gen.error}>
                  {gen.error}
                </p>
              ) : null}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded border border-ink/20 bg-white px-3 py-2 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!gen.downloadUrl}
                  onClick={() => openExtendModal(gen)}
                >
                  Extend
                </button>
                <IconActionButton
                  title="Preview"
                  disabled={!gen.downloadUrl}
                  onClick={() => {
                    if (!gen.downloadUrl) return;
                    setVideoPreviewModal({
                      url: gen.downloadUrl,
                      label: describeGeneration(gen),
                      taskId: task?.taskId,
                      generationId: gen.genId,
                    });
                  }}
                >
                  <PreviewIcon />
                </IconActionButton>
                <IconActionButton
                  title={!originalSegmentCompareUrl || !gen.downloadUrl ? "Compare is unavailable until both source and output previews are ready" : "Compare against source"}
                  disabled={!originalSegmentCompareUrl || !gen.downloadUrl}
                  onClick={() => {
                    if (!originalSegmentCompareUrl || !gen.downloadUrl) return;
                    const originalUrl = originalSegmentCompareUrl;
                    const segmentStartPosterUrl = selectedSegment ? task?.frames?.[selectedSegment.startFrameId]?.imageUrl ?? null : null;
                    setVideoCompareModal({
                      originalUrl,
                      compareUrl: gen.downloadUrl,
                      label: describeGeneration(gen),
                      posterUrl: generationThumbnailUrl(gen),
                      originalPosterUrl: segmentStartPosterUrl,
                      segmentStartSec: segmentWindow?.startSec,
                      originalIsSegmentClip: originalPreviewIsSegmentClip,
                      originalSegmentId: selectedSegmentId ?? undefined,
                      compareGenerationId: gen.genId,
                      preferGenerationInputMediaAsOriginal: false,
                    });
                  }}
                >
                  <CompareIcon />
                </IconActionButton>
                {gen.downloadUrl ? (
                  <IconActionButton href={gen.downloadUrl} download title="Download full quality video">
                    <DownloadIcon />
                  </IconActionButton>
                ) : null}
                {copyablePrompt ? (
                  <IconActionButton title="Copy prompt" onClick={() => void copyTextToClipboard(copyablePrompt)}>
                    <CopyIcon />
                  </IconActionButton>
                ) : null}
                <IconActionButton
                  title="Delete output"
                  tone="danger"
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
                  <DeleteIcon />
                </IconActionButton>
              </div>
            </div>
              );
            }
          )}
        </div>
        {isMultiModelModalOpen ? (
          <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/60 p-4" onClick={() => setIsMultiModelModalOpen(false)}>
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
                <div>
                  <p className="text-lg font-semibold text-ink">Multi model generate</p>
                  <p className="text-sm text-ink/65">
                    Select which eligible models to run sequentially with the current working range, references, and prompt.
                  </p>
                </div>
                <button type="button" className="rounded-md border border-ink/20 px-3 py-2 text-sm" onClick={() => setIsMultiModelModalOpen(false)}>
                  Cancel
                </button>
              </div>
              <div className="space-y-4 px-5 py-4">
                <div className="space-y-2">
                  {autoModelTestModels.map((model) => (
                    <label
                      key={model.id}
                      className={`flex items-start gap-3 rounded-lg border px-3 py-3 ${
                        model.disabledReason ? "border-ink/10 bg-bg/60 text-ink/45" : "border-ink/15 bg-white text-ink"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border border-ink/25"
                        checked={selectedAutoModelIdsSet.has(model.id)}
                        disabled={Boolean(model.disabledReason) || isAutoModelTestRunning}
                        onChange={(event) => {
                          setSelectedAutoModelIds((previous) =>
                            event.target.checked
                              ? previous.includes(model.id)
                                ? previous
                                : [...previous, model.id]
                              : previous.filter((value) => value !== model.id),
                          );
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{model.label}</span>
                        {model.disabledReason ? <span className="mt-1 block text-xs text-red-700">{model.disabledReason}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
                {autoModelTestWarning ? (
                  <StatusNotice variant="warning">
                    <p className="text-xs">{autoModelTestWarning}</p>
                  </StatusNotice>
                ) : null}
                {autoModelTestError ? (
                  <StatusNotice variant="error">
                    <p className="text-xs">{autoModelTestError}</p>
                  </StatusNotice>
                ) : null}
                <div className="flex items-center justify-end gap-2 border-t border-ink/10 pt-4">
                  <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={() => setIsMultiModelModalOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={Boolean(autoModelTestWarning) || !selectedAutoModelIds.length || isAutoModelTestRunning}
                    onClick={() => {
                      void runAutoModelTest(selectedAutoModelIds);
                      setIsMultiModelModalOpen(false);
                    }}
                  >
                    <PendingButtonLabel
                      isPending={isAutoModelTestRunning}
                      idle="Generate all"
                      pending="Running multi model..."
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {extendModal ? (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-3xl rounded-2xl bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
                <div>
                  <p className="text-lg font-semibold text-ink">
                    {extendModal.tool === "extend" ? "Extend generation" : "Lengthen clip"}
                  </p>
                  <p className="text-sm text-ink/65">
                    {extendModal.tool === "extend"
                      ? "Continue from this generated clip to cover more of the current working range."
                      : "Add duration to this generated clip from either the end or the start."}
                  </p>
                </div>
                <button type="button" className="rounded-md border border-ink/20 px-3 py-2 text-sm" onClick={() => setExtendModal(null)}>
                  Close
                </button>
              </div>
              <div className="space-y-4 px-5 py-4">
                <div className="rounded-md border border-ink/10 bg-bg p-3 text-xs text-ink/70">
                  <p className="font-medium text-ink/85">{describeGeneration(extendModal.generation)}</p>
                  {selectedSegment ? <p className="mt-1">Current working range: {describeSegment(selectedSegment)}</p> : null}
                  <p className="mt-1">Current clip length: {currentClipDurationSeconds.toFixed(2)}s</p>
                </div>
                {extendModal.tool === "extend" ? (
                  <>
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="space-y-1 text-sm">
                        <span className="block font-medium">Alignment source frame</span>
                        <input
                          type="number"
                          min={0}
                          max={Math.max(0, sourceFrameCount - 1)}
                          className="w-full rounded-md border border-ink/20 px-2 py-2"
                          value={extendAlignmentFrame}
                          onChange={(event) => setExtendAlignmentFrame(event.target.value)}
                        />
                      </label>
                      <label className="space-y-1 text-sm">
                        <span className="block font-medium">Anchor offset from end</span>
                        <input
                          type="number"
                          min={1}
                          max={60}
                          className="w-full rounded-md border border-ink/20 px-2 py-2"
                          value={extendAnchorFramesFromEnd}
                          onChange={(event) => setExtendAnchorFramesFromEnd(event.target.value)}
                        />
                      </label>
                      <label className="space-y-1 text-sm">
                        <span className="block font-medium">Next range seconds</span>
                        <input
                          type="number"
                          min={1}
                          max={15}
                          className="w-full rounded-md border border-ink/20 px-2 py-2 disabled:bg-ink/5 disabled:text-ink/50"
                          value={extendDurationSeconds}
                          onChange={(event) => setExtendDurationSeconds(event.target.value)}
                          disabled={extendContinueToRangeEnd}
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-ink/80">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border border-ink/25"
                        checked={extendContinueToRangeEnd}
                        onChange={(event) => setExtendContinueToRangeEnd(event.target.checked)}
                      />
                      Continue to end of working range
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span className="font-medium">Prompt for next continuation</span>
                      <textarea
                        rows={4}
                        className="w-full rounded-md border border-ink/20 px-2 py-2"
                        value={extendPrompt}
                        onChange={(event) => setExtendPrompt(event.target.value)}
                      />
                    </label>
                    {extendGenerationError ? (
                      <StatusNotice variant="error">
                        <p className="text-xs">{extendGenerationError}</p>
                      </StatusNotice>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={() => setExtendModal(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="rounded bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!canSubmitExtension || isExtendingGeneration}
                        onClick={() => {
                          submitExtensionFromGenerate();
                          setExtendModal(null);
                        }}
                      >
                        <PendingButtonLabel isPending={isExtendingGeneration} idle="Queue next continuation" pending="Queueing continuation..." />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="space-y-1 text-sm">
                        <span className="block font-medium">Extend</span>
                        <select
                          className="w-full rounded-md border border-ink/20 px-2 py-2"
                          value={clipLengthenDirection}
                          onChange={(event) => setClipLengthenDirection(event.target.value as "start" | "end")}
                        >
                          <option value="end">End</option>
                          <option value="start">Start</option>
                        </select>
                      </label>
                      <label className="space-y-1 text-sm">
                        <span className="block font-medium">Model</span>
                        <select
                          className="w-full rounded-md border border-ink/20 px-2 py-2"
                          value={clipLengthenModel}
                          onChange={(event) => setClipLengthenModel(event.target.value)}
                        >
                          {clipLengthenModelOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1 text-sm">
                        <span className="block font-medium">Add seconds</span>
                        <input
                          type="number"
                          min={1}
                          max={Math.max(1, clipLengthenModelConfig.maxAdditionalSeconds)}
                          className="w-full rounded-md border border-ink/20 px-2 py-2 disabled:bg-ink/5 disabled:text-ink/50"
                          value={clipLengthenDurationSeconds}
                          onChange={(event) => setClipLengthenDurationSeconds(event.target.value)}
                          disabled={clipLengthenModelConfig.fixedDuration != null}
                        />
                      </label>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_280px]">
                      <label className="block space-y-1 text-sm">
                        <span className="font-medium">Prompt</span>
                        <textarea
                          rows={4}
                          className="w-full rounded-md border border-ink/20 px-2 py-2"
                          value={clipLengthenPrompt}
                          onChange={(event) => setClipLengthenPrompt(event.target.value)}
                        />
                      </label>
                      <div className="rounded-md border border-ink/10 bg-bg p-3 text-xs text-ink/70">
                        <p className="font-medium text-ink/85">Prompt advice</p>
                        <p className="mt-1">{clipLengthenPromptAdvice ?? "Describe the continuation clearly in relation to the current clip."}</p>
                      </div>
                    </div>
                    {clipLengthenModelConfig.note ? <p className="text-xs text-ink/60">{clipLengthenModelConfig.note}</p> : null}
                    {extendModalInputMode === "edit_video" ? (
                      <p className="text-xs text-ink/60">
                        Current reference images will be sent in the same order shown above when the selected model supports them.
                      </p>
                    ) : null}
                    {clipLengthenModelConfig.disabledReason ? (
                      <StatusNotice variant="warning">
                        <p className="text-xs">{clipLengthenModelConfig.disabledReason}</p>
                      </StatusNotice>
                    ) : null}
                    {lengthenGenerationError ? (
                      <StatusNotice variant="error">
                        <p className="text-xs">{lengthenGenerationError}</p>
                      </StatusNotice>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <button type="button" className="rounded-md border border-ink/20 px-4 py-2 text-sm" onClick={() => setExtendModal(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="rounded bg-accent2 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!canSubmitClipLengthen || isLengtheningGeneration}
                        onClick={() => {
                          submitClipLengthenFromGenerate();
                          setExtendModal(null);
                        }}
                      >
                        <PendingButtonLabel isPending={isLengtheningGeneration} idle="Queue clip extension" pending="Queueing clip extension..." />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null}
        {generationCardsVisible < totalOutputCards ? (
          <button className="text-sm text-accent underline" onClick={() => setGenerationCardsVisible((count) => count + 6)}>
            More...
          </button>
        ) : null}
        {totalOutputCards === 0 ? <p className="text-sm text-ink/60">No generated outputs for this working range yet.</p> : null}
        {nextWarning ? (
          <StatusNotice variant="warning">
            <p className="text-xs">{nextWarning}</p>
          </StatusNotice>
        ) : null}
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={nextDisabled}
            onClick={onNext}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";

import type { SegmentRecord, TaskDetail } from "../types/api";

function fpsValue(task: TaskDetail | undefined): number {
  const fps = task?.video?.editSource?.fps;
  if (!fps || !fps.den) return 30;
  return fps.num / fps.den;
}

type SegmentWindow = {
  startSec: number;
  endSec: number;
  startLabel: string;
  endLabel: string;
};

type UseSelectedSegmentPreviewArgs = {
  selectedSegment: SegmentRecord | null;
  task: TaskDetail | undefined;
};

export function useSelectedSegmentPreview({ selectedSegment, task }: UseSelectedSegmentPreviewArgs) {
  const segmentWindow = useMemo<SegmentWindow | null>(() => {
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
    if (selectedSegment?.segmentClipUrl) return selectedSegment.segmentClipUrl;
    if (!task?.video?.editSource?.downloadUrl) return null;
    return task.video.editSource.downloadUrl;
  }, [selectedSegment?.segmentClipUrl, task?.video?.editSource?.downloadUrl]);

  const originalSegmentPreviewIdentity = useMemo(() => {
    if (selectedSegment?.segmentClipKey) return `segment:${selectedSegment.segmentClipKey}`;
    if (!task?.video?.editSource?.s3Key || !segmentWindow) return null;
    return `edit:${task.video.editSource.s3Key}:${segmentWindow.startSec.toFixed(3)}:${segmentWindow.endSec.toFixed(3)}`;
  }, [selectedSegment?.segmentClipKey, segmentWindow, task?.video?.editSource?.s3Key]);

  const originalPreviewIsSegmentClip = Boolean(selectedSegment?.segmentClipUrl);
  const [stableOriginalSegmentPreviewUrl, setStableOriginalSegmentPreviewUrl] = useState<string | null>(null);
  const stableOriginalSegmentPreviewIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    if (!originalSegmentPreviewUrl || !originalSegmentPreviewIdentity) {
      stableOriginalSegmentPreviewIdentityRef.current = null;
      setStableOriginalSegmentPreviewUrl(null);
      return;
    }
    if (
      stableOriginalSegmentPreviewIdentityRef.current !== originalSegmentPreviewIdentity ||
      !stableOriginalSegmentPreviewUrl
    ) {
      stableOriginalSegmentPreviewIdentityRef.current = originalSegmentPreviewIdentity;
      setStableOriginalSegmentPreviewUrl(originalSegmentPreviewUrl);
    }
  }, [originalSegmentPreviewIdentity, originalSegmentPreviewUrl, stableOriginalSegmentPreviewUrl]);

  return {
    segmentWindow,
    originalPreviewIsSegmentClip,
    stableOriginalSegmentPreviewUrl,
  };
}

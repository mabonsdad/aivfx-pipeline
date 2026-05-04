import { useEffect, useMemo } from "react";
import type { NavigateFunction } from "react-router-dom";

export type TabId = "timeline" | "frames" | "refine" | "generate" | "outputs" | "merge" | "assets" | "asset_library" | "report" | "custom_qc" | "api_logs";
export type ReportView = "frames" | "videos" | "reports";

export type WorkflowRouteState = {
  taskId: string | null;
  tab: TabId | null;
};

export const TAB_ROUTE_SEGMENT: Record<TabId, string> = {
  timeline: "pick-frame",
  frames: "edit-frame",
  refine: "refine-frames",
  generate: "generate-video",
  outputs: "outputs",
  merge: "merge-video",
  assets: "download-assets",
  asset_library: "asset-library",
  report: "reports",
  custom_qc: "custom-qc",
  api_logs: "api-logs",
};

export const ROUTE_SEGMENT_TO_TAB: Record<string, TabId> = {
  "pick-frame": "timeline",
  "edit-frame": "frames",
  "refine-frames": "refine",
  "generate-video": "generate",
  outputs: "outputs",
  "merge-video": "merge",
  "download-assets": "assets",
  "asset-library": "asset_library",
  reports: "report",
  "custom-qc": "custom_qc",
  "api-logs": "api_logs",
};

export function taskRoute(taskId: string, tab: TabId): string {
  return `/tasks/${encodeURIComponent(taskId)}/${TAB_ROUTE_SEGMENT[tab]}`;
}

export function useWorkflowRouteState(pathname: string): WorkflowRouteState {
  return useMemo(() => {
    const normalizedPath = pathname.replace(/\/+$/, "") || "/";
    const parts = normalizedPath.split("/").filter(Boolean);
    if (parts[0] === "tasks") {
      const taskId = parts[1] ? decodeURIComponent(parts[1]) : null;
      const tabFromRoute = parts[2] ? ROUTE_SEGMENT_TO_TAB[parts[2]] ?? null : null;
      return { taskId, tab: tabFromRoute };
    }
    const directTab = parts[0] ? ROUTE_SEGMENT_TO_TAB[parts[0]] ?? null : null;
    return { taskId: null, tab: directTab };
  }, [pathname]);
}

export function useReportRouteState(search: string): {
  routeSearch: URLSearchParams;
  reportView: ReportView;
  activeCustomReportId: string | null;
} {
  const routeSearch = useMemo(() => new URLSearchParams(search), [search]);
  const reportViewParam = routeSearch.get("view");
  const reportView: ReportView =
    reportViewParam === "frames" || reportViewParam === "videos" || reportViewParam === "reports"
      ? reportViewParam
      : reportViewParam === "qc_frame"
        ? "frames"
        : reportViewParam === "qc_video"
          ? "videos"
          : "reports";
  const activeCustomReportId = routeSearch.get("reportId");
  return { routeSearch, reportView, activeCustomReportId };
}

export function useCanonicalTaskRoute(params: {
  isAuthed: boolean;
  routeState: WorkflowRouteState;
  storeSelectedTaskId: string | null;
  taskIds: string[];
  locationPathname: string;
  locationSearch: string;
  navigate: NavigateFunction;
  setSelectedTaskId: (taskId: string | null) => void;
}): void {
  const {
    isAuthed,
    routeState,
    storeSelectedTaskId,
    taskIds,
    locationPathname,
    locationSearch,
    navigate,
    setSelectedTaskId,
  } = params;

  useEffect(() => {
    if (!isAuthed) return;
    const fallbackTaskId = routeState.taskId ?? storeSelectedTaskId ?? taskIds[0] ?? null;
    if (!fallbackTaskId) return;
    if (storeSelectedTaskId !== fallbackTaskId) {
      setSelectedTaskId(fallbackTaskId);
    }
    const desiredTab = routeState.tab ?? "timeline";
    const normalizedPath = locationPathname.replace(/\/+$/, "") || "/";
    const expectedPath = taskRoute(fallbackTaskId, desiredTab);
    if (normalizedPath !== expectedPath) {
      navigate(
        {
          pathname: expectedPath,
          search: desiredTab === "report" ? locationSearch : "",
        },
        { replace: normalizedPath === "/" },
      );
    }
  }, [
    isAuthed,
    locationPathname,
    locationSearch,
    navigate,
    routeState.tab,
    routeState.taskId,
    setSelectedTaskId,
    storeSelectedTaskId,
    taskIds,
  ]);
}

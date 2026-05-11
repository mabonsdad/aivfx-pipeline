import { useEffect, useMemo } from "react";
import type { NavigateFunction } from "react-router-dom";

export type TabId =
  | "timeline"
  | "frames"
  | "refine"
  | "generate"
  | "outputs"
  | "merge"
  | "assets"
  | "asset_library"
  | "report"
  | "custom_qc"
  | "api_logs"
  | "admin";
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
  admin: "admin",
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
  admin: "admin",
};

export function taskRoute(taskId: string, tab: TabId): string {
  return `/tasks/${encodeURIComponent(taskId)}/${TAB_ROUTE_SEGMENT[tab]}`;
}

function parseRouteStateFromPath(candidatePath: string): WorkflowRouteState {
  const normalizedPath = candidatePath.replace(/\/+$/, "") || "/";
  const parts = normalizedPath.split("/").filter(Boolean);
  const tasksIndex = parts.findIndex((part) => part === "tasks");
  if (tasksIndex >= 0) {
    const taskId = parts[tasksIndex + 1] ? decodeURIComponent(parts[tasksIndex + 1]) : null;
    const tabFromRoute = parts[tasksIndex + 2] ? ROUTE_SEGMENT_TO_TAB[parts[tasksIndex + 2]] ?? null : null;
    return { taskId, tab: tabFromRoute };
  }
  const directTab = parts[0] ? ROUTE_SEGMENT_TO_TAB[parts[0]] ?? null : null;
  return { taskId: null, tab: directTab };
}

function extractHashPath(hash: string): string | null {
  if (!hash) return null;
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!stripped.startsWith("/")) return null;
  return stripped.split("?")[0] ?? null;
}

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function useWorkflowRouteState(pathname: string, hash = ""): WorkflowRouteState {
  return useMemo(() => {
    const fromPathname = parseRouteStateFromPath(pathname);
    if (fromPathname.taskId || fromPathname.tab) {
      return fromPathname;
    }
    const hashPath = extractHashPath(hash);
    if (hashPath) {
      return parseRouteStateFromPath(hashPath);
    }
    return fromPathname;
  }, [hash, pathname]);
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
  locationHash: string;
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
    locationHash,
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
    const hashPath = extractHashPath(locationHash);
    const normalizedCurrentPath = normalizedPath(locationPathname);
    const normalizedHashPath = hashPath ? normalizedPath(hashPath) : null;
    const normalizedPathnameLooksRouted = normalizedCurrentPath.includes("/tasks/") || normalizedCurrentPath.split("/").filter(Boolean)[0] in ROUTE_SEGMENT_TO_TAB;
    const currentPath = normalizedPathnameLooksRouted ? normalizedCurrentPath : normalizedHashPath ?? normalizedCurrentPath;
    const expectedPath = taskRoute(fallbackTaskId, desiredTab);
    if (currentPath !== expectedPath) {
      navigate(
        {
          pathname: expectedPath,
          search: desiredTab === "report" ? locationSearch : "",
        },
        { replace: currentPath === "/" },
      );
    }
  }, [
    isAuthed,
    locationHash,
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

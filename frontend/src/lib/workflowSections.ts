export type PrimaryWorkflowSection = "source" | "create" | "outputs" | "post" | "reports" | "assets";

export const PRIMARY_WORKFLOW_TABS: Array<{ id: PrimaryWorkflowSection; label: string }> = [
  { id: "source", label: "Select" },
  { id: "create", label: "Edit" },
  { id: "outputs", label: "Generate" },
  { id: "post", label: "Post Process" },
  { id: "assets", label: "Assets" },
  { id: "reports", label: "Reports" },
];

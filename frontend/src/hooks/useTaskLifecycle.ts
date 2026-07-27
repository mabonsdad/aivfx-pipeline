import { useMemo, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { apiClient } from "../api/client";
import { DEFAULT_TASK_WORKFLOW_ID, isPrevizWorkflowId, type TaskWorkflowId } from "../lib/taskWorkflows";
import { normalizeTaskNameInput } from "../lib/sourceMedia";
import type { TabId } from "./useWorkflowRouting";

export type NewTaskStage = "idle" | "creating" | "error";

type UseTaskLifecycleParams = {
  existingTaskNames: string[];
  queryClient: QueryClient;
  setSelectedTaskId: (taskId: string | null) => void;
  setTab: (nextTab: TabId, taskIdOverride?: string | null, replace?: boolean) => void;
};

export function useTaskLifecycle({
  existingTaskNames,
  queryClient,
  setSelectedTaskId,
  setTab,
}: UseTaskLifecycleParams) {
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("new_task");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskWorkflowId, setNewTaskWorkflowId] = useState<TaskWorkflowId>(DEFAULT_TASK_WORKFLOW_ID);
  const [newTaskStage, setNewTaskStage] = useState<NewTaskStage>("idle");
  const [newTaskError, setNewTaskError] = useState<string | null>(null);

  const normalizedNewTaskName = useMemo(() => normalizeTaskNameInput(newTaskName), [newTaskName]);
  const taskNameAlreadyExists = useMemo(() => {
    const target = normalizedNewTaskName.toLowerCase();
    if (!target) return false;
    return existingTaskNames.some((name) => name.toLowerCase() === target);
  }, [existingTaskNames, normalizedNewTaskName]);

  const showTaskNameExistsWarning = taskNameAlreadyExists && newTaskStage !== "creating";

  function openNewTaskModal(workflowId: TaskWorkflowId = DEFAULT_TASK_WORKFLOW_ID) {
    setNewTaskName(isPrevizWorkflowId(workflowId) ? "new_scene" : "new_task");
    setNewTaskDescription("");
    setNewTaskWorkflowId(workflowId);
    setNewTaskStage("idle");
    setNewTaskError(null);
    setIsNewTaskModalOpen(true);
  }

  async function handleCreateTask(): Promise<void> {
    if (!newTaskName.trim()) return;
    try {
      setNewTaskError(null);
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
      if (!newTaskDescription.trim()) {
        setNewTaskStage("error");
        setNewTaskError("Add a description before creating the task.");
        return;
      }

      setNewTaskStage("creating");
      setNewTaskName(normalizedTaskName);
      const created = await apiClient.createTask(normalizedTaskName, newTaskWorkflowId, {
        description: newTaskDescription.trim(),
      });
      setSelectedTaskId(created.taskId);
      setTab("timeline", created.taskId, true);
      setNewTaskStage("idle");
      setNewTaskError(null);
      setIsNewTaskModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["task", created.taskId] });
    } catch (error) {
      setNewTaskStage("error");
      setNewTaskError(error instanceof Error ? error.message : "Task creation failed");
    }
  }

  return {
    isNewTaskModalOpen,
    setIsNewTaskModalOpen,
    newTaskName,
    setNewTaskName,
    newTaskDescription,
    setNewTaskDescription,
    newTaskWorkflowId,
    newTaskStage,
    newTaskError,
    normalizedNewTaskName,
    taskNameAlreadyExists,
    showTaskNameExistsWarning,
    openNewTaskModal,
    handleCreateTask,
  };
}

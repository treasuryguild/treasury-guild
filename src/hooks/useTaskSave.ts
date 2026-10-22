"use client";

// Saving the task editor (TaskModal) — shared by the board and Payday.
// Assignees go through the service-role route (authorizes, registers
// contributors, refuses settled/archived tasks) before any RLS write. A
// GitHub task's issue edit goes to /api/github/issue first (it pushes to
// GitHub and re-syncs); when that edit un-imports the task there is nothing
// left to save here.
import { apiFetch } from "@/lib/api/client";
import type { GithubIssueUpdateResponse, TaskAssigneesResponse } from "@/lib/api/types";
import { browserClient } from "@/lib/supabase/browser";
import type { TaskSaveFields } from "@/components/board/TaskModal";
import { useAsyncAction } from "./useAsyncAction";

export function throwOn(res: { error: { message: string } | null }, what: string) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
}

/** Persist a TaskModal save: GitHub edit + assignees via the API, remaining fields via RLS. */
export async function saveTaskFields(taskId: string, fields: TaskSaveFields): Promise<void> {
  const { assignees, github, ...taskFields } = fields;
  if (github) {
    const result = await apiFetch<GithubIssueUpdateResponse>("/api/github/issue", {
      body: { kind: "task", taskId, ...github },
    });
    if (result.missingAmountFields.length > 0) {
      throw new Error(
        `GitHub project has no bounty field named ${result.missingAmountFields.join(", ")} — the rest of the edit was saved to GitHub`,
      );
    }
    if (result.taskRemoved) return;
  }
  await apiFetch<TaskAssigneesResponse>("/api/tasks/assignees", {
    body: { taskId, assignees },
  });
  if (Object.keys(taskFields).length > 0) {
    throwOn(
      await browserClient().from("tasks").update(taskFields).eq("id", taskId).select("id").single(),
      "save task",
    );
  }
}

/** Task editor save with its own busy/error state; `reload` runs after success. */
export function useTaskSave(reload: () => void) {
  const action = useAsyncAction("Task update failed");

  async function saveTask(task: { id: string }, fields: TaskSaveFields): Promise<boolean> {
    const ok = await action.run(async () => {
      await saveTaskFields(task.id, fields);
      reload();
      return true;
    });
    return !!ok;
  }

  return { saveTask, busy: action.busy, error: action.error };
}

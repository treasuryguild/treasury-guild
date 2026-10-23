"use client";

// Loads assignable GitHub logins and project number field names for the
// in-app issue editor (TaskModal / GithubItemModal).
import { apiFetch } from "@/lib/api/client";
import type { GithubEditorOptionsResponse } from "@/lib/api/types";
import { useAsyncData } from "./useAsyncData";

export type GithubEditorOptionsQuery =
  | { taskId: string }
  | { workgroupId: string; itemNodeId: string };

function optionsKey(query: GithubEditorOptionsQuery | null): string | null {
  if (!query) return null;
  if ("taskId" in query) return `task:${query.taskId}`;
  return `item:${query.workgroupId}:${query.itemNodeId}`;
}

export function useGithubEditorOptions(query: GithubEditorOptionsQuery | null) {
  return useAsyncData(optionsKey(query), async () => {
    if (!query) throw new Error("editor options query missing");
    const queryParams =
      "taskId" in query
        ? { taskId: query.taskId }
        : { workgroupId: query.workgroupId, itemNodeId: query.itemNodeId };
    return apiFetch<GithubEditorOptionsResponse>("/api/github/editor-options", { query: queryParams });
  });
}

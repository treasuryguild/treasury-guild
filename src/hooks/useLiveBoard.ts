"use client";

import { apiFetch } from "@/lib/api/client";
import type { LiveBoardResponse } from "@/lib/boardTypes";
import { useAsyncData } from "./useAsyncData";

/** Live GitHub project board(s) for a github-kind workgroup. */
export function useLiveBoard(workgroupId: string, enabled: boolean) {
  const { data, loading, error } = useAsyncData(
    enabled ? `live-board:${workgroupId}` : null,
    () =>
      apiFetch<LiveBoardResponse>("/api/github/board", {
        query: { workgroupId },
      }),
  );
  return {
    boards: data?.boards ?? null,
    hasRepos: data?.hasRepos ?? null,
    partial: !!data?.partial,
    loading,
    error: error ? "Live board unavailable" : null,
  };
}

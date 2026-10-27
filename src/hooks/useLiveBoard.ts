"use client";

import { useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api/client";
import type { LiveBoardResponse } from "@/lib/boardTypes";
import { useAsyncData } from "./useAsyncData";

/** Live GitHub project board(s) for a github-kind workgroup. */
export function useLiveBoard(workgroupId: string, enabled: boolean) {
  // An explicit reload (after an in-app edit) asks the route to bypass its
  // 60-second board cache; the automatic first load uses it.
  const freshRef = useRef(false);
  const { data, loading, error, reload: reloadData } = useAsyncData(
    enabled ? `live-board:${workgroupId}` : null,
    () => {
      const fresh = freshRef.current;
      freshRef.current = false;
      return apiFetch<LiveBoardResponse>("/api/github/board", {
        query: { workgroupId, ...(fresh ? { fresh: 1 } : {}) },
      });
    },
  );
  const reload = useCallback(() => {
    freshRef.current = true;
    reloadData();
  }, [reloadData]);
  return {
    boards: data?.boards ?? null,
    hasRepos: data?.hasRepos ?? null,
    repos: data?.repos ?? [],
    partial: !!data?.partial,
    loading,
    error: error ? "Live board unavailable" : null,
    reload,
  };
}

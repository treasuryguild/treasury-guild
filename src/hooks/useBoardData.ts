"use client";

import { BOARD_TASK_COLUMNS, type BoardColumnRow } from "@/lib/db/types";
import type { BoardTask } from "@/lib/boardTypes";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData } from "./useAsyncData";

export interface BoardWorkgroup {
  name: string;
  description: string | null;
  kind: string;
  treasury_id: string | null;
  archived_at: string | null;
}

export interface BoardData {
  workgroup: BoardWorkgroup | null;
  columns: BoardColumnRow[];
  tasks: BoardTask[];
}

/** Workgroup header, kanban columns and tasks for one board. */
export function useBoardData(workgroupId: string, enabled: boolean) {
  const state = useAsyncData(enabled ? workgroupId : null, async () => {
    const db = browserClient();
    const results = await Promise.all([
      db
        .from("workgroups")
        .select("name, description, kind, treasury_id, archived_at")
        .eq("id", workgroupId)
        .maybeSingle(),
      db
        .from("board_columns")
        .select("*")
        .eq("workgroup_id", workgroupId)
        .order("position"),
      db
        .from("tasks")
        .select(BOARD_TASK_COLUMNS)
        .eq("workgroup_id", workgroupId)
        .order("created_at"),
    ]);
    for (const result of results) if (result.error) throw new Error(result.error.message);
    const [{ data: wg }, { data: cols }, { data: taskRows }] = results;
    return {
      workgroup: (wg as BoardWorkgroup | null) ?? null,
      columns: (cols ?? []) as BoardColumnRow[],
      // supabase-js infers the many-to-one contributors embed as an array;
      // PostgREST returns one object (or null) per assignee row.
      tasks: (taskRows ?? []) as unknown as BoardTask[],
    } satisfies BoardData;
  });
  return {
    workgroup: state.data?.workgroup ?? null,
    columns: state.data?.columns ?? [],
    tasks: state.data?.tasks ?? [],
    loaded: state.data !== null,
    error: state.error,
    reload: state.reload,
  };
}

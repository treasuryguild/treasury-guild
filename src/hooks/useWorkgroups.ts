"use client";

import { browserClient } from "@/lib/supabase/browser";
import type { WorkgroupRow } from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export type WorkgroupSummary = Pick<
  WorkgroupRow,
  "id" | "name" | "kind" | "treasury_id" | "archived_at"
>;

export type WorkgroupDetails = WorkgroupSummary & Pick<WorkgroupRow, "description">;

/** The community's workgroups. */
export function useWorkgroups(
  communityId: string | null | undefined,
  includeArchived = false,
): AsyncData<WorkgroupDetails[]> {
  return useAsyncData(communityId ? `${communityId}:${includeArchived}` : null, async () => {
    let query = browserClient()
      .from("workgroups")
      .select("id, name, description, kind, treasury_id, archived_at")
      .eq("community_id", communityId)
      .order("created_at");
    if (!includeArchived) query = query.is("archived_at", null);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as WorkgroupDetails[];
  });
}

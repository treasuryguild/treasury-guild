"use client";

import { browserClient } from "@/lib/supabase/browser";
import {
  TREASURY_SUMMARY_COLUMNS,
  type TreasurySummary,
} from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** Treasuries that can be chosen for a new payout, payment, mint or anchor. */
export function activeTreasuries<T extends { archived_at?: string | null }>(
  list: readonly T[] | null | undefined,
): T[] {
  return (list ?? []).filter((t) => !t.archived_at);
}

/** The community's treasuries, archived ones included (RLS-visible). */
export function useTreasuries(
  communityId: string | null | undefined,
): AsyncData<TreasurySummary[]> {
  return useAsyncData(communityId, async () => {
    const { data, error } = await browserClient()
      .from("treasuries")
      .select(TREASURY_SUMMARY_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []) as TreasurySummary[];
  });
}

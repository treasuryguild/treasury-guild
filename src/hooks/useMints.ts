"use client";

import { browserClient } from "@/lib/supabase/browser";
import { MINT_LIST_COLUMNS, type MintWithTx } from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

const MINT_LIST_LIMIT = 100;

/** Minted assets of the community, newest first. */
export function useMints(
  communityId: string | null | undefined,
): AsyncData<MintWithTx[]> {
  return useAsyncData(communityId, async () => {
    const { data } = await browserClient()
      .from("mints")
      .select(MINT_LIST_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at", { ascending: false })
      .limit(MINT_LIST_LIMIT);
    return (data ?? []) as unknown as MintWithTx[];
  });
}

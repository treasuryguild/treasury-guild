"use client";

import { browserClient } from "@/lib/supabase/browser";
import { FLOAT_WALLET_COLUMNS, type FloatWalletRow } from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** Float wallets that can receive a transfer (not archived). */
export function activeFloatWallets(
  list: readonly FloatWalletRow[] | null | undefined,
): FloatWalletRow[] {
  return (list ?? []).filter((f) => !f.archived_at);
}

/** The community's float wallets, archived ones included (RLS-visible). */
export function useFloatWallets(
  communityId: string | null | undefined,
): AsyncData<FloatWalletRow[]> {
  return useAsyncData(communityId, async () => {
    const { data, error } = await browserClient()
      .from("float_wallets")
      .select(FLOAT_WALLET_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []) as FloatWalletRow[];
  });
}

"use client";

import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData } from "./useAsyncData";
import { fetchWalletAssets } from "./useWalletAssets";

/**
 * Token tickers held by the paying wallet(s), for the bounty dropdown: the
 * routed treasury when the workgroup is assigned to one, otherwise every
 * community treasury (any of them may pay). Best-effort per address.
 */
export function useTreasuryTokenTickers(
  communityId: string | null | undefined,
  treasuryId: string | null,
  enabled: boolean,
): string[] {
  const key = enabled && communityId ? `${communityId}:${treasuryId ?? "*"}` : null;
  const { data } = useAsyncData(key, async () => {
    const { data: treasuries } = await browserClient()
      .from("treasuries")
      .select("id, address")
      .eq("community_id", communityId);
    const addresses = (treasuries ?? [])
      .filter((t) => !treasuryId || t.id === treasuryId)
      .map((t) => t.address as string);
    const results = await Promise.allSettled(addresses.map(fetchWalletAssets));
    const byLower = new Map<string, string>();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const t of r.value.tokens) {
        if (t.ticker && !byLower.has(t.ticker.toLowerCase())) {
          byLower.set(t.ticker.toLowerCase(), t.ticker);
        }
      }
    }
    return [...byLower.values()].sort();
  });
  return data ?? [];
}

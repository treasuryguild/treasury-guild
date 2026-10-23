"use client";

import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData } from "./useAsyncData";
import { fetchWalletAssets } from "./useWalletAssets";

/** A native token held by a paying treasury (for bounty field create). */
export interface TreasuryWalletToken {
  unit: string;
  ticker: string | null;
  decimals: number;
  treasuryId: string;
}

/**
 * Tokens held by the paying wallet(s): the routed treasury when the workgroup
 * is assigned to one, otherwise every community treasury (any of them may
 * pay). Best-effort per address. Dedupes by unit (first treasury wins).
 */
export function useTreasuryWalletTokens(
  communityId: string | null | undefined,
  treasuryId: string | null,
  enabled: boolean,
): TreasuryWalletToken[] {
  const key = enabled && communityId ? `${communityId}:${treasuryId ?? "*"}` : null;
  const { data } = useAsyncData(key, async () => {
    const { data: treasuries } = await browserClient()
      .from("treasuries")
      .select("id, address")
      .eq("community_id", communityId);
    const rows = (treasuries ?? []).filter((t) => !treasuryId || t.id === treasuryId);
    const results = await Promise.allSettled(
      rows.map(async (t) => {
        const assets = await fetchWalletAssets(t.address as string);
        return { treasuryId: t.id as string, tokens: assets.tokens };
      }),
    );
    const byUnit = new Map<string, TreasuryWalletToken>();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const t of r.value.tokens) {
        if (byUnit.has(t.unit)) continue;
        byUnit.set(t.unit, {
          unit: t.unit,
          ticker: t.ticker,
          decimals: t.decimals,
          treasuryId: r.value.treasuryId,
        });
      }
    }
    return [...byUnit.values()].sort((a, b) =>
      (a.ticker ?? a.unit).localeCompare(b.ticker ?? b.unit, "en"),
    );
  });
  return data ?? [];
}

/**
 * Token tickers held by the paying wallet(s), for the native bounty dropdown.
 * Sans ADA (callers prepend it). Best-effort per address.
 */
export function useTreasuryTokenTickers(
  communityId: string | null | undefined,
  treasuryId: string | null,
  enabled: boolean,
): string[] {
  const tokens = useTreasuryWalletTokens(communityId, treasuryId, enabled);
  const byLower = new Map<string, string>();
  for (const t of tokens) {
    if (!t.ticker) continue;
    if (!byLower.has(t.ticker.toLowerCase())) byLower.set(t.ticker.toLowerCase(), t.ticker);
  }
  return [...byLower.values()].sort();
}

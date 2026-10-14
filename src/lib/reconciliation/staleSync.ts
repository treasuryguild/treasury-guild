// On-visit chain sync: the Treasury and Incoming pages call
// POST /api/treasury/sync when they open. Treasuries polled less than
// CHAIN_SYNC_STALE_MS ago are skipped; the rest are claimed with one
// conditional update (Postgres row locks serialise concurrent visitors, so the
// second request matches nothing) and polled like the cron does.
//
// Deliberately poll and import only: GitHub write-backs and Discord
// announcements stay with the scheduled sweep (sweep.ts). Those stages
// select-then-stamp, so a visit run racing the cron could announce a payout
// twice. The chain import is safe here: import_chain_tx locks the external
// row, so a visit and the cron cannot both import one transaction.
import "server-only";

import { check, rows, serviceClient } from "@/lib/db/client";
import { loadCommunityTreasuries } from "@/lib/db/treasuries";
import { syncTreasury, type TreasurySyncResult } from "@/lib/reconciliation/syncTreasury";

export const CHAIN_SYNC_STALE_MS = 2 * 60_000;

// A type alias (not an interface) so the route wrapper's JSON type accepts it.
export type ChainSyncResult = {
  /** Treasury ids claimed as stale and polled this call. */
  polled: string[];
  /** Per polled treasury id; a treasury whose poll threw is absent (logged). */
  results: Record<string, TreasurySyncResult>;
  /** Latest poll time across the community's treasuries after this call. */
  lastSyncedAt: string | null;
};

/** The cut-off: cursors stamped before this are stale. */
export function staleBefore(now: Date): string {
  return new Date(now.getTime() - CHAIN_SYNC_STALE_MS).toISOString();
}

export async function syncCommunityIfStale(
  communityId: string,
  now: Date = new Date(),
): Promise<ChainSyncResult> {
  const db = serviceClient();
  const treasuries = await loadCommunityTreasuries(communityId);
  if (treasuries.length === 0) return { polled: [], results: {}, lastSyncedAt: null };
  const ids = treasuries.map((t) => t.id);

  // A treasury polled by nobody yet has no cursor row; give the claim a row to lock.
  check(
    await db
      .from("treasury_sync_cursors")
      .upsert(
        ids.map((treasury_id) => ({ treasury_id, last_block_height: 0 })),
        { onConflict: "treasury_id", ignoreDuplicates: true },
      ),
    "ensure sync cursors",
  );

  // Atomic claim: stamp the stale cursors and learn which ones this call won.
  // A failed poll keeps its stamp; the cron covers it within 15 minutes.
  const claimed = rows<{ treasury_id: string }>(
    await db
      .from("treasury_sync_cursors")
      .update({ synced_at: now.toISOString() })
      .in("treasury_id", ids)
      .or(`synced_at.is.null,synced_at.lt.${staleBefore(now)}`)
      .select("treasury_id"),
    "claim stale sync cursors",
  ).map((r) => r.treasury_id);

  const results: ChainSyncResult["results"] = {};
  for (const treasury of treasuries) {
    if (!claimed.includes(treasury.id)) continue;
    try {
      results[treasury.id] = await syncTreasury(treasury);
    } catch (err) {
      console.error(`syncTreasury ${treasury.id} failed`, err);
    }
  }

  const stamps = rows<{ synced_at: string | null }>(
    await db
      .from("treasury_sync_cursors")
      .select("synced_at")
      .in("treasury_id", ids)
      .not("synced_at", "is", null)
      .order("synced_at", { ascending: false })
      .limit(1),
    "load last sync time",
  );

  return { polled: claimed, results, lastSyncedAt: stamps[0]?.synced_at ?? null };
}

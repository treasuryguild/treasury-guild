// Mint records (one row per minted asset of a mint transaction), service role.
import "server-only";

import { check, maybe, serviceClient } from "./client";

/** A locked policy this treasury has minted under before, or null when the slot is unknown. */
export async function loadLockedPolicy(
  communityId: string,
  treasuryId: string,
  lockSlot: number,
): Promise<{ lock_until: string | null } | null> {
  return maybe<{ lock_until: string | null }>(
    await serviceClient()
      .from("mints")
      .select("lock_until")
      .eq("community_id", communityId)
      .eq("treasury_id", treasuryId)
      .eq("lock_slot", lockSlot)
      .limit(1)
      .maybeSingle(),
    "load prior locked policy",
  );
}

export async function insertMints(mints: Record<string, unknown>[]): Promise<void> {
  check(await serviceClient().from("mints").insert(mints), "insert mints");
}

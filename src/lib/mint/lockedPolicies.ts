// Locked policies previously used from a treasury that can still mint.

import type { MintWithTx } from "@/lib/db/types";
import type { LockedPolicy } from "./types";

export function lockedPoliciesFor(
  mints: Pick<MintWithTx, "treasury_id" | "policy_id" | "lock_slot" | "lock_until">[],
  treasuryId: string,
  nowMs: number,
): LockedPolicy[] {
  const seen = new Map<string, LockedPolicy>();
  for (const m of mints) {
    if (m.treasury_id !== treasuryId || m.lock_slot === null) continue;
    if (!seen.has(m.policy_id)) {
      seen.set(m.policy_id, {
        policyId: m.policy_id,
        lockSlot: Number(m.lock_slot),
        lockUntil: m.lock_until,
      });
    }
  }
  return [...seen.values()].filter(
    (p) => !p.lockUntil || Date.parse(p.lockUntil) > nowMs,
  );
}

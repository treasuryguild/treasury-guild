// Persist friendly stake labels on external_txs.activity (pool ticker /
// DRep givenName) so the Treasury list does not re-hit Koios every visit.
import "server-only";

import { isSpecialDrepId } from "@/lib/cardano/dreps";
import { lookupDrep, lookupStakePool } from "@/lib/cardano/koios";
import type { Network } from "@/lib/config";
import { StakeAction, TxKind } from "@/lib/constants";
import {
  parseExternalActivity,
  type ExternalActivity,
} from "@/lib/externalActivity";

/** True when a stake activity still needs a pool ticker and/or DRep name. */
export function stakeActivityNeedsLabels(
  activity: ExternalActivity | null | undefined,
): boolean {
  if (!activity || activity.kind !== TxKind.Stake) return false;
  if (activity.poolId?.trim() && !activity.poolTicker?.trim()) return true;
  if (
    activity.action === StakeAction.VoteDelegation &&
    activity.dRepId?.trim() &&
    !isSpecialDrepId(activity.dRepId) &&
    !activity.dRepName?.trim()
  ) {
    return true;
  }
  return false;
}

/**
 * Fill poolTicker / dRepName from Koios when missing. Best-effort: lookup
 * failures leave the ids in place. Non-stake activities are returned as-is.
 */
export async function enrichStakeActivityLabels(
  activity: ExternalActivity | null,
  network: Network,
): Promise<ExternalActivity | null> {
  if (!activity || activity.kind !== TxKind.Stake) return activity;
  if (!stakeActivityNeedsLabels(activity)) return activity;

  let next: ExternalActivity = activity;

  if (activity.poolId?.trim() && !activity.poolTicker?.trim()) {
    try {
      const ticker = (await lookupStakePool(network, activity.poolId))?.ticker?.trim() || null;
      if (ticker) next = { ...next, poolTicker: ticker };
    } catch {
      /* keep pool id */
    }
  }
  if (
    activity.action === StakeAction.VoteDelegation &&
    activity.dRepId?.trim() &&
    !isSpecialDrepId(activity.dRepId) &&
    !activity.dRepName?.trim()
  ) {
    try {
      const name = (await lookupDrep(network, activity.dRepId))?.givenName?.trim() || null;
      if (name) next = { ...next, dRepName: name };
    } catch {
      /* keep dRep id */
    }
  }

  return next;
}

/** Whether enriching changed ticker/name fields worth writing back. */
export function stakeActivityLabelsChanged(
  before: ExternalActivity | null,
  after: ExternalActivity | null,
): boolean {
  if (!after || after.kind !== TxKind.Stake) return false;
  if (!before || before.kind !== TxKind.Stake) {
    return !!(after.poolTicker?.trim() || after.dRepName?.trim());
  }
  return (
    (after.poolTicker?.trim() || "") !== (before.poolTicker?.trim() || "") ||
    (after.dRepName?.trim() || "") !== (before.dRepName?.trim() || "")
  );
}

/** Parse stored jsonb and report whether stake labels are still incomplete. */
export function storedActivityNeedsLabels(value: unknown): boolean {
  return stakeActivityNeedsLabels(parseExternalActivity(value));
}

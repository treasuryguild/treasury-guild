// Extra witness checks for stake / DRep / vote transactions: payment-path
// signed_addresses is not enough — the stake or DRep script must also reach
// its threshold among the vkey witnesses on the CBOR.
import "server-only";

import { TxKind, type SpendingPath } from "@/lib/constants";
import type { TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { buildTreasuryWallet } from "@/lib/treasury";
import { pathRule } from "./spendingPaths";
import { describeRule, thresholdReached } from "./thresholds";
import type { ScriptType } from "./types";
import { witnessKeyHashes } from "./txSignUtils";

function groupReached(scriptType: ScriptType, required: number, total: number, count: number): boolean {
  if (scriptType === "any") return count >= 1;
  if (scriptType === "all") return count >= total;
  return count >= required;
}

function roleThresholdMet(
  treasury: TreasuryRow,
  roleHashes: readonly string[],
  present: ReadonlySet<string>,
): boolean {
  const count = roleHashes.filter((h) => present.has(h.toLowerCase())).length;
  return groupReached(treasury.script_type, treasury.required, roleHashes.length, count);
}

/**
 * Whether stake/DRep script witnesses on the tx CBOR meet the treasury's
 * base rule. Payment-path signed_addresses are checked separately.
 * Returns null when the kind needs no extra check.
 */
export function scriptWitnessProblem(
  kind: string,
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
  txCbor: string,
): string | null {
  if (kind !== TxKind.Stake && kind !== TxKind.Drep && kind !== TxKind.Vote) return null;

  const { wallet } = buildTreasuryWallet(treasury, signers);
  const present = new Set(witnessKeyHashes(txCbor).map((h) => h.toLowerCase()));

  if (kind === TxKind.Stake) {
    const stakeHashes = (wallet.getKeysByRole(2) ?? []).map((k) => k.keyHash);
    if (stakeHashes.length === 0) return "This treasury has no stake keys to witness the certificate";
    if (!roleThresholdMet(treasury, stakeHashes, present)) {
      return `Not enough stake-key witnesses for the stake script (${treasury.required} of ${stakeHashes.length} under the base rule)`;
    }
    return null;
  }

  // DRep / vote: role-3 when complete, else payment key hashes (fallback).
  const drepKeys = wallet.drepEnabled()
    ? (wallet.getKeysByRole(3) ?? []).map((k) => k.keyHash)
    : (wallet.getKeysByRole(0) ?? []).map((k) => k.keyHash);
  if (drepKeys.length === 0) return "This treasury has no DRep keys to witness the certificate or vote";
  if (!roleThresholdMet(treasury, drepKeys, present)) {
    return `Not enough DRep-key witnesses for the DRep script (${treasury.required} of ${drepKeys.length} under the base rule)`;
  }
  return null;
}

/** Payment-path rule plus optional stake/DRep script witnesses. */
export function governanceReadyToSubmit(
  kind: string,
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
  spendingPath: SpendingPath,
  signedAddresses: readonly string[],
  txCbor: string,
): { ok: true } | { ok: false; reason: string } {
  const rule = pathRule(treasury, signers, spendingPath);
  if (!thresholdReached(rule, signedAddresses)) {
    return {
      ok: false,
      reason: `Not enough signatures: ${signedAddresses.length} collected, ${describeRule(rule)} required`,
    };
  }
  const problem = scriptWitnessProblem(kind, treasury, signers, txCbor);
  if (problem) return { ok: false, reason: problem };
  return { ok: true };
}

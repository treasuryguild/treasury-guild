// Pure parts of treasury polling: how much of a Koios tx landed at an
// address, and what an outgoing tx paid elsewhere. No I/O, so unit-testable.

import { addQuantity } from "@/lib/assets";
import type { KoiosTxInfo } from "@/lib/cardano/koios";
import { joinUnit } from "@/lib/cardano/units";
import { PAYOUT_METADATA_LABEL } from "@/lib/cardano/metadata";
import { isRecord } from "@/lib/guards";

type Output = KoiosTxInfo["outputs"][number];

function sumOutputs(tx: KoiosTxInfo, keep: (o: Output) => boolean): bigint {
  return tx.outputs.filter(keep).reduce((sum, o) => sum + BigInt(o.value), 0n);
}

/** Token quantities across the kept outputs, keyed by unit. Tolerates Koios
 * tiers that omit asset_list (returns null → ADA-only degradation). */
function sumAssets(
  tx: KoiosTxInfo,
  keep: (o: Output) => boolean,
): Record<string, string> | null {
  const sums = new Map<string, bigint>();
  for (const o of tx.outputs) {
    if (!keep(o)) continue;
    for (const a of o.asset_list ?? []) {
      const unit = joinUnit(a.policy_id, a.asset_name);
      addQuantity(sums, unit, BigInt(a.quantity));
    }
  }
  if (sums.size === 0) return null;
  return Object.fromEntries(
    [...sums.entries()].map(([u, q]) => [u, q.toString()]),
  );
}

export function treasuryOutputSum(tx: KoiosTxInfo, address: string): bigint {
  return sumOutputs(tx, (o) => o.payment_addr.bech32 === address);
}

export function treasuryOutputAssets(
  tx: KoiosTxInfo,
  address: string,
): Record<string, string> | null {
  return sumAssets(tx, (o) => o.payment_addr.bech32 === address);
}

/** Whether the tx is an inbound transfer (treasury not among the spenders). */
export function isIncomingTx(tx: KoiosTxInfo, address: string): boolean {
  return !tx.inputs.some((i) => i.payment_addr.bech32 === address);
}

// --- Outgoing txs: what left the treasury for other addresses ---------------

/** Lovelace paid to addresses other than the treasury (change excluded). */
export function otherOutputSum(tx: KoiosTxInfo, address: string): bigint {
  return sumOutputs(tx, (o) => o.payment_addr.bech32 !== address);
}

/** Tokens paid to addresses other than the treasury, keyed by unit. */
export function otherOutputAssets(
  tx: KoiosTxInfo,
  address: string,
): Record<string, string> | null {
  return sumAssets(tx, (o) => o.payment_addr.bech32 !== address);
}

/** Distinct recipient addresses in body order (Koios `tx_index`, not array order). */
export function otherOutputAddresses(tx: KoiosTxInfo, address: string): string[] {
  const ordered = tx.outputs
    .map((o, position) => ({ o, index: o.tx_index ?? position }))
    .sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { o } of ordered) {
    const addr = o.payment_addr.bech32;
    if (addr === address || seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/** The label-190001 payout metadata object as Koios returned it, if any. */
export function payoutMetaOf(tx: KoiosTxInfo): Record<string, unknown> | null {
  const meta = tx.metadata?.[String(PAYOUT_METADATA_LABEL)];
  return isRecord(meta) ? meta : null;
}

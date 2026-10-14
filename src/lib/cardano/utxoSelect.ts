// Pure multi-asset UTxO selection and min-UTxO estimation — no server-only
// imports so it can be unit tested.
import type { UTxO } from "@meshsdk/common";
import { addQuantity, LOVELACE } from "@/lib/assets";

/** Babbage-era coins_per_utxo_byte; parameter changes are rare and the size
 * estimator below is deliberately conservative. */
const COINS_PER_UTXO_SIZE = 4310n;

/**
 * Ledger min-UTxO for an output: (160 + serialized size) * coinsPerUtxoSize.
 * The size estimate errs high so the computed minimum is always sufficient:
 * address (57B) + CBOR overhead + coin, plus multiasset map overhead,
 * 28B per policy id, and per-asset name/quantity encoding.
 */
export function minLovelaceForOutput(
  tokens: { policies: number; assets: number; totalNameBytes: number },
  coinsPerUtxoSize: bigint = COINS_PER_UTXO_SIZE,
): bigint {
  let size = 76; // address + overhead + coin
  if (tokens.assets > 0) {
    size += 6 + tokens.policies * 30 + tokens.assets * 12 + tokens.totalNameBytes;
  }
  return (160n + BigInt(size)) * coinsPerUtxoSize;
}

function quantityOf(utxo: UTxO, unit: string): bigint {
  const asset = utxo.output.amount.find((a) => a.unit === unit);
  return asset ? BigInt(asset.quantity) : 0n;
}

function isPureAda(utxo: UTxO): boolean {
  return utxo.output.amount.every((a) => a.unit === LOVELACE);
}

/**
 * Select UTxOs covering every unit in `required`, plus `lovelaceHeadroom` of
 * extra lovelace for fees and change min-UTxO. Token units are covered
 * largest-holding-first; the lovelace top-up prefers pure-ADA UTxOs so as few
 * tokens as possible are dragged into the change output.
 *
 * Returns `shortfall: null` on success, else the missing quantity per unit.
 */
export function selectUtxos(
  utxos: UTxO[],
  required: Map<string, bigint>,
  lovelaceHeadroom: bigint,
): { selected: UTxO[]; shortfall: Map<string, bigint> | null } {
  const selected = new Set<UTxO>();
  const have = new Map<string, bigint>();
  const take = (utxo: UTxO) => {
    if (selected.has(utxo)) return;
    selected.add(utxo);
    for (const a of utxo.output.amount) {
      addQuantity(have, a.unit, BigInt(a.quantity));
    }
  };

  // 1. Cover each required token unit, largest holdings first.
  for (const [unit, needed] of required) {
    if (unit === LOVELACE) continue;
    const holders = utxos
      .filter((u) => quantityOf(u, unit) > 0n)
      .sort((a, b) => {
        const diff = quantityOf(b, unit) - quantityOf(a, unit);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      });
    for (const utxo of holders) {
      if ((have.get(unit) ?? 0n) >= needed) break;
      take(utxo);
    }
  }

  // 2. Top up lovelace, preferring pure-ADA UTxOs.
  const lovelaceNeeded = (required.get(LOVELACE) ?? 0n) + lovelaceHeadroom;
  const byLovelaceDesc = (a: UTxO, b: UTxO) => {
    const diff = quantityOf(b, LOVELACE) - quantityOf(a, LOVELACE);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  };
  const remaining = utxos.filter((u) => !selected.has(u));
  const pools = [
    remaining.filter(isPureAda).sort(byLovelaceDesc),
    remaining.filter((u) => !isPureAda(u)).sort(byLovelaceDesc),
  ];
  for (const pool of pools) {
    for (const utxo of pool) {
      if ((have.get(LOVELACE) ?? 0n) >= lovelaceNeeded) break;
      take(utxo);
    }
  }

  // 3. Verify coverage.
  const shortfall = new Map<string, bigint>();
  for (const [unit, needed] of required) {
    const target = unit === LOVELACE ? needed + lovelaceHeadroom : needed;
    const got = have.get(unit) ?? 0n;
    if (got < target) shortfall.set(unit, target - got);
  }
  if ((required.get(LOVELACE) ?? 0n) === 0n && lovelaceHeadroom > 0n) {
    // headroom applies even when no explicit lovelace is required
    const got = have.get(LOVELACE) ?? 0n;
    if (got < lovelaceHeadroom && !shortfall.has(LOVELACE)) {
      shortfall.set(LOVELACE, lovelaceHeadroom - got);
    }
  }

  return {
    selected: [...selected],
    shortfall: shortfall.size > 0 ? shortfall : null,
  };
}

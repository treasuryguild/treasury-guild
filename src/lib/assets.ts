// Asset registry helpers: map GitHub Project number-field names to on-chain
// units, and do exact decimal-string scaling (never float math on quantities).

import { DomainError } from "@/lib/errors";

export const LOVELACE = "lovelace";

export interface AssetDef {
  /** GitHub Project field name, doubles as the display ticker. */
  fieldName: string;
  /** "lovelace" or policyId(56 hex) + assetNameHex. */
  unit: string;
  decimals: number;
}

/** ADA is built in — never stored in the community_assets registry. */
export const ADA_ASSET: AssetDef = {
  fieldName: "ADA",
  unit: LOVELACE,
  decimals: 6,
};

/** Add `quantity` to the running total of `key`. */
export function addQuantity<K>(totals: Map<K, bigint>, key: K, quantity: bigint): void {
  totals.set(key, (totals.get(key) ?? 0n) + quantity);
}

/** Last-resort label of a token with no ticker, name or readable asset name ("TOKEN-3F2A1B"). */
export function tokenFallbackLabel(unit: string): string {
  return `TOKEN-${unit.slice(-6).toUpperCase()}`;
}

/**
 * Scale a decimal string to an on-chain integer quantity: "10.5" @ 8 decimals
 * -> 1050000000n. Throws on malformed input, negatives, or more fractional
 * digits than the asset supports (silent rounding would underpay).
 */
export function scaleDecimal(raw: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) throw new Error(`Invalid amount "${raw}"`);
  const [, whole, frac = ""] = m;
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${raw}" has more than ${decimals} decimal places`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Inverse of scaleDecimal, for UI and write-back: 1050000000n @ 8 -> "10.5". */
export function formatQuantity(qty: bigint, decimals: number): string {
  const s = qty.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * ADA field value -> lovelace (null when absent/zero/unscalable). Shared by
 * the GitHub sync and the native task editor so bounty_lovelace stays in
 * sync with the amounts' ADA key by identical rules. Null (never 0) when no
 * ADA — bounty_lovelace has a > 0 check constraint.
 */
export function adaLovelaceFromAmounts(
  amounts: Record<string, string> | null,
): string | null {
  if (!amounts) return null;
  const key = Object.keys(amounts).find((k) => k.toLowerCase() === "ada");
  if (!key) return null;
  try {
    const qty = scaleDecimal(String(amounts[key]), 6);
    return qty > 0n ? qty.toString() : null;
  } catch {
    // Unscalable ADA value: keep the raw amount, surface at payout build.
    return null;
  }
}

/** Case-insensitive registry lookup, including the implicit ADA asset. */
export function resolveAsset(
  registry: AssetDef[],
  fieldName: string,
): AssetDef | null {
  const lower = fieldName.toLowerCase();
  if (lower === ADA_ASSET.fieldName.toLowerCase()) return ADA_ASSET;
  return registry.find((a) => a.fieldName.toLowerCase() === lower) ?? null;
}

export class AssetResolutionError extends DomainError {
  constructor(public readonly unmappedFields: string[]) {
    super(
      `No asset mapping for field(s): ${unmappedFields.join(", ")} — connect them to a wallet token on the Payday page`,
    );
    this.name = "AssetResolutionError";
  }
}

/**
 * Resolve a task's raw field amounts to on-chain quantities per unit.
 * Falls back to bounty_lovelace when no amounts are stored (legacy rows).
 * Throws AssetResolutionError listing every unmapped field name.
 */
export function resolveTaskAmounts(
  task: {
    amounts: Record<string, string> | null;
    bounty_lovelace: string | number | null;
  },
  registry: AssetDef[],
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (task.amounts && Object.keys(task.amounts).length > 0) {
    const unmapped: string[] = [];
    for (const [field, raw] of Object.entries(task.amounts)) {
      const asset = resolveAsset(registry, field);
      if (!asset) {
        unmapped.push(field);
        continue;
      }
      const qty = scaleDecimal(String(raw), asset.decimals);
      if (qty <= 0n) continue;
      addQuantity(out, asset.unit, qty);
    }
    if (unmapped.length > 0) throw new AssetResolutionError(unmapped);
  } else if (task.bounty_lovelace) {
    out.set(LOVELACE, BigInt(task.bounty_lovelace));
  }
  return out;
}

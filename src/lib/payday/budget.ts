// Preview balance check: exact, in base units (the build route repeats it and
// is the authority).

import type { WalletAssetsResponse } from "@/lib/api/types";
import { ADA_ASSET, type AssetDef } from "@/lib/assets";
import { totalInBaseUnits, type PreviewTotal } from "./summary";

export function overBudgetFields(
  totals: Map<string, PreviewTotal>,
  wallet: WalletAssetsResponse | null,
  effective: AssetDef[],
): string[] {
  if (!wallet) return [];
  const out: string[] = [];
  const held = new Map(wallet.tokens.map((t) => [t.unit, t.quantity]));
  for (const [field, total] of totals) {
    if (field.toLowerCase() === ADA_ASSET.fieldName.toLowerCase()) {
      if (BigInt(wallet.lovelace) < totalInBaseUnits(total, ADA_ASSET.decimals)) {
        out.push(ADA_ASSET.fieldName);
      }
      continue;
    }
    const def = effective.find((a) => a.fieldName.toLowerCase() === field.toLowerCase());
    if (!def) continue; // unconnected: flagged separately
    if (BigInt(held.get(def.unit) ?? "0") < totalInBaseUnits(total, def.decimals)) out.push(field);
  }
  return out;
}

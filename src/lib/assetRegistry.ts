// Community asset registry helpers: community_assets rows <-> AssetDef list
// <-> unit display map. Client-safe; the DB loader lives in lib/db/assets.ts.

import { ADA_ASSET, LOVELACE, type AssetDef } from "@/lib/assets";
import { formatUnits, shortUnit } from "@/lib/format";

/** Display info per unit: ticker/decimals (for metadata, errors and UI). */
export type UnitDisplay = Map<string, { ticker: string; decimals: number }>;

export const COMMUNITY_ASSET_COLUMNS = "field_name, unit, decimals";

export interface CommunityAssetColumns {
  field_name: string;
  unit: string;
  decimals: number;
}

export function registryFromRows(
  rows: CommunityAssetColumns[] | null | undefined,
): AssetDef[] {
  return (rows ?? []).map((a) => ({
    fieldName: a.field_name,
    unit: a.unit,
    decimals: a.decimals,
  }));
}

/** unit -> {ticker, decimals}; ADA is always present. */
export function unitDisplayFromRegistry(registry: AssetDef[]): UnitDisplay {
  const display: UnitDisplay = new Map([
    [
      ADA_ASSET.unit,
      { ticker: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals },
    ],
  ]);
  for (const a of registry) {
    display.set(a.unit, { ticker: a.fieldName, decimals: a.decimals });
  }
  return display;
}

/**
 * Each community's unit display, loaded once per community for the life of
 * the returned function (one run of a sweep or a notification batch).
 */
export function unitDisplayLoader(
  loadRegistry: (communityId: string) => Promise<AssetDef[]>,
): (communityId: string) => Promise<UnitDisplay> {
  const displays = new Map<string, UnitDisplay>();
  return async (communityId) => {
    let display = displays.get(communityId);
    if (!display) {
      display = unitDisplayFromRegistry(await loadRegistry(communityId));
      displays.set(communityId, display);
    }
    return display;
  };
}

/** Ticker for a unit, or a compact hex fallback. */
export function unitTicker(unit: string, display: UnitDisplay): string {
  return display.get(unit)?.ticker ?? shortUnit(unit);
}

/** Payout rows (unit + base-unit amount) as ticker / decimals / quantity for messages and write-backs. */
export function payoutRowAmounts(
  rows: readonly { unit: string; amount: string }[],
  display: UnitDisplay,
): { ticker: string; decimals: number; quantity: bigint }[] {
  return rows.map((row) => ({
    ticker: unitTicker(row.unit, display),
    decimals: display.get(row.unit)?.decimals ?? 0,
    quantity: BigInt(row.amount),
  }));
}

/**
 * Exact human rendering of a quantity in a unit: "12.5 ADA", "300 HOSKY",
 * or "1234 a1b2c3d4e5f6…" (base units) when the unit is unknown.
 */
export function formatUnitAmount(
  unit: string,
  qty: bigint | string,
  display: UnitDisplay,
): string {
  const info = display.get(unit);
  if (info) return formatUnits(qty, info.decimals, info.ticker);
  if (unit === LOVELACE) return formatUnits(qty, ADA_ASSET.decimals, ADA_ASSET.fieldName);
  return `${qty.toString()} ${shortUnit(unit)}`;
}

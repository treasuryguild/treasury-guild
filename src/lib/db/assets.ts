import "server-only";

import type { AssetDef } from "@/lib/assets";
import {
  COMMUNITY_ASSET_COLUMNS,
  registryFromRows,
  type CommunityAssetColumns,
} from "@/lib/assetRegistry";
import { byteLength } from "@/lib/cardano/metadata";
import { joinUnit, splitUnit } from "@/lib/cardano/units";
import type { WalletTokenHint } from "@/lib/cardano/assetInfo";
import { check, rows, serviceClient } from "./client";

/** Persisted field-name -> unit mappings for a community. */
export async function loadAssetRegistry(
  communityId: string,
): Promise<AssetDef[]> {
  return registryFromRows(
    rows<CommunityAssetColumns>(
      await serviceClient()
        .from("community_assets")
        .select(COMMUNITY_ASSET_COLUMNS)
        .eq("community_id", communityId),
      "load asset registry",
    ),
  );
}

/** field_name column cap (bytes). */
const MAX_FIELD_NAME_BYTES = 32;

/**
 * Persist mappings a payout relied on so post-payout displays keep stable
 * tickers even after the token leaves the wallet. Later entries overwrite.
 */
export async function upsertAssetMappings(
  communityId: string,
  defs: AssetDef[],
): Promise<void> {
  const mappingRows = defs
    .filter((a) => byteLength(a.fieldName) <= MAX_FIELD_NAME_BYTES)
    .map((a) => ({
      community_id: communityId,
      field_name: a.fieldName,
      unit: a.unit,
      decimals: a.decimals,
    }));
  if (mappingRows.length === 0) return;
  check(
    await serviceClient()
      .from("community_assets")
      .upsert(mappingRows, { onConflict: "community_id,field_name" }),
    "upsert asset mappings",
  );
}

interface MintAssetHintRow {
  policy_id: string;
  asset_name_hex: string;
  asset_name: string;
  ticker: string | null;
  decimals: number;
  created_at: string;
}

/**
 * Metadata for assets minted by Guild Vault. This is an immediate fallback
 * for the short interval before a chain indexer exposes label-721 metadata.
 */
export async function loadMintAssetHints(
  units: string[],
): Promise<Map<string, WalletTokenHint>> {
  if (units.length === 0) return new Map();
  const wanted = new Set(units);
  const parts = units.map(splitUnit);
  const policyIds = [...new Set(parts.map((p) => p.policyId))];
  const assetNames = [...new Set(parts.map((p) => p.assetNameHex))];
  const result = rows<MintAssetHintRow>(
    await serviceClient()
      .from("mints")
      .select("policy_id, asset_name_hex, asset_name, ticker, decimals, created_at")
      .in("policy_id", policyIds)
      .in("asset_name_hex", assetNames)
      .order("created_at", { ascending: false }),
    "load mint asset hints",
  );
  const hints = new Map<string, WalletTokenHint>();
  for (const row of result) {
    const unit = joinUnit(row.policy_id, row.asset_name_hex);
    if (!wanted.has(unit) || hints.has(unit)) continue;
    hints.set(unit, {
      ticker: row.ticker,
      name: row.asset_name,
      decimals: row.decimals,
    });
  }
  return hints;
}

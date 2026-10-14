// Unsigned CIP-26 registry draft for a minted asset (Mint page download).

import { joinChunks } from "@/lib/cardano/cip25";
import { buildCip26Draft } from "@/lib/cardano/mintMetadata";
import { joinUnit } from "@/lib/cardano/units";
import type { MintWithTx } from "@/lib/db/types";

export function cip26DraftForMint(
  row: MintWithTx,
  fallbackDescription: string,
  logoBase64?: string,
): Record<string, unknown> {
  const meta = row.metadata ?? {};
  return buildCip26Draft({
    policyId: row.policy_id,
    assetNameHex: row.asset_name_hex,
    policyScriptCbor: row.policy_script_cbor,
    name: joinChunks(meta.name) || row.asset_name,
    description: joinChunks(meta.description) || fallbackDescription,
    ticker: row.ticker ?? undefined,
    decimals: row.decimals,
    url: joinChunks(meta.url) || undefined,
    logoBase64,
  });
}

export function cip26FileName(row: Pick<MintWithTx, "policy_id" | "asset_name_hex">): string {
  return `${joinUnit(row.policy_id, row.asset_name_hex)}.json`;
}

// Pure display helpers for a decoded transaction (signing page). Client-safe.

import { formatUnitAmount, type UnitDisplay } from "@/lib/assetRegistry";
import { formatUnits, shortUnit } from "@/lib/format";
import { ipfsToHttp } from "@/lib/ipfs";
import { cip25Entry, hexToUtf8, readCip25Fields } from "./cip25";
import type { DecodedTxMint } from "./types";

/**
 * Render an output asset: registry ticker/decimals first, then the tx's own
 * CIP-25 mint metadata (for freshly minted units), then a raw fallback.
 */
export function formatTxAsset(
  unit: string,
  quantity: string,
  display: UnitDisplay,
  mintByUnit: Map<string, DecodedTxMint>,
  cip25Meta: unknown,
): string {
  if (display.has(unit)) return formatUnitAmount(unit, quantity, display);
  const minted = mintByUnit.get(unit);
  if (minted) {
    const fields = readCip25Fields(
      cip25Entry(cip25Meta, minted.policyId, minted.assetNameHex),
    );
    const label = fields.ticker ?? hexToUtf8(minted.assetNameHex) ?? shortUnit(unit);
    return formatUnits(quantity, fields.decimals ?? 0, label);
  }
  return `${quantity} ${shortUnit(unit)}`;
}

export interface MintDescription {
  name: string;
  imageUri: string | null;
  imageUrl: string | null;
  ticker: string | null;
  description: string | null;
  burn: boolean;
  /** Human-unit amount, e.g. "1,000 GVT" or "1". */
  amount: string;
}

/** What a minted (or burned) asset looks like, from the tx's 721 metadata. */
export function describeMint(
  m: DecodedTxMint,
  cip25Meta: unknown,
  ipfsGateway: string,
): MintDescription {
  const fields = readCip25Fields(cip25Entry(cip25Meta, m.policyId, m.assetNameHex));
  const burn = m.quantity.startsWith("-");
  const magnitude = burn ? m.quantity.slice(1) : m.quantity;
  return {
    name: fields.name ?? hexToUtf8(m.assetNameHex) ?? m.assetNameHex,
    imageUri: fields.image,
    imageUrl: fields.image ? ipfsToHttp(fields.image, ipfsGateway) : null,
    ticker: fields.ticker,
    description: fields.description,
    burn,
    amount: formatUnits(magnitude, fields.decimals ?? 0, fields.ticker ?? undefined),
  };
}

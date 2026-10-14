// Discover the tokens a treasury wallet actually holds and describe them
// from on-chain / registry metadata. Server-only (Koios has no CORS); the
// browser goes through /api/chain/wallet-assets.
import "server-only";

import type { Network } from "@/lib/config";
import { getProvider } from "@/lib/cardano/provider";
import { assetInfoBulk, type KoiosAssetInfo } from "@/lib/cardano/koios";
import {
  tokenFromAssetInfo,
  type WalletToken,
} from "@/lib/cardano/assetInfo";
import { addQuantity, LOVELACE } from "@/lib/assets";

export type { WalletToken };

// Token metadata is effectively immutable — a small TTL cache absorbs repeat
// page loads on warm lambda instances; cold starts just re-fetch.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const metadataCache = new Map<string, { info: KoiosAssetInfo; at: number }>();

async function assetInfoCached(
  network: Network,
  units: string[],
): Promise<Map<string, KoiosAssetInfo>> {
  const now = Date.now();
  const out = new Map<string, KoiosAssetInfo>();
  const missing: string[] = [];
  for (const unit of units) {
    const hit = metadataCache.get(`${network}:${unit}`);
    if (hit && now - hit.at < CACHE_TTL_MS) out.set(unit, hit.info);
    else missing.push(unit);
  }
  if (missing.length > 0) {
    const fetched = await assetInfoBulk(network, missing);
    for (const [unit, info] of fetched) {
      out.set(unit, info);
      // Right after submission Koios may know the asset but not yet expose its
      // mint metadata. Do not preserve that transient, ticker-less response
      // for the full cache TTL; the next request should be allowed to resolve
      // the label-721 ticker.
      const described = tokenFromAssetInfo(unit, 0n, info);
      if (described.source === "registry" || described.source === "mint") {
        metadataCache.set(`${network}:${unit}`, { info, at: now });
      }
    }
    while (metadataCache.size > CACHE_MAX) {
      const oldest = metadataCache.keys().next().value;
      if (oldest === undefined) break;
      metadataCache.delete(oldest);
    }
  }
  return out;
}

/**
 * Describe tokens by unit alone (ticker, name, decimals), for units read from
 * a transaction rather than a wallet. Throws when Koios does: the caller
 * decides whether a missing description matters.
 */
export async function describeTokens(network: Network, units: string[]): Promise<WalletToken[]> {
  const infos = await assetInfoCached(network, units);
  return units.map((unit) => tokenFromAssetInfo(unit, 0n, infos.get(unit)));
}

/**
 * The units Koios knows, described; a unit absent from the result is not an
 * asset on this network. Throws when Koios does, so an outage never reads as
 * "unknown asset" (or as 0 decimals).
 */
export async function describeKnownTokens(network: Network, units: string[]): Promise<Map<string, WalletToken>> {
  const infos = await assetInfoCached(network, units);
  const known = new Map<string, WalletToken>();
  for (const unit of units) {
    const info = infos.get(unit);
    if (info) known.set(unit, tokenFromAssetInfo(unit, 0n, info));
  }
  return known;
}

export interface WalletAssets {
  lovelace: bigint;
  utxoCount: number;
  tokens: WalletToken[];
}

/**
 * Fold a wallet's UTxOs into per-unit balances and attach token metadata.
 * Koios metadata failures degrade to source:"none" tokens rather than
 * throwing — missing metadata must never block a manual connection.
 */
export async function fetchWalletAssets(
  network: Network,
  address: string,
): Promise<WalletAssets> {
  const utxos = await getProvider(network).fetchAddressUTxOs(address);
  let lovelace = 0n;
  const byUnit = new Map<string, bigint>();
  for (const utxo of utxos) {
    for (const a of utxo.output.amount) {
      if (a.unit === LOVELACE) lovelace += BigInt(a.quantity);
      else addQuantity(byUnit, a.unit, BigInt(a.quantity));
    }
  }

  const units = [...byUnit.keys()];
  let infos = new Map<string, KoiosAssetInfo>();
  try {
    infos = await assetInfoCached(network, units);
  } catch {
    // degrade: tokens render without tickers
  }

  return {
    lovelace,
    utxoCount: utxos.length,
    tokens: units.map((unit) =>
      tokenFromAssetInfo(unit, byUnit.get(unit)!, infos.get(unit)),
    ),
  };
}

// Pure fold from Koios asset metadata to a displayable wallet token.
// Kept free of I/O and "server-only" so vitest can exercise the fallback
// chain directly; the fetch side lives in walletAssets.ts.

import type { KoiosAssetInfo } from "./koios";
import { cip25Entry, hexToUtf8, readCip25Fields } from "./cip25";
import { splitUnit } from "./units";

export interface WalletToken {
  /** policyId(56 hex) + assetNameHex */
  unit: string;
  quantity: bigint;
  /** CIP-26 registry ticker, else 721 mint hint, else ASCII asset name, else null. */
  ticker: string | null;
  name: string | null;
  /** Registry decimals -> CIP-68 decimals -> 721 mint hint -> 0. */
  decimals: number;
  source: "registry" | "mint" | "ascii" | "none";
}

export interface WalletTokenHint {
  ticker: string | null;
  name: string | null;
  decimals: number;
}

/**
 * Decode the asset-name part of a Cardano unit without ever exposing the
 * policy id as the token label. The second candidate handles CIP-67-labelled
 * assets whose first four bytes are a binary label prefix.
 */
export function assetNameFromUnit(unit: string): string | null {
  const { assetNameHex } = splitUnit(unit);
  const candidates = [assetNameHex, assetNameHex.length > 8 ? assetNameHex.slice(8) : ""];
  for (const candidate of candidates) {
    const decoded = hexToUtf8(candidate)?.trim();
    if (decoded && !/[\u0000-\u001f\u007f-\u009f]/.test(decoded)) return decoded;
  }
  return null;
}

/**
 * Fill an unresolved chain token from Treasury Guild's own mint record. The
 * record is available immediately, while Koios can take a short time to add
 * the mint transaction's label-721 metadata to /asset_info.
 */
export function applyWalletTokenHint(
  token: WalletToken,
  hint: WalletTokenHint | undefined,
): WalletToken {
  if (!hint || token.source === "registry" || token.source === "mint") {
    return token;
  }
  const ticker = hint.ticker ?? hint.name;
  if (!ticker) return token;
  return {
    ...token,
    ticker,
    name: hint.name,
    decimals: hint.decimals,
    source: "mint",
  };
}

/**
 * Metadata fallback chain: token registry (CIP-26) -> CIP-25 (721) hints from
 * the minting tx (what Treasury Guild's own mints carry) -> ASCII name -> nothing.
 */
export function tokenFromAssetInfo(
  unit: string,
  quantity: bigint,
  info: KoiosAssetInfo | undefined,
): WalletToken {
  const encodedName = assetNameFromUnit(unit);
  const registry = info?.token_registry_metadata ?? null;
  const hint = mint721Hint(info);
  if (registry?.ticker || registry?.name) {
    return {
      unit,
      quantity,
      ticker: registry.ticker ?? registry.name ?? null,
      name: registry.name ?? null,
      decimals:
        registry.decimals ??
        cip68Decimals(info?.cip68_metadata) ??
        hint?.decimals ??
        0,
      source: "registry",
    };
  }
  if (hint && (hint.ticker || hint.name)) {
    return {
      unit,
      quantity,
      ticker: hint.ticker ?? hint.name ?? info?.asset_name_ascii ?? null,
      name: hint.name ?? info?.asset_name_ascii ?? null,
      decimals: cip68Decimals(info?.cip68_metadata) ?? hint.decimals ?? 0,
      source: "mint",
    };
  }
  if (info?.asset_name_ascii) {
    return {
      unit,
      quantity,
      ticker: info.asset_name_ascii,
      name: info.asset_name_ascii,
      decimals: cip68Decimals(info.cip68_metadata) ?? hint?.decimals ?? 0,
      source: "ascii",
    };
  }
  if (encodedName) {
    return {
      unit,
      quantity,
      ticker: encodedName,
      name: encodedName,
      decimals: cip68Decimals(info?.cip68_metadata) ?? hint?.decimals ?? 0,
      source: "ascii",
    };
  }
  return {
    unit,
    quantity,
    ticker: null,
    name: null,
    decimals: cip68Decimals(info?.cip68_metadata) ?? hint?.decimals ?? 0,
    source: "none",
  };
}

/** CIP-68 FT datums nest fields under a label key ("333": {decimals: n}). */
function cip68Decimals(cip68: unknown): number | null {
  if (!cip68 || typeof cip68 !== "object") return null;
  for (const value of Object.values(cip68 as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const d = (value as Record<string, unknown>).decimals;
      if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 12) {
        return d;
      }
    }
  }
  return null;
}

/**
 * Read this asset's entry from the mint tx's label-721 metadata:
 * {"721": {<policy>: {<assetName>: {name, ticker, decimals, ...}}}}.
 * The asset name key is UTF-8 text (CIP-25 v1) or hex (v2); both are tried.
 */
function mint721Hint(
  info: KoiosAssetInfo | undefined,
): { name: string | null; ticker: string | null; decimals: number | null } | null {
  const meta = info?.minting_tx_metadata;
  if (!meta || typeof meta !== "object") return null;
  const entry = cip25Entry(
    (meta as Record<string, unknown>)["721"],
    info!.policy_id,
    info!.asset_name ?? "",
    info!.asset_name_ascii,
  );
  if (!entry) return null;
  const fields = readCip25Fields(entry);
  return {
    name: fields.name,
    ticker: fields.ticker ? fields.ticker.slice(0, 32) : null,
    decimals: fields.decimals,
  };
}

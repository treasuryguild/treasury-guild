// CIP-25 (label 721) read helpers + hex/UTF-8 codecs. Pure and client-safe:
// used by the wallet-token fold on the server and the signing page's mint
// preview in the browser.

const encoder = new TextEncoder();

/** Lowercase hex of a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function utf8ToHex(s: string): string {
  return bytesToHex(encoder.encode(s));
}

/** Strict decode: null for odd length, non-hex input or invalid UTF-8. */
export function hexToUtf8(hex: string): string | null {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** CIP-25 strings may be split into ≤64-byte chunks; join them back. */
export function joinChunks(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((p) => typeof p === "string")) {
    return v.join("");
  }
  return null;
}

export type Cip25EntryLike = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/**
 * Look up an asset's entry in a label-721 object
 * ({<policyId>: {<assetName>: {...}}}). The asset-name key is UTF-8 text in
 * CIP-25 v1 and hex in v2; both are tried, text first.
 */
export function cip25Entry(
  meta721: unknown,
  policyId: string,
  assetNameHex: string,
  assetNameUtf8?: string | null,
): Cip25EntryLike | null {
  if (!isObject(meta721)) return null;
  const policyMap = meta721[policyId];
  if (!isObject(policyMap)) return null;
  const utf8 = assetNameUtf8 ?? hexToUtf8(assetNameHex);
  for (const key of [utf8, assetNameHex]) {
    if (!key) continue;
    const e = policyMap[key];
    if (isObject(e)) return e;
  }
  return null;
}

/** Valid CIP-68/CIP-25 `decimals` hint: integer in 0..12. */
export function cip25Decimals(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 12
    ? v
    : null;
}

export interface Cip25Fields {
  name: string | null;
  ticker: string | null;
  decimals: number | null;
  image: string | null;
  description: string | null;
}

/** Normalised display fields from a 721 entry (chunks joined). */
export function readCip25Fields(entry: Cip25EntryLike | null): Cip25Fields {
  if (!entry) {
    return { name: null, ticker: null, decimals: null, image: null, description: null };
  }
  return {
    name: joinChunks(entry.name),
    ticker: joinChunks(entry.ticker),
    decimals: cip25Decimals(entry.decimals),
    image: joinChunks(entry.image),
    description: joinChunks(entry.description),
  };
}

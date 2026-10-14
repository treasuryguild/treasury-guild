// Pure helpers for token minting: CIP-25 (label 721) metadata, CIP-26 registry
// drafts, asset-name validation and the forge-script shape. No I/O and no
// "server-only" so vitest and the browser (CIP-26 download) can use them.
import type { NativeScript } from "@meshsdk/core";
import { byteLength, MAX_METADATUM_STR_BYTES as MAX_STR_BYTES } from "./metadata";
import { utf8ToHex } from "./cip25";

export const CIP25_LABEL = "721";
export const MAX_ASSET_NAME_BYTES = 32;
export const MAX_TICKER_CHARS = 9;

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Cardano metadatum strings are capped at 64 bytes. CIP-25 allows any string
 * field to be an array of ≤64-byte chunks that readers concatenate.
 */
export function chunk64(s: string): string | string[] {
  if (byteLength(s) <= MAX_STR_BYTES) return s;
  const chunks: string[] = [];
  let current = "";
  for (const ch of s) {
    if (byteLength(current + ch) > MAX_STR_BYTES) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** IPFS CIDv0 (Qm…, base58) or CIDv1 (b…, base32 lower-case). */
export const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/**
 * Validate an on-chain asset name (also the CIP-25 map key): 1–32 UTF-8
 * bytes, printable, no leading/trailing whitespace.
 */
export function validateAssetName(
  raw: string,
): { ok: true; name: string; hex: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: "Asset name is required" };
  if (name !== raw) {
    return { ok: false, error: "Asset name must not start or end with spaces" };
  }
  if (byteLength(name) > MAX_ASSET_NAME_BYTES) {
    return {
      ok: false,
      error: `Asset name must be at most ${MAX_ASSET_NAME_BYTES} bytes`,
    };
  }
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, error: "Asset name contains control characters" };
  }
  return { ok: true, name, hex: utf8ToHex(name) };
}

export function validateTicker(
  raw: string,
): { ok: true; ticker: string } | { ok: false; error: string } {
  const ticker = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,9}$/.test(ticker)) {
    return {
      ok: false,
      error: `Ticker must be 1–${MAX_TICKER_CHARS} letters or digits`,
    };
  }
  return { ok: true, ticker };
}

export interface Cip25File {
  name: string;
  mediaType: string;
  src: string;
}

export interface Cip25Asset {
  /** On-chain asset name; the key in the 721 map (UTF-8, ≤32 bytes). */
  assetName: string;
  /** Display name (defaults to assetName). */
  name?: string;
  /** "ipfs://<cid>" */
  image: string;
  mediaType?: string;
  description?: string;
  files?: Cip25File[];
  /** Fungible-token hints (non-standard but widely read by explorers). */
  ticker?: string;
  decimals?: number;
  url?: string;
  /** Free-form extra properties (NFT traits). Reserved keys are ignored. */
  attributes?: Record<string, string>;
}

const RESERVED_721_KEYS = new Set([
  "name",
  "image",
  "mediaType",
  "description",
  "files",
  "ticker",
  "decimals",
  "url",
]);

export type Cip25Entry = Record<string, unknown>;

export function buildCip25Entry(asset: Cip25Asset): Cip25Entry {
  const entry: Cip25Entry = {
    name: chunk64(asset.name?.trim() || asset.assetName),
    image: chunk64(asset.image),
  };
  if (asset.mediaType) entry.mediaType = asset.mediaType;
  if (asset.description?.trim()) {
    entry.description = chunk64(asset.description.trim());
  }
  if (asset.files?.length) {
    entry.files = asset.files.map((f) => ({
      name: chunk64(f.name),
      mediaType: f.mediaType,
      src: chunk64(f.src),
    }));
  }
  if (asset.ticker) entry.ticker = asset.ticker;
  if (asset.decimals !== undefined) entry.decimals = asset.decimals;
  if (asset.url?.trim()) entry.url = chunk64(asset.url.trim());
  for (const [key, value] of Object.entries(asset.attributes ?? {})) {
    const k = key.trim();
    if (!k || RESERVED_721_KEYS.has(k) || byteLength(k) > MAX_STR_BYTES) {
      continue;
    }
    const v = value.trim();
    if (!v) continue;
    entry[k] = chunk64(v);
  }
  return entry;
}

/**
 * CIP-25 (v1) metadata object for label 721:
 *   { <policyId>: { <assetName>: { name, image, ... } } }
 * v1 keys are UTF-8 text, which every asset name we accept satisfies.
 */
export function buildCip25Metadata(
  policyId: string,
  assets: Cip25Asset[],
): Record<string, Record<string, Cip25Entry>> {
  const byName: Record<string, Cip25Entry> = {};
  for (const a of assets) byName[a.assetName] = buildCip25Entry(a);
  return { [policyId]: byName };
}

/**
 * Forge script: the treasury's own multisig script (open policy), or that
 * script AND a "before <slot>" time lock (policy closes at the slot).
 */
export function mintPolicyScript(
  treasuryScript: NativeScript,
  lockSlot?: number | null,
): NativeScript {
  if (lockSlot === undefined || lockSlot === null) return treasuryScript;
  if (!Number.isInteger(lockSlot) || lockSlot <= 0) {
    throw new Error("lockSlot must be a positive integer");
  }
  return {
    type: "all",
    scripts: [treasuryScript, { type: "before", slot: String(lockSlot) }],
  };
}

export interface Cip26DraftInput {
  policyId: string;
  assetNameHex: string;
  /** Hex CBOR of the forge script (the registry's `policy` field). */
  policyScriptCbor: string;
  name: string;
  description: string;
  ticker?: string;
  decimals?: number;
  url?: string;
  /** Base64 (no data: prefix) PNG/JPEG/SVG logo. */
  logoBase64?: string;
}

/**
 * Unsigned CIP-26 mapping file for the cardano-token-registry. Every entry
 * still needs `signatures` produced with the policy's signing keys
 * (token-metadata-creator) before the registry accepts it.
 */
export function buildCip26Draft(
  input: Cip26DraftInput,
): Record<string, unknown> {
  const prop = (value: unknown) => ({
    value,
    sequenceNumber: 0,
    signatures: [] as { publicKey: string; signature: string }[],
  });
  const draft: Record<string, unknown> = {
    subject: input.policyId + input.assetNameHex,
    policy: input.policyScriptCbor,
    name: prop(input.name.slice(0, 50)),
    description: prop(input.description.slice(0, 500)),
  };
  if (input.ticker) draft.ticker = prop(input.ticker);
  if (input.decimals !== undefined) draft.decimals = prop(input.decimals);
  if (input.url) draft.url = prop(input.url);
  if (input.logoBase64) draft.logo = prop(input.logoBase64);
  return draft;
}

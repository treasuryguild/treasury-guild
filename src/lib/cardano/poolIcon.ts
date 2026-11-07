// Stake-pool icon from Koios /pool_metadata + CIP-6 / AdaPools extended JSON.
import "server-only";

import type { Network } from "@/lib/config";
import { fetchWithPinnedDns } from "@/lib/oauthServer/ssrf";
import { fetchPoolMetadata, type KoiosPoolMetadataRow } from "./koios";

export const POOL_ICON_URL_MAX_LEN = 512;
const META_FETCH_TIMEOUT_MS = 5000;
const META_MAX_BYTES = 64 * 1024;

/** Accept only a length-capped https URL suitable for storing / rendering. */
export function asHttpsIconUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > POOL_ICON_URL_MAX_LEN) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return trimmed;
}

/**
 * AdaPools-style icon fields on an extended (or basic) metadata document.
 * Prefer the 64×64 icon for the Treasury card thumb.
 */
export function extractIconUrlFromPoolMeta(doc: unknown): string | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const info = (doc as Record<string, unknown>).info;
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const record = info as Record<string, unknown>;
  return (
    asHttpsIconUrl(record.url_png_icon_64x64) ??
    asHttpsIconUrl(record.url_png_logo)
  );
}

/** One-hop `extended` URL from CIP-6 basic metadata (string only). */
export function extractExtendedMetaUrl(doc: unknown): string | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  return asHttpsIconUrl((doc as Record<string, unknown>).extended);
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Pool metadata document exceeds the size limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** SSRF-safe HTTPS JSON fetch for pool meta / extended documents. */
async function fetchPoolMetaJson(url: string): Promise<unknown | null> {
  const safe = asHttpsIconUrl(url);
  if (!safe) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchWithPinnedDns(safe, {
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return parseJsonObject(await readCapped(response, META_MAX_BYTES));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Icon from a Koios `/pool_metadata` row: use embedded `meta_json`, fetch
 * `meta_url` when empty, then follow a one-hop `extended` URL when needed.
 */
export async function iconUrlFromPoolMetadataRow(
  row: KoiosPoolMetadataRow,
): Promise<string | null> {
  let doc: unknown = row.meta_json ?? null;
  if (doc == null && row.meta_url) {
    doc = await fetchPoolMetaJson(row.meta_url);
  }
  const fromBasic = extractIconUrlFromPoolMeta(doc);
  if (fromBasic) return fromBasic;

  const extendedUrl = extractExtendedMetaUrl(doc);
  if (!extendedUrl) return null;
  const extendedDoc = await fetchPoolMetaJson(extendedUrl);
  return extractIconUrlFromPoolMeta(extendedDoc);
}

/**
 * Best-effort icon URL for a pool. Never throws: missing metadata, SSRF blocks
 * and network errors all yield null so linking / refresh still succeed.
 */
export async function resolvePoolIconUrl(
  network: Network,
  poolId: string,
): Promise<string | null> {
  try {
    const row = await fetchPoolMetadata(network, poolId);
    if (!row) return null;
    return await iconUrlFromPoolMetadataRow(row);
  } catch (err) {
    console.error("resolvePoolIconUrl failed:", err);
    return null;
  }
}

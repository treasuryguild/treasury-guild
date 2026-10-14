// OAuth client resolution, by the two registration mechanisms the MCP spec
// lists in priority order:
//
//  1. Client ID Metadata Documents: the client_id IS an https URL serving the
//     client's metadata. Nothing is pre-provisioned; the document is fetched,
//     checked and cached, and re-fetched after an hour.
//  2. Dynamic Client Registration (RFC 7591, /api/oauth/register): deprecated
//     by the 2026-07-28 revision, kept for clients that cannot do CIMD.
import "server-only";

import { findOAuthClient, saveOAuthClient } from "@/lib/db/oauth";
import type { OAuthClientRow } from "@/lib/db/types";
import { isAcceptableRedirectUri, isMetadataUrlClientId, MAX_REDIRECT_URIS } from "./redirects";
import { assertSafeHost, SsrfBlockedError } from "./ssrf";

const CIMD_FETCH_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_REVALIDATE_MS = 60 * 60 * 1000;
export const MAX_CLIENT_NAME = 200;

interface CimdDocument {
  client_id?: unknown;
  client_name?: unknown;
  client_uri?: unknown;
  redirect_uris?: unknown;
}

/**
 * Read at most `maxBytes` of a body, aborting past it: /api/oauth/authorize
 * fetches the client_id URL before any session exists, so a hostile document
 * must not be able to pin memory.
 */
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
      if (total > maxBytes) throw new Error("Client metadata document exceeds the size limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchMetadataDocument(clientId: string): Promise<CimdDocument | null> {
  // The client_id is attacker-controlled: this fetch is an SSRF sink.
  await assertSafeHost(new URL(clientId).hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIMD_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(clientId, {
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return JSON.parse(await readCapped(response, CIMD_MAX_BYTES)) as CimdDocument;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A metadata-document client, from the cache while fresh. The document's own
 * client_id must equal the URL it came from, or one document could claim
 * another client's identity; redirect URIs get the same scheme rule as DCR.
 */
async function resolveMetadataUrlClient(clientId: string): Promise<OAuthClientRow | null> {
  const cached = await findOAuthClient(clientId);
  if (cached && Date.now() - Date.parse(cached.last_seen_at) < CIMD_REVALIDATE_MS) return cached;

  let doc: CimdDocument | null;
  try {
    doc = await fetchMetadataDocument(clientId);
  } catch (error) {
    // A host that now points at a private address is not a client, cached or not.
    if (error instanceof SsrfBlockedError) return null;
    doc = null;
  }
  // A transient fetch failure must not lock out a client already known.
  if (!doc) return cached;

  if (doc.client_id !== clientId) return null;
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) return null;
  const redirectUris = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris
        .filter((u): u is string => typeof u === "string")
        .filter(isAcceptableRedirectUri)
        .slice(0, MAX_REDIRECT_URIS)
    : [];
  if (redirectUris.length === 0) return null;

  return saveOAuthClient({
    client_id: clientId,
    is_metadata_url: true,
    client_name: doc.client_name.trim().slice(0, MAX_CLIENT_NAME),
    client_uri: typeof doc.client_uri === "string" ? doc.client_uri : null,
    redirect_uris: redirectUris,
    // A document cannot hold a secret: CIMD clients are public (PKCE).
    token_endpoint_auth_method: "none",
    secret_hash: null,
  });
}

/** The client behind a client_id, by whichever mechanism registered it; null when unknown. */
export async function resolveClient(clientId: string): Promise<OAuthClientRow | null> {
  if (isMetadataUrlClientId(clientId)) return resolveMetadataUrlClient(clientId);
  return findOAuthClient(clientId);
}

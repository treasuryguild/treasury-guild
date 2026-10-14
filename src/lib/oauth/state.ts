// HMAC-signed `state` parameters for every OAuth / install round-trip. One
// home for all of them: the state is what ties a callback to the wallet (or
// community) that started the flow, so each kind is bound to a purpose and a
// state signed for one flow is worthless on another flow's callback.
import "server-only";

import { hmacSha256Hex, safeEqual } from "@/lib/auth/crypto";
import { cronSecret, oauthStateSecret } from "@/lib/env.server";

/** OAUTH_STATE_SECRET, else a key derived from CRON_SECRET for this use only. */
function secret(): string {
  return oauthStateSecret() ?? hmacSha256Hex(cronSecret(), "treasury-guild/oauth-state");
}

function macOf(body: string): string {
  return hmacSha256Hex(secret(), body);
}

function macMatches(body: string, mac: string): boolean {
  return safeEqual(mac, macOf(body));
}

/** Split "<body>.<mac>" and check the mac; the body, or null. */
function verifiedBody(state: string): string | null {
  const dot = state.lastIndexOf(".");
  if (dot < 1) return null;
  const body = state.slice(0, dot);
  return macMatches(body, state.slice(dot + 1)) ? body : null;
}

/** Which flow a state was issued for. A callback accepts only its own. */
export type OAuthPurpose = "github-link" | "github-install" | "discord-link" | "google-link" | "discord-guild" | "zoom-host" | "google-host";

/**
 * Every purpose a signed round-trip value can carry: the OAuth states above,
 * plus the agent API's authorization-request handle (src/lib/oauthServer),
 * which is not bound to a wallet because the user signs in after it is made.
 */
export type SignedPurpose = OAuthPurpose | "mcp-authorize";

/** Expiring, purpose-bound signed payload: "<base64url json>.<mac>". */
export function signPayload(purpose: SignedPurpose, payload: object, ttlMs: number): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, purpose, exp: Date.now() + ttlMs }),
  ).toString("base64url");
  return `${body}.${macOf(body)}`;
}

/** The payload of a value signed for `purpose` and not yet expired, else null. */
export function verifyPayload(purpose: SignedPurpose, token: string): Record<string, unknown> | null {
  const body = verifiedBody(token);
  if (!body) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.purpose !== purpose) return null;
    if (typeof record.exp !== "number" || record.exp < Date.now()) return null;
    return record;
  } catch {
    return null;
  }
}

export interface OAuthState {
  wallet: string;
  returnTo: string;
  /** Flows that connect something to a community (github-install, discord-guild, zoom-host, google-host). */
  communityId?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/** Expiring, purpose-bound state for a user OAuth round-trip. */
export function signOAuthState(purpose: OAuthPurpose, payload: OAuthState): string {
  return signPayload(purpose, payload, STATE_TTL_MS);
}

export function verifyOAuthState(purpose: OAuthPurpose, state: string): OAuthState | null {
  const parsed = verifyPayload(purpose, state);
  if (!parsed) return null;
  if (typeof parsed.wallet !== "string" || typeof parsed.returnTo !== "string") return null;
  return {
    wallet: parsed.wallet,
    returnTo: parsed.returnTo,
    ...(typeof parsed.communityId === "string" && { communityId: parsed.communityId }),
  };
}

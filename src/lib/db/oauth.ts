// Agent API authorization server storage (migration 0053): clients, grants,
// one-time codes and rotating refresh tokens. Service role only; values that
// act as bearer secrets are passed in already hashed (hashToken).
//
// Redemptions are conditional updates (`... is null`), which are atomic per
// statement: of two concurrent redemptions of one code or refresh token,
// exactly one claims it, and the loser is treated as a replay.
import "server-only";

import type { ApiScope } from "@/lib/mcp/scopes";
import type { OAuthClientRow, OAuthCodeRow, OAuthGrantRow, OAuthRefreshTokenRow } from "./types";
import { check, maybe, must, rows, serviceClient } from "./client";

const CLIENT_COLUMNS =
  "client_id, is_metadata_url, client_name, client_uri, redirect_uris, token_endpoint_auth_method, secret_hash, created_at, last_seen_at";
const GRANT_COLUMNS = "wallet_address, client_id, scopes, created_at, updated_at, last_used_at";
const CODE_COLUMNS =
  "code_hash, client_id, wallet_address, scopes, resource, redirect_uri, code_challenge, expires_at, consumed_at";
const REFRESH_COLUMNS =
  "id, token_hash, client_id, wallet_address, scopes, resource, expires_at, revoked_at, replaced_by";

/** Grant use is recorded at most this often (it is a write per agent request otherwise). */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

// --- Clients -------------------------------------------------------------------

export async function findOAuthClient(clientId: string): Promise<OAuthClientRow | null> {
  return maybe<OAuthClientRow>(
    await serviceClient().from("oauth_clients").select(CLIENT_COLUMNS).eq("client_id", clientId).maybeSingle(),
    "load oauth client",
  );
}

export type NewOAuthClient = Pick<
  OAuthClientRow,
  "client_id" | "is_metadata_url" | "client_name" | "client_uri" | "redirect_uris" | "token_endpoint_auth_method" | "secret_hash"
>;

/** Insert a client, or refresh a Client ID Metadata Document client from its re-fetched document. */
export async function saveOAuthClient(client: NewOAuthClient): Promise<OAuthClientRow> {
  return must<OAuthClientRow>(
    await serviceClient()
      .from("oauth_clients")
      .upsert({ ...client, last_seen_at: new Date().toISOString() }, { onConflict: "client_id" })
      .select(CLIENT_COLUMNS)
      .single(),
    "save oauth client",
  );
}

// --- Grants ----------------------------------------------------------------------

export async function findOAuthGrant(wallet: string, clientId: string): Promise<OAuthGrantRow | null> {
  return maybe<OAuthGrantRow>(
    await serviceClient()
      .from("oauth_grants")
      .select(GRANT_COLUMNS)
      .eq("wallet_address", wallet)
      .eq("client_id", clientId)
      .maybeSingle(),
    "load oauth grant",
  );
}

/** Record (or re-record) the wallet's approval of a client. */
export async function saveOAuthGrant(wallet: string, clientId: string, scopes: readonly ApiScope[]): Promise<void> {
  check(
    await serviceClient()
      .from("oauth_grants")
      .upsert(
        { wallet_address: wallet, client_id: clientId, scopes: [...scopes], updated_at: new Date().toISOString() },
        { onConflict: "wallet_address,client_id" },
      ),
    "save oauth grant",
  );
}

/** Stamp the grant's last use, at most once per LAST_USED_RESOLUTION_MS. */
export async function touchOAuthGrant(grant: OAuthGrantRow, now = new Date()): Promise<void> {
  if (grant.last_used_at && now.getTime() - Date.parse(grant.last_used_at) < LAST_USED_RESOLUTION_MS) return;
  check(
    await serviceClient()
      .from("oauth_grants")
      .update({ last_used_at: now.toISOString() })
      .eq("wallet_address", grant.wallet_address)
      .eq("client_id", grant.client_id),
    "touch oauth grant",
  );
}

export interface OAuthGrantWithClient extends OAuthGrantRow {
  oauth_clients: Pick<OAuthClientRow, "client_name" | "client_uri" | "is_metadata_url"> | null;
}

/** The wallet's connected clients, newest approval first. */
export async function listOAuthGrants(wallet: string): Promise<OAuthGrantWithClient[]> {
  return rows<OAuthGrantWithClient>(
    await serviceClient()
      .from("oauth_grants")
      .select(`${GRANT_COLUMNS}, oauth_clients(client_name, client_uri, is_metadata_url)`)
      .eq("wallet_address", wallet)
      .order("updated_at", { ascending: false }),
    "list oauth grants",
  );
}

/** Revoke a connection: the grant goes, and every refresh token under it stops working. */
export async function deleteOAuthGrant(wallet: string, clientId: string): Promise<boolean> {
  const deleted = rows<{ client_id: string }>(
    await serviceClient()
      .from("oauth_grants")
      .delete()
      .eq("wallet_address", wallet)
      .eq("client_id", clientId)
      .select("client_id"),
    "delete oauth grant",
  );
  await revokeRefreshTokens(clientId, wallet);
  return deleted.length > 0;
}

// --- Authorization codes -----------------------------------------------------------

export async function insertAuthorizationCode(
  code: Omit<OAuthCodeRow, "consumed_at">,
): Promise<void> {
  check(await serviceClient().from("oauth_authorization_codes").insert(code), "insert authorization code");
}

export async function findAuthorizationCode(codeHash: string): Promise<OAuthCodeRow | null> {
  return maybe<OAuthCodeRow>(
    await serviceClient()
      .from("oauth_authorization_codes")
      .select(CODE_COLUMNS)
      .eq("code_hash", codeHash)
      .maybeSingle(),
    "load authorization code",
  );
}

/** Claim an unconsumed code; false when another redemption got there first. */
export async function consumeAuthorizationCode(codeHash: string): Promise<boolean> {
  const claimed = rows<{ code_hash: string }>(
    await serviceClient()
      .from("oauth_authorization_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("code_hash", codeHash)
      .is("consumed_at", null)
      .select("code_hash"),
    "consume authorization code",
  );
  return claimed.length === 1;
}

// --- Refresh tokens --------------------------------------------------------------------

export async function insertRefreshToken(
  token: Pick<OAuthRefreshTokenRow, "token_hash" | "client_id" | "wallet_address" | "scopes" | "resource" | "expires_at">,
): Promise<string> {
  return must<{ id: string }>(
    await serviceClient().from("oauth_refresh_tokens").insert(token).select("id").single(),
    "insert refresh token",
  ).id;
}

export async function findRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRow | null> {
  return maybe<OAuthRefreshTokenRow>(
    await serviceClient()
      .from("oauth_refresh_tokens")
      .select(REFRESH_COLUMNS)
      .eq("token_hash", tokenHash)
      .maybeSingle(),
    "load refresh token",
  );
}

/** Claim a live, never-rotated token; false when it was already redeemed. */
export async function claimRefreshToken(id: string): Promise<boolean> {
  const claimed = rows<{ id: string }>(
    await serviceClient()
      .from("oauth_refresh_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .is("revoked_at", null)
      .is("replaced_by", null)
      .select("id"),
    "claim refresh token",
  );
  return claimed.length === 1;
}

/** Link a claimed token to its successor, which turns a later presentation into a detectable replay. */
export async function linkRefreshTokenSuccessor(id: string, successorId: string): Promise<void> {
  check(
    await serviceClient().from("oauth_refresh_tokens").update({ replaced_by: successorId }).eq("id", id),
    "link refresh token",
  );
}

/** Revoke every live refresh token of one (client, wallet): a leak or a disconnect. */
export async function revokeRefreshTokens(clientId: string, wallet: string): Promise<void> {
  check(
    await serviceClient()
      .from("oauth_refresh_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("wallet_address", wallet)
      .is("revoked_at", null),
    "revoke refresh tokens",
  );
}

// --- Retention -------------------------------------------------------------------------

/** Expired codes and tokens, and DCR clients nobody approved (reconcile sweep). */
export async function purgeOAuth(now: Date): Promise<number> {
  const res = await serviceClient().rpc("purge_oauth", { p_now: now.toISOString() });
  check(res, "purge oauth");
  return (res.data as number | null) ?? 0;
}

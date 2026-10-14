// The token endpoint's two grants: authorization_code (with PKCE) and
// refresh_token (rotating, with replay detection).
import "server-only";

import {
  claimRefreshToken,
  consumeAuthorizationCode,
  deleteOAuthGrant,
  findAuthorizationCode,
  findOAuthGrant,
  findRefreshToken,
  insertRefreshToken,
  linkRefreshTokenSuccessor,
} from "@/lib/db/oauth";
import { OAuthProtocolError } from "@/lib/errors";
import { formatApiScopes, knownScopes, parseApiScopes, type ApiScope } from "@/lib/mcp/scopes";
import { generateOpaqueToken, hashToken, mintAccessToken } from "./accessToken";
import { REFRESH_TOKEN_TTL_SECONDS, resourceUrl } from "./config";
import { verifyCodeChallenge } from "./pkce";

// A type alias (not an interface) so it is a plain JSON record for the route wrapper.
export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

const invalidGrant = (description: string) => new OAuthProtocolError(400, "invalid_grant", description);
const connectionRemoved = () => invalidGrant("This connection was removed. Connect again.");

/**
 * A code or refresh token used twice has leaked. The whole connection goes:
 * deleting the grant revokes its refresh tokens and, because every request
 * re-reads the grant, stops its live access tokens too. The user reconnects.
 */
async function endConnection(wallet: string, clientId: string): Promise<void> {
  await deleteOAuthGrant(wallet, clientId);
}

async function issueTokens(args: {
  clientId: string;
  wallet: string;
  scopes: ApiScope[];
  grantCreatedAt: number;
}): Promise<{ response: TokenResponse; refreshId: string }> {
  const { token, expiresIn } = await mintAccessToken(args);
  const refreshToken = generateOpaqueToken();
  const refreshId = await insertRefreshToken({
    token_hash: hashToken(refreshToken),
    client_id: args.clientId,
    wallet_address: args.wallet,
    scopes: [...args.scopes],
    resource: resourceUrl(),
    expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
  });
  return {
    response: {
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: formatApiScopes(args.scopes),
    },
    refreshId,
  };
}

/**
 * Redeem a code. The PKCE check comes before the claim, so a wrong verifier
 * does not burn the code; a code presented after it was used means it leaked,
 * and the connection is ended (endConnection). The grant must still exist: a
 * code redeemed after Disconnect gets nothing.
 */
export async function exchangeAuthorizationCode(
  clientId: string,
  input: { code: string; codeVerifier: string; redirectUri: string | null },
): Promise<TokenResponse> {
  const codeHash = hashToken(input.code);
  const record = await findAuthorizationCode(codeHash);
  if (!record || record.client_id !== clientId) throw invalidGrant("Unknown authorization code");

  const replayed = async () => {
    await endConnection(record.wallet_address, record.client_id);
    return invalidGrant("Authorization code has already been used");
  };
  if (record.consumed_at) throw await replayed();
  if (Date.parse(record.expires_at) <= Date.now()) throw invalidGrant("Authorization code has expired");
  if (input.redirectUri && input.redirectUri !== record.redirect_uri) {
    throw invalidGrant("redirect_uri does not match the authorization request");
  }
  if (record.resource !== resourceUrl()) throw invalidGrant("The code was issued for another resource");
  if (!verifyCodeChallenge(input.codeVerifier, record.code_challenge)) {
    throw invalidGrant("PKCE verification failed");
  }
  if (!(await consumeAuthorizationCode(codeHash))) throw await replayed();

  const grant = await findOAuthGrant(record.wallet_address, clientId);
  if (!grant) throw connectionRemoved();
  const granted = knownScopes(grant.scopes);
  const scopes = knownScopes(record.scopes).filter((s) => granted.includes(s));
  if (scopes.length === 0) throw new OAuthProtocolError(400, "invalid_scope", "The code grants no known scope");
  return (await issueTokens({
    clientId, wallet: record.wallet_address, scopes, grantCreatedAt: Date.parse(grant.created_at),
  })).response;
}

/**
 * Rotate a refresh token. A token that already has a successor, or that loses
 * the claim to a concurrent redemption, has been used twice: the connection
 * is ended (endConnection). The grant must still exist (the
 * Settings page's Disconnect deletes it), and a refresh may narrow the scope
 * but never widen it past the token or the grant.
 */
export async function exchangeRefreshToken(
  clientId: string,
  input: { refreshToken: string; scope: string | null },
): Promise<TokenResponse> {
  const record = await findRefreshToken(hashToken(input.refreshToken));
  if (!record || record.client_id !== clientId) throw invalidGrant("Unknown refresh token");

  const replayed = async () => {
    await endConnection(record.wallet_address, record.client_id);
    return invalidGrant("Refresh token has already been used");
  };
  if (record.replaced_by) throw await replayed();
  if (record.revoked_at) throw invalidGrant("Refresh token has been revoked");
  if (Date.parse(record.expires_at) <= Date.now()) throw invalidGrant("Refresh token has expired");
  if (!(await claimRefreshToken(record.id))) throw await replayed();

  const grant = await findOAuthGrant(record.wallet_address, clientId);
  if (!grant) throw connectionRemoved();

  const granted = knownScopes(grant.scopes);
  const held = knownScopes(record.scopes).filter((s) => granted.includes(s));
  const requested = input.scope ? parseApiScopes(input.scope) : null;
  const scopes = requested ? held.filter((s) => requested.includes(s)) : held;
  if (scopes.length === 0) {
    throw new OAuthProtocolError(400, "invalid_scope", "The requested scope is empty or outside this grant");
  }

  const { response, refreshId } = await issueTokens({
    clientId, wallet: record.wallet_address, scopes, grantCreatedAt: Date.parse(grant.created_at),
  });
  await linkRefreshTokenSuccessor(record.id, refreshId);
  return response;
}

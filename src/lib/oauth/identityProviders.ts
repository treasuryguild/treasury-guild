// The accounts a wallet can link for call attendance, and how each provider
// proves one. Both are asked for the least they offer: Discord `identify`
// (user id and name), Google `openid` (the account's `sub`, nothing else).
// The tokens are used once for that lookup and never stored.
import "server-only";

import { IdentityProvider } from "@/lib/constants";
import {
  discordClientId, discordClientSecret, googleClientId, googleClientSecret,
} from "@/lib/env.server";
import { UpstreamError } from "@/lib/errors";
import { postTokenForm } from "./token";

export interface VerifiedIdentity {
  externalId: string;
  displayName: string | null;
}

export interface IdentityProviderAdapter {
  /** Where the user is sent to approve; the caller adds redirect_uri and state. */
  authorizeUrl: () => URL;
  /** Exchange the callback's code and return the account it belongs to. */
  verify: (code: string, redirectUri: string) => Promise<VerifiedIdentity>;
}

/** POST an authorization-code grant; both providers take the same form. */
async function exchangeCode(
  tokenUrl: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { ok, status, body } = await postTokenForm(tokenUrl, { grant_type: "authorization_code", ...fields });
  if (!ok) {
    throw new UpstreamError(`token exchange failed (${status}): ${String(body.error ?? "unknown")}`);
  }
  return body;
}

/**
 * The `sub` of a Google ID token. The token came straight from Google's token
 * endpoint over TLS, so its signature needs no second check (Google's own
 * guidance); issuer and audience still must be ours.
 */
export function googleSubFromIdToken(idToken: string, clientId: string): string {
  const payload = idToken.split(".")[1];
  if (!payload) throw new UpstreamError("Google returned a malformed ID token");
  let claims: { iss?: unknown; aud?: unknown; sub?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims;
  } catch {
    throw new UpstreamError("Google returned a malformed ID token");
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new UpstreamError("ID token was not issued by Google");
  }
  if (claims.aud !== clientId) throw new UpstreamError("ID token was issued for another app");
  if (typeof claims.sub !== "string" || !claims.sub) throw new UpstreamError("ID token has no subject");
  return claims.sub;
}

const discord: IdentityProviderAdapter = {
  authorizeUrl() {
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", discordClientId());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    return url;
  },
  async verify(code, redirectUri) {
    const token = await exchangeCode("https://discord.com/api/oauth2/token", {
      client_id: discordClientId(),
      client_secret: discordClientSecret(),
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${String(token.access_token)}` },
    });
    if (!res.ok) throw new UpstreamError(`Discord user lookup failed (${res.status})`);
    const user = (await res.json()) as { id?: string; username?: string; global_name?: string | null };
    if (!user.id) throw new UpstreamError("Discord returned no user id");
    return { externalId: user.id, displayName: user.global_name || user.username || null };
  },
};

const google: IdentityProviderAdapter = {
  authorizeUrl() {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", googleClientId());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid");
    // People keep several Google accounts signed in: let them pick the one
    // they join meetings with.
    url.searchParams.set("prompt", "select_account");
    return url;
  },
  async verify(code, redirectUri) {
    const token = await exchangeCode("https://oauth2.googleapis.com/token", {
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      code,
      redirect_uri: redirectUri,
    });
    if (typeof token.id_token !== "string") throw new UpstreamError("Google returned no ID token");
    return { externalId: googleSubFromIdToken(token.id_token, googleClientId()), displayName: null };
  },
};

export const IDENTITY_PROVIDERS: Record<IdentityProvider, IdentityProviderAdapter> = {
  [IdentityProvider.Discord]: discord,
  [IdentityProvider.Google]: google,
};

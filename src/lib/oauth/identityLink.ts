// The wallet <-> Discord / Google account link, as route handlers shared by
// /api/discord/* and /api/google/* (the paths are what is registered as
// redirect URIs with each provider). Same shape as the GitHub link: a signed,
// purpose-bound state carries the wallet, the callback is a browser
// navigation so every outcome is a redirect with ?<provider>=<outcome>, and the
// wallet that started the flow must be the one finishing it.
import "server-only";

import { NextResponse } from "next/server";
import { parseQuery, publicRoute, sessionRoute } from "@/lib/api/route";
import { connectQuerySchema, safeReturnTo } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import type { IdentityProvider } from "@/lib/constants";
import { fillAttendeeWalletsByIdentity, linkIdentity, unlinkIdentity } from "@/lib/db/identities";
import { ensureContributor } from "@/lib/db/membership";
import { appUrl } from "@/lib/env.server";
import { ConfigError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { oauthRedirect, readOAuthCallback } from "./callback";
import { IDENTITY_PROVIDERS } from "./identityProviders";
import { signOAuthState, type OAuthPurpose } from "./state";

const PURPOSE: Record<IdentityProvider, OAuthPurpose> = {
  discord: "discord-link",
  google: "google-link",
};

/** Pinned to this deployment: the provider compares it character by character. */
function callbackUrl(provider: IdentityProvider): string {
  return `${appUrl()}/api/${provider}/oauth-callback`;
}

/** GET: send the signed-in wallet to the provider's consent screen. */
export function identityConnectRoute(provider: IdentityProvider) {
  return sessionRoute(async (req, { session }) => {
    const { returnTo: requested } = parseQuery(req, connectQuerySchema);
    const returnTo = safeReturnTo(requested, routes.settings());

    let authorize: URL;
    try {
      authorize = IDENTITY_PROVIDERS[provider].authorizeUrl();
    } catch (err) {
      // A browser navigation: an unconfigured provider is told on the page, as the callback does.
      if (!(err instanceof ConfigError)) throw err;
      console.error(`${provider} connect:`, err.message);
      return oauthRedirect(provider)(returnTo, "error", "oauth_env_missing");
    }
    authorize.searchParams.set("redirect_uri", callbackUrl(provider));
    authorize.searchParams.set(
      "state",
      signOAuthState(PURPOSE[provider], { wallet: session.wallet, returnTo }),
    );
    return NextResponse.redirect(authorize);
  });
}

/** DELETE: forget the wallet's account of this provider. */
export function identityDisconnectRoute(provider: IdentityProvider) {
  return sessionRoute(async (_req, { session }) => {
    await unlinkIdentity(session.wallet, provider);
    return { ok: true } satisfies OkResponse;
  });
}

/** GET: the provider redirects back here with ?code=…&state=… (or ?error=…). */
export function identityCallbackRoute(provider: IdentityProvider) {
  const redirect = oauthRedirect(provider);

  return publicRoute(async (req, { session }) => {
    const callback = readOAuthCallback(req, session, {
      purpose: PURPOSE[provider], fallback: routes.settings(), redirect,
    });
    if (!callback.ok) return callback.response;
    const { code, wallet, returnTo } = callback;

    try {
      const identity = await IDENTITY_PROVIDERS[provider].verify(code, callbackUrl(provider));
      await ensureContributor(wallet);
      const result = await linkIdentity({ wallet, provider, ...identity });
      if (result === "taken") return redirect(returnTo, "taken");
      // Calls captured before the link: attendee rows of this account get the wallet.
      await fillAttendeeWalletsByIdentity(provider, identity.externalId, wallet);
      return redirect(returnTo, "connected");
    } catch (err) {
      console.error(`${provider} oauth-callback error:`, err);
      return redirect(returnTo, "error", err instanceof ConfigError ? "oauth_env_missing" : "exception");
    }
  });
}

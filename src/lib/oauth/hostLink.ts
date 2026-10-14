// A community's host connections (the Discord server, the Zoom and Google
// accounts that host its calls), as route handlers shared by /api/zoom/*,
// /api/google/host-* and /api/discord/guild-*. Admins only, on both ends of
// the round trip: GET connect sends the admin to the provider, the callback
// saves the connection, DELETE forgets it. What differs per provider lives in
// its adapter (hostProviders.ts).
import "server-only";

import { NextResponse } from "next/server";
import { parseJson, parseQuery, publicRoute, sessionRoute } from "@/lib/api/route";
import { guildConnectQuerySchema, guildDisconnectSchema, safeReturnTo } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { memberRole, requireAdmin } from "@/lib/authz";
import type { IntegrationProvider } from "@/lib/constants";
import {
  deleteIntegration, loadIntegration, loadIntegrationSecrets, type IntegrationSecrets,
} from "@/lib/db/callCapture";
import type { CallIntegrationRecord } from "@/lib/db/types";
import { appUrl } from "@/lib/env.server";
import { ConfigError } from "@/lib/errors";
import { isAdminRole } from "@/lib/roles";
import { routes } from "@/lib/routes";
import { oauthRedirect, readOAuthCallback } from "./callback";
import { signOAuthState, type OAuthPurpose } from "./state";

export interface HostLinkAdapter {
  provider: IntegrationProvider;
  purpose: OAuthPurpose;
  /** The outcome's query key on the page the admin returns to. */
  queryKey: string;
  /** The redirect URI path registered with the provider. */
  callbackPath: string;
  /** The consent URL; the route adds redirect_uri and state. */
  authorizeUrl(): URL;
  /** Exchange the code and save the connection: an error reason to report, or null once connected. */
  connect(code: string, redirectUri: string, owner: { communityId: string; wallet: string }): Promise<string | null>;
  /** The reason code for an exception thrown by `connect` (default "exception"). */
  failureReason?(err: unknown): string;
  /** Provider-side cleanup once the connection row (and its tokens) is gone. */
  afterDelete?(integration: CallIntegrationRecord, secrets: IntegrationSecrets | null): Promise<void>;
  /**
   * Undo what the provider already did at consent when the callback is
   * refused before `connect` (bad state, no session, another wallet, no longer
   * an admin). Never saves anything; best effort.
   */
  abandon?(code: string, redirectUri: string): Promise<void>;
}

/** Pinned to this deployment: providers compare it character by character. */
function callbackUrl(adapter: HostLinkAdapter): string {
  return `${appUrl()}${adapter.callbackPath}`;
}

/** GET: send an admin to the provider's consent screen. */
export function hostConnectRoute(adapter: HostLinkAdapter) {
  return sessionRoute(async (req, { session }) => {
    const { communityId, returnTo: requested } = parseQuery(req, guildConnectQuerySchema);
    await requireAdmin(communityId, session.wallet);
    const returnTo = safeReturnTo(requested, routes.home());

    let authorize: URL;
    try {
      authorize = adapter.authorizeUrl();
    } catch (err) {
      // A browser navigation: an unconfigured provider is told on the page, as the callback does.
      if (!(err instanceof ConfigError)) throw err;
      console.error(`${adapter.purpose} connect:`, err.message);
      return oauthRedirect(adapter.queryKey)(returnTo, "error", "oauth_env_missing");
    }
    authorize.searchParams.set("redirect_uri", callbackUrl(adapter));
    authorize.searchParams.set(
      "state",
      signOAuthState(adapter.purpose, { wallet: session.wallet, returnTo, communityId }),
    );
    return NextResponse.redirect(authorize);
  });
}

/** GET: the provider redirects back here with ?code=…&state=… (or ?error=…). */
export function hostCallbackRoute(adapter: HostLinkAdapter) {
  const redirect = oauthRedirect(adapter.queryKey);
  return publicRoute(async (req, { session }) => {
    const callback = readOAuthCallback(req, session, {
      purpose: adapter.purpose, fallback: routes.home(), redirect, needsCommunity: true,
    });
    if (!callback.ok) {
      await abandon(adapter, new URL(req.url).searchParams.get("code"));
      return callback.response;
    }
    const { code, wallet, returnTo } = callback;
    const communityId = callback.state.communityId!;
    // Still an admin when the round trip ends.
    if (!isAdminRole(await memberRole(communityId, wallet))) {
      await abandon(adapter, code);
      return redirect(returnTo, "error", "not_admin");
    }

    try {
      const failure = await adapter.connect(code, callbackUrl(adapter), { communityId, wallet });
      return failure ? redirect(returnTo, "error", failure) : redirect(returnTo, "connected");
    } catch (err) {
      console.error(`${adapter.purpose} callback error:`, err);
      return redirect(returnTo, "error", adapter.failureReason?.(err) ?? "exception");
    }
  });
}

/** A refused callback still carrying a code: let the adapter undo the provider's side. */
async function abandon(adapter: HostLinkAdapter, code: string | null): Promise<void> {
  if (!code || !adapter.abandon) return;
  try {
    await adapter.abandon(code, callbackUrl(adapter));
  } catch (err) {
    console.error(`${adapter.purpose} abandon:`, err);
  }
}

/** DELETE: forget the community's connection to this provider. */
export function hostDisconnectRoute(adapter: HostLinkAdapter) {
  return sessionRoute(async (req, { session }) => {
    const { communityId } = await parseJson(req, guildDisconnectSchema);
    await requireAdmin(communityId, session.wallet);
    const integration = await loadIntegration(communityId, adapter.provider);
    if (integration) {
      // Read before the delete: the tokens go with the row (on delete cascade).
      const secrets = adapter.afterDelete ? await loadIntegrationSecrets(integration.id) : null;
      await deleteIntegration(integration.id);
      await adapter.afterDelete?.(integration, secrets);
    }
    return { ok: true } satisfies OkResponse;
  });
}

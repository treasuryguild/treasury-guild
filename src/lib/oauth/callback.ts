// The part every OAuth callback shares. A callback is a browser navigation, so
// each outcome is a redirect back to where the flow started, with
// ?<queryKey>=<outcome>&reason=<short code> for the page to explain. The
// signed state must be the flow's own, and the wallet that started the flow
// must be the one finishing it.
import "server-only";

import { NextResponse } from "next/server";
import type { SessionClaims } from "@/lib/auth/jwt";
import { appUrl } from "@/lib/env.server";
import { verifyOAuthState, type OAuthPurpose, type OAuthState } from "./state";

export type OAuthRedirect = (path: string, outcome: string, reason?: string) => NextResponse;

/** Redirects that report the outcome under `queryKey` (e.g. ?zoom=connected). */
export function oauthRedirect(queryKey: string): OAuthRedirect {
  return (path, outcome, reason) => {
    const url = new URL(path, appUrl());
    url.searchParams.set(queryKey, outcome);
    if (reason) url.searchParams.set("reason", reason);
    return NextResponse.redirect(url);
  };
}

export type OAuthReturn =
  | { ok: true; state: OAuthState; wallet: string; returnTo: string }
  | { ok: false; response: NextResponse };

export type OAuthCallback =
  | { ok: true; code: string; state: OAuthState; wallet: string; returnTo: string }
  | { ok: false; response: NextResponse };

type ReturnOptions = { purpose: OAuthPurpose; fallback: string; redirect: OAuthRedirect; needsCommunity?: boolean };

/**
 * Check a callback request before any token exchange: the provider's own
 * ?error= (access_denied reads as "cancelled"), the code, the state (with a
 * community when `needsCommunity`), and the session wallet.
 */
export function readOAuthCallback(
  req: Request,
  session: SessionClaims | null,
  options: ReturnOptions,
): OAuthCallback {
  const code = new URL(req.url).searchParams.get("code");
  const result = readReturn(req, session, options, true);
  return result.ok ? { ...result, code: code! } : result;
}

/**
 * The same checks for a round trip that brings back no code (the GitHub App
 * install redirect): provider error, state and session wallet.
 */
export function readOAuthReturn(
  req: Request,
  session: SessionClaims | null,
  options: ReturnOptions,
): OAuthReturn {
  return readReturn(req, session, options, false);
}

function readReturn(
  req: Request,
  session: SessionClaims | null,
  options: ReturnOptions,
  needsCode: boolean,
): OAuthReturn {
  const { purpose, fallback, redirect, needsCommunity } = options;
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = verifyOAuthState(purpose, url.searchParams.get("state") ?? "");
  const returnTo = state?.returnTo ?? fallback;
  const fail = (outcome: string, reason: string): OAuthReturn => ({
    ok: false,
    response: redirect(returnTo, outcome, reason),
  });

  // Authorize-step failures (access_denied, redirect_uri_mismatch) arrive as ?error=.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    console.error(`${purpose} authorize failed:`, {
      error: providerError,
      description: url.searchParams.get("error_description"),
    });
    return fail(providerError === "access_denied" ? "cancelled" : "error", providerError);
  }
  if (needsCode && !code) return fail("error", "no_code");
  if (!state || (needsCommunity && !state.communityId)) return fail("error", "bad_state");
  if (!session) return fail("error", "no_session");
  if (session.wallet !== state.wallet) return fail("error", "wallet_mismatch");
  return { ok: true, state, wallet: session.wallet, returnTo };
}

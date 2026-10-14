import { NextResponse } from "next/server";
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { connectQuerySchema, safeReturnTo } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { unlinkGithubAccount } from "@/lib/db/github";
import { appUrl, githubClientId } from "@/lib/env.server";
import { signOAuthState } from "@/lib/oauth/state";
import { routes } from "@/lib/routes";

// Start the one-off GitHub user OAuth flow that links the session wallet to
// a GitHub account (contributors.github_username). Uses the GitHub App's
// "identifying users" OAuth credentials — no scopes, public profile only.

export const GET = sessionRoute(async (req, { session }) => {
  const { returnTo: requested } = parseQuery(req, connectQuerySchema);
  const returnTo = safeReturnTo(requested, routes.settings());

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", githubClientId());
  // Pin the callback to this environment: with several redirect URIs
  // registered on the GitHub App, GitHub otherwise uses the first one and
  // the flow can land on a host without this user's session cookie.
  authorize.searchParams.set(
    "redirect_uri",
    `${appUrl()}/api/github/oauth-callback`,
  );
  authorize.searchParams.set(
    "state",
    signOAuthState("github-link", { wallet: session.wallet, returnTo }),
  );
  return NextResponse.redirect(authorize);
});

export const DELETE = sessionRoute(async (_req, { session }) => {
  await unlinkGithubAccount(session.wallet);
  return { ok: true } satisfies OkResponse;
});

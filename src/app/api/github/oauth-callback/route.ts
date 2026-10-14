import { publicRoute } from "@/lib/api/route";
import { linkGithubAccount } from "@/lib/db/github";
import { autoJoinCommunitiesForGithubLogin } from "@/lib/db/membership";
import { fillAssigneeWalletsByLogin } from "@/lib/db/taskAssignees";
import { appUrl, githubClientId, githubClientSecret } from "@/lib/env.server";
import { ConfigError } from "@/lib/errors";
import { oauthRedirect, readOAuthCallback } from "@/lib/oauth/callback";
import { routes } from "@/lib/routes";

// GitHub redirects here after the user authorizes:
// GET /api/github/oauth-callback?code=...&state=<signed {wallet, returnTo}>
// This is a browser navigation, so every outcome is a redirect, not JSON.
// Failures carry a short non-sensitive reason code so the settings page can
// show what went wrong instead of a generic message.

const redirect = oauthRedirect("github");

export const GET = publicRoute(async (req, { session }) => {
  const callback = readOAuthCallback(req, session, {
    purpose: "github-link", fallback: routes.settings(), redirect,
  });
  if (!callback.ok) return callback.response;
  const { code, wallet, returnTo } = callback;

  try {
    // GitHub takes the code grant as JSON, unlike the form-encoded providers.
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: githubClientId(),
        client_secret: githubClientSecret(),
        code,
        redirect_uri: `${appUrl()}/api/github/oauth-callback`,
      }),
    });
    const token = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!token.access_token) {
      console.error("github oauth token exchange failed:", {
        error: token.error,
        description: token.error_description,
      });
      return redirect(returnTo, "error", token.error ?? "token_exchange");
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!userRes.ok) {
      console.error("github /user fetch failed:", userRes.status);
      return redirect(returnTo, "error", `user_fetch_${userRes.status}`);
    }
    const user = (await userRes.json()) as { login?: string; id?: number };
    if (!user.login || !user.id) {
      return redirect(returnTo, "error", "user_incomplete");
    }

    const linked = await linkGithubAccount(wallet, { login: user.login, id: user.id });
    if (linked === "taken") return redirect(returnTo, "taken");

    // Backfill: GitHub assignee rows for this login that have no wallet yet.
    // Wallets already set (manually or by an earlier link) are never touched.
    await fillAssigneeWalletsByLogin(user.login, wallet);

    // Auto-join: every community with a task assigned to this login. This is
    // how contributors get into private GitHub-driven communities; the hourly
    // sync covers assignments made after linking.
    await autoJoinCommunitiesForGithubLogin(wallet, user.login);

    return redirect(returnTo, "connected");
  } catch (err) {
    console.error("github oauth-callback error:", err);
    return redirect(returnTo, "error", err instanceof ConfigError ? "oauth_env_missing" : "exception");
  }
});

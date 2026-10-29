// User OAuth during GitHub App installation: exchange the setup `code` and
// check the installing user can see the installation id (so a neighbour id
// cannot be claimed from the signed state alone).
import "server-only";

import { appUrl, githubClientId, githubClientSecret } from "@/lib/env.server";

/** Exchange the setup-callback code for a user access token, or null. */
export async function exchangeInstallCode(code: string): Promise<string | null> {
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
      // Setup URL is the redirect when "Request user authorization during
      // installation" is on; GitHub still validates against the App's
      // callback URL list, which must include /api/github/setup.
      redirect_uri: `${appUrl()}/api/github/setup`,
    }),
  });
  const token = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!token.access_token) {
    console.error("github install token exchange failed:", {
      error: token.error,
      description: token.error_description,
    });
    return null;
  }
  return token.access_token;
}

/**
 * Whether the user token lists `installationId` under GET /user/installations.
 * Paginates; an upstream failure refuses the claim (fail closed).
 */
export async function userSeesInstallation(
  accessToken: string,
  installationId: number,
): Promise<boolean> {
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      console.error("github /user/installations failed:", res.status);
      return false;
    }
    const body = (await res.json()) as {
      installations?: { id: number }[];
      total_count?: number;
    };
    const list = body.installations ?? [];
    if (list.some((i) => i.id === installationId)) return true;
    if (list.length < 100) return false;
    page += 1;
    if (page > 20) return false;
  }
}

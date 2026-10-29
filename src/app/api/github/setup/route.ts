import { parseQuery, publicRoute } from "@/lib/api/route";
import { githubSetupQuerySchema } from "@/lib/api/schemas";
import { memberRole } from "@/lib/authz";
import { installationOwner, saveInstallation } from "@/lib/db/github";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { githubApp } from "@/lib/github/app";
import { exchangeInstallCode, userSeesInstallation } from "@/lib/github/installAuth";
import { installationClaim } from "@/lib/github/installClaim";
import { oauthRedirect, readOAuthCallback } from "@/lib/oauth/callback";
import { isAdminRole } from "@/lib/roles";
import { routes } from "@/lib/routes";
import { TooManyRequestsError } from "@/lib/errors";

// GitHub redirects here after the App is installed (with user OAuth on):
// GET /api/github/setup?installation_id=...&code=...&setup_action=...&state=<signed>
// This is a browser navigation, so every outcome is a redirect back to the
// GitHub settings page with ?install=<outcome>&reason=<code>. The state binds
// the flow to the admin wallet and community that started it; the
// installation id is only a query parameter, so the user code must list it
// and installationClaim decides whether it may be bound (never moved from
// another community). The state's jti is single-use.

const redirect = oauthRedirect("install");

export const GET = publicRoute(async (req, { session }) => {
  const back = readOAuthCallback(req, session, {
    purpose: "github-install", fallback: routes.home(), redirect, needsCommunity: true,
  });
  if (!back.ok) return back.response;
  const { code, wallet, returnTo, state } = back;
  const communityId = state.communityId!;
  if (!state.jti) return redirect(returnTo, "error", "bad_state");
  try {
    await enforceRateLimit("githubInstallState", state.jti);
  } catch (err) {
    if (err instanceof TooManyRequestsError) return redirect(returnTo, "error", "state_replay");
    throw err;
  }
  if (!isAdminRole(await memberRole(communityId, wallet))) {
    return redirect(returnTo, "error", "not_admin");
  }

  let installationId: number;
  try {
    installationId = parseQuery(req, githubSetupQuerySchema).installation_id;
  } catch {
    return redirect(returnTo, "error", "no_installation");
  }

  try {
    const accessToken = await exchangeInstallCode(code);
    if (!accessToken) return redirect(returnTo, "error", "token_exchange");
    if (!(await userSeesInstallation(accessToken, installationId))) {
      return redirect(returnTo, "error", "installation_not_yours");
    }

    const octokit = await githubApp().octokit;
    const { data: installation } = await octokit.rest.apps.getInstallation({
      installation_id: installationId,
    });
    const claim = installationClaim(
      await installationOwner(installationId),
      communityId,
      installation,
      Date.now(),
    );
    if (claim === "taken") return redirect(returnTo, "taken");
    if (claim === "stale") return redirect(returnTo, "error", "installation_not_recent");

    const account = installation.account as {
      login?: string;
      name?: string;
      type?: string;
    } | null;
    await saveInstallation(claim, {
      installation_id: installationId,
      community_id: communityId,
      account_login: account?.login ?? account?.name ?? "unknown",
      account_type: account?.type ?? null,
    });
    return redirect(returnTo, "connected");
  } catch (err) {
    console.error("github setup error:", err);
    return redirect(returnTo, "error", "exception");
  }
});

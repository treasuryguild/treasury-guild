import { parseQuery, publicRoute } from "@/lib/api/route";
import { githubSetupQuerySchema } from "@/lib/api/schemas";
import { memberRole } from "@/lib/authz";
import { installationOwner, saveInstallation } from "@/lib/db/github";
import { githubApp } from "@/lib/github/app";
import { installationClaim } from "@/lib/github/installClaim";
import { oauthRedirect, readOAuthReturn } from "@/lib/oauth/callback";
import { isAdminRole } from "@/lib/roles";
import { routes } from "@/lib/routes";

// GitHub redirects here after the App is installed:
// GET /api/github/setup?installation_id=...&setup_action=...&state=<signed>
// This is a browser navigation, so every outcome is a redirect back to the
// GitHub settings page with ?install=<outcome>&reason=<code>. The state binds
// the flow to the admin wallet and community that started it; the
// installation id is only a query parameter, so installationClaim decides
// whether it may be bound (never moved from another community).

const redirect = oauthRedirect("install");

export const GET = publicRoute(async (req, { session }) => {
  const back = readOAuthReturn(req, session, {
    purpose: "github-install", fallback: routes.home(), redirect, needsCommunity: true,
  });
  if (!back.ok) return back.response;
  const { wallet, returnTo } = back;
  const communityId = back.state.communityId!;
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

import { parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdQuerySchema } from "@/lib/api/schemas";
import type { InstallUrlResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { communitySlug } from "@/lib/db/communities";
import { installUrl } from "@/lib/github/app";
import { signOAuthState } from "@/lib/oauth/state";
import { routes } from "@/lib/routes";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdQuerySchema);
  await requireAdmin(communityId, session.wallet);
  const state = signOAuthState("github-install", {
    wallet: session.wallet,
    returnTo: routes.githubSettings(await communitySlug(communityId)),
    communityId,
  });
  return { url: installUrl(state) } satisfies InstallUrlResponse;
});

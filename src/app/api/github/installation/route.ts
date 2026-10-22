import { parseJson, sessionRoute } from "@/lib/api/route";
import { disconnectInstallationSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { installationOwner } from "@/lib/db/github";
import { NotFoundError } from "@/lib/errors";
import { deleteGithubInstallation } from "@/lib/github/app";
import { removeInstallation } from "@/lib/github/disconnect";

// Disconnect one of the community's GitHub App installations: uninstall it
// on GitHub first (a failure there changes nothing locally, so the admin can
// retry), then drop the local binding for that installation only. Idempotent
// — disconnecting an installation that is already gone is ok. Imported tasks
// and payout history are kept, frozen (see removeInstallation).
export const DELETE = sessionRoute(async (req, { session }) => {
  const { communityId, installationId } = await parseJson(req, disconnectInstallationSchema);
  await requireAdmin(communityId, session.wallet);

  const owner = await installationOwner(installationId);
  if (owner && owner.community_id !== communityId) {
    throw new NotFoundError("GitHub installation not found");
  }
  if (owner) {
    await deleteGithubInstallation(installationId);
    await removeInstallation(installationId);
  }
  return { ok: true } satisfies OkResponse;
});

import { parseJson, sessionRoute } from "@/lib/api/route";
import { syncRepoSchema } from "@/lib/api/schemas";
import type { SyncRepoResponse } from "@/lib/api/types";
import { memberRole, requireAdmin } from "@/lib/authz";
import { loadRepoLink } from "@/lib/db/github";
import { requireActiveWorkgroup } from "@/lib/db/workgroups";
import { NotFoundError } from "@/lib/errors";
import { fullSyncRepo } from "@/lib/github/sync";

export const POST = sessionRoute(async (req, { session }) => {
  const { repoId } = await parseJson(req, syncRepoSchema);

  // A wallet outside the repo's community learns nothing: unlinked and
  // someone else's repo answer the same 404.
  const repo = await loadRepoLink(repoId);
  if (!repo?.community_id || !(await memberRole(repo.community_id, session.wallet))) {
    throw new NotFoundError("Repo not linked");
  }
  await requireAdmin(repo.community_id, session.wallet);
  if (repo.workgroup_id) await requireActiveWorkgroup(repo.workgroup_id);

  const { synced, deleted } = await fullSyncRepo(repo);
  return { synced, deleted } satisfies SyncRepoResponse;
});

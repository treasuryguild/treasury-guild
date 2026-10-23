import { parseJson, sessionRoute } from "@/lib/api/route";
import {
  githubProjectFieldSchema,
  type GithubProjectFieldBody,
} from "@/lib/api/schemas";
import type { GithubProjectFieldResponse } from "@/lib/api/types";
import { ADA_ASSET } from "@/lib/assets";
import { requireWorkgroupManager } from "@/lib/authz";
import { asNetwork } from "@/lib/config";
import { byteLength, MAX_TICKER_BYTES } from "@/lib/cardano/metadata";
import { fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { upsertAssetMappings } from "@/lib/db/assets";
import {
  loadGithubTaskEditTarget,
  loadProjectLinks,
  loadRepoLink,
} from "@/lib/db/github";
import { loadTreasury } from "@/lib/db/treasuries";
import { requireActiveWorkgroup, requireWorkgroupCommunity } from "@/lib/db/workgroups";
import { BadRequestError, NotFoundError, UpstreamError } from "@/lib/errors";
import {
  ensureProjectNumberField,
  fetchProjectItem,
} from "@/lib/github/projectsV2";

// POST /api/github/project-field — create (or reuse) a Projects v2 NUMBER
// field for bounties from ADA or a token held by a community treasury.
// Admins and the workgroup's leads only. Persists community_assets when a
// concrete wallet unit is chosen so payout matching is pinned immediately.

async function resolveProjectTarget(
  body: GithubProjectFieldBody,
  wallet: string,
): Promise<{ communityId: string; installationId: number; projectNodeId: string }> {
  if ("taskId" in body) {
    const task = await loadGithubTaskEditTarget(body.taskId);
    if (!task || task.gh_repo_id === null) throw new NotFoundError("Task not found");
    const communityId = await requireWorkgroupCommunity(task.workgroup_id);
    await requireWorkgroupManager(
      communityId,
      task.workgroup_id,
      wallet,
      "Only admins and workgroup leads can create bounty fields",
    );
    await requireActiveWorkgroup(task.workgroup_id);
    const link = await loadRepoLink(task.gh_repo_id);
    if (!link?.community_id || link.community_id !== communityId || link.workgroup_id !== task.workgroup_id) {
      throw new NotFoundError("Task not found");
    }
    if (!task.gh_project_item_node_id) {
      throw new BadRequestError("This task is not on a project board, so a bounty field cannot be created here");
    }
    let found: Awaited<ReturnType<typeof fetchProjectItem>> = null;
    try {
      found = await fetchProjectItem(link.installation_id, task.gh_project_item_node_id);
    } catch (err) {
      console.error("loading project item for field create failed", err);
      throw new UpstreamError("GitHub project item could not be loaded");
    }
    if (!found?.projectId) throw new NotFoundError("Project item not found");
    return {
      communityId,
      installationId: link.installation_id,
      projectNodeId: found.projectId,
    };
  }

  const communityId = await requireWorkgroupCommunity(body.workgroupId);
  await requireWorkgroupManager(
    communityId,
    body.workgroupId,
    wallet,
    "Only admins and workgroup leads can create bounty fields",
  );
  await requireActiveWorkgroup(body.workgroupId);

  let found: Awaited<ReturnType<typeof fetchProjectItem>> = null;
  let installationId: number | null = null;
  for (const link of await loadProjectLinks(body.workgroupId)) {
    found = await fetchProjectItem(link.installation_id, body.itemNodeId).catch(() => null);
    if (found) {
      installationId = link.installation_id;
      break;
    }
  }
  if (!found || installationId === null) throw new NotFoundError("Project item not found");
  if (!found.issue) throw new BadRequestError("Only GitHub issues can get bounty fields here");
  if (!found.projectId) throw new NotFoundError("Project item not found");
  const link = await loadRepoLink(found.issue.repoId);
  if (!link?.community_id || link.community_id !== communityId || link.workgroup_id !== body.workgroupId) {
    throw new NotFoundError("Project item not found");
  }
  return { communityId, installationId, projectNodeId: found.projectId };
}

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, githubProjectFieldSchema);
  const { communityId, installationId, projectNodeId } = await resolveProjectTarget(
    body,
    session.wallet,
  );

  let fieldName: string;
  let unit: string | null = null;
  let decimals = 0;

  if (body.kind === "ada") {
    if (body.fieldName.toLowerCase() !== ADA_ASSET.fieldName.toLowerCase()) {
      throw new BadRequestError("ADA bounty fields must be named ADA");
    }
    fieldName = ADA_ASSET.fieldName;
  } else {
    if (body.fieldName.toLowerCase() === ADA_ASSET.fieldName.toLowerCase()) {
      throw new BadRequestError("Use kind ada to create an ADA bounty field");
    }
    if (byteLength(body.fieldName) > MAX_TICKER_BYTES) {
      throw new BadRequestError(`Field name must be at most ${MAX_TICKER_BYTES} bytes`);
    }
    const treasury = await loadTreasury(body.treasuryId);
    if (treasury.community_id !== communityId) {
      throw new NotFoundError("Treasury not found");
    }
    const { tokens } = await fetchWalletAssets(asNetwork(treasury.network), treasury.address);
    const held = tokens.find((t) => t.unit === body.unit);
    if (!held) {
      throw new BadRequestError("That token is not held by the selected treasury");
    }
    fieldName = body.fieldName.trim();
    unit = held.unit;
    decimals = held.decimals;
  }

  let ensured: Awaited<ReturnType<typeof ensureProjectNumberField>>;
  try {
    ensured = await ensureProjectNumberField(installationId, projectNodeId, fieldName);
  } catch (err) {
    console.error("creating github project number field failed", err);
    throw new UpstreamError("GitHub project field could not be created");
  }

  if (unit) {
    await upsertAssetMappings(communityId, [
      { fieldName: ensured.fieldName, unit, decimals },
    ]);
  }

  return {
    fieldName: ensured.fieldName,
    created: ensured.created,
    unit,
  } satisfies GithubProjectFieldResponse;
});

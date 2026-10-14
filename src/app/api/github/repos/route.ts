import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdQuerySchema, linkRepoSchema } from "@/lib/api/schemas";
import type { GithubReposResponse, OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import {
  DEFAULT_IMPORT_STATUS,
  DEFAULT_PAID_STATUS,
  DEFAULT_PAYABLE_LABEL,
  TaskSource,
} from "@/lib/constants";
import {
  communityInstallation,
  loadInstallationRepoLinks,
  loadRepoOwnership,
  upsertRepoLink,
  workgroupHasRepos,
} from "@/lib/db/github";
import { requireActiveWorkgroup, setWorkgroupKind, workgroupCommunityId } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, UpstreamError } from "@/lib/errors";
import { installationOctokit } from "@/lib/github/app";

// List the installation's accessible repos (from GitHub) merged with link state.
export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdQuerySchema);
  await requireAdmin(communityId, session.wallet);

  const installation = await communityInstallation(communityId);
  if (!installation) {
    return { installed: false, repos: [] } satisfies GithubReposResponse;
  }

  const octokit = await installationOctokit(installation.installation_id);
  let ghRepos;
  try {
    ghRepos = await octokit.paginate("GET /installation/repositories", { per_page: 100 });
  } catch (err) {
    console.error(`listing repos of installation ${installation.installation_id} failed`, err);
    throw new UpstreamError("GitHub repository list failed");
  }

  const links = await loadInstallationRepoLinks(installation.installation_id);
  const linkById = new Map(links.map((l) => [l.id, l]));

  return {
    installed: true,
    accountLogin: installation.account_login,
    repos: ghRepos.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      private: r.private,
      workgroupId: linkById.get(r.id)?.workgroup_id ?? null,
      payableLabel: linkById.get(r.id)?.payable_label ?? null,
      importStatus: linkById.get(r.id)?.import_status ?? null,
      paidStatus: linkById.get(r.id)?.paid_status ?? null,
    })),
  } satisfies GithubReposResponse;
});

// Link (or update) a repo to a workgroup.
export const POST = sessionRoute(async (req, { session }) => {
  const {
    communityId,
    repoId,
    workgroupId,
    payableLabel,
    importStatus,
    paidStatus,
  } = await parseJson(req, linkRepoSchema);
  await requireAdmin(communityId, session.wallet);

  const installation = await communityInstallation(communityId);
  if (!installation) {
    throw new BadRequestError("GitHub App not installed for this community");
  }
  if ((await workgroupCommunityId(workgroupId)) !== communityId) {
    throw new BadRequestError("Workgroup not found in this community");
  }
  await requireActiveWorkgroup(workgroupId);

  // The repo must be one this community's installation can reach: the id
  // comes from the browser, and a repo belongs to exactly one installation.
  const fullName = await installationRepoName(installation.installation_id, repoId);

  // The link may move this repo between workgroups; the previous workgroup
  // is needed to reset its kind below.
  const previous = await loadRepoOwnership(repoId);
  if (previous && Number(previous.installation_id) !== installation.installation_id) {
    throw new ConflictError("This repository is linked by another community");
  }
  if (previous?.workgroup_id) await requireActiveWorkgroup(previous.workgroup_id);

  await upsertRepoLink({
    id: repoId,
    installation_id: installation.installation_id,
    full_name: fullName,
    workgroup_id: workgroupId,
    payable_label: payableLabel?.trim() || DEFAULT_PAYABLE_LABEL,
    import_status: importStatus?.trim() || DEFAULT_IMPORT_STATUS,
    // Unlike the two above, an explicit "" is meaningful: it disables the move.
    paid_status: paidStatus === undefined ? DEFAULT_PAID_STATUS : paidStatus.trim(),
  });

  // workgroups.kind drives board rendering (github = status columns, no
  // kanban). Set it here, with the link change, rather than trusting the
  // client.
  await setWorkgroupKind(workgroupId, TaskSource.Github);
  if (
    previous?.workgroup_id && previous.workgroup_id !== workgroupId &&
    !(await workgroupHasRepos(previous.workgroup_id))
  ) {
    await setWorkgroupKind(previous.workgroup_id, TaskSource.Native);
  }

  return { ok: true } satisfies OkResponse;
});

/** The repo's full name as the installation sees it; 400 when it cannot see it. */
async function installationRepoName(installationId: number, repoId: number): Promise<string> {
  const octokit = await installationOctokit(installationId);
  try {
    const { data } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: repoId,
    });
    return (data as { full_name: string }).full_name;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 403) {
      throw new BadRequestError("This repository is not available to this community's GitHub installation");
    }
    console.error(`looking up repo ${repoId} for installation ${installationId} failed`, err);
    throw new UpstreamError("GitHub repository lookup failed");
  }
}

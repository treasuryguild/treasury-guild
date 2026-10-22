import { parseJson, sessionRoute } from "@/lib/api/route";
import { githubIssueEditSchema, type GithubIssueEditBody } from "@/lib/api/schemas";
import type { GithubIssueUpdateResponse } from "@/lib/api/types";
import { requireWorkgroupManager } from "@/lib/authz";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { SETTLED_PAY_STATES } from "@/lib/constants";
import {
  loadGithubIssueTask,
  loadGithubTaskEditTarget,
  loadProjectLinks,
  loadRepoLink,
  mirrorGithubTaskEdit,
  type GithubTaskEditTarget,
} from "@/lib/db/github";
import { requireActiveWorkgroup, requireWorkgroupCommunity } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { updateGithubIssue, type GithubIssueEdit } from "@/lib/github/issueWrite";
import { fetchProjectItem } from "@/lib/github/projectsV2";
import { fullSyncRepo, type RepoLink } from "@/lib/github/sync";

// POST /api/github/issue — edit a GitHub issue from the app and push the
// change to GitHub (title, body, labels, open/closed, Project v2 Status and
// bounty number fields). Admins and the workgroup's leads only. The repo is
// re-synced afterwards so the board reflects the import rule at once: moving
// an issue out of the import column or dropping its payable label removes
// its unpaid task here too, as the next webhook/sweep would.

type EditFields = Omit<GithubIssueEditBody, "kind" | "taskId" | "workgroupId" | "itemNodeId">;

function editOf(body: GithubIssueEditBody): GithubIssueEdit {
  const { title, body: issueBody, labels, state, status, amounts } = body as EditFields;
  return {
    ...(title !== undefined ? { title } : {}),
    ...(issueBody !== undefined ? { body: issueBody } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(amounts !== undefined ? { amounts } : {}),
  };
}

/** Settled tasks are payment history: only their text may still be edited from the app. */
function assertSettledEditAllowed(task: Pick<GithubTaskEditTarget, "pay_state">, edit: GithubIssueEdit): void {
  if (!SETTLED_PAY_STATES.includes(task.pay_state)) return;
  if (edit.status !== undefined || edit.amounts !== undefined || edit.labels !== undefined || edit.state !== undefined) {
    throw new ConflictError("This task is already queued or paid, so only its title and description can be edited here");
  }
}

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, githubIssueEditSchema);
  const edit = editOf(body);

  let workgroupId: string;
  let repo: RepoLink;
  let issueNumber: number;
  let projectItemNodeId: string | null;
  let task: GithubTaskEditTarget | null = null;

  if (body.kind === "task") {
    task = await loadGithubTaskEditTarget(body.taskId);
    if (!task || task.gh_repo_id === null || task.gh_issue_number === null) {
      throw new NotFoundError("Task not found");
    }
    workgroupId = task.workgroup_id;
    const communityId = await requireWorkgroupCommunity(workgroupId);
    await requireWorkgroupManager(communityId, workgroupId, session.wallet,
      "Only admins and workgroup leads can edit GitHub issues");
    await requireActiveWorkgroup(workgroupId);
    const link = await loadRepoLink(task.gh_repo_id);
    if (!link?.community_id || link.community_id !== communityId || link.workgroup_id !== workgroupId) {
      throw new NotFoundError("Task not found");
    }
    repo = link;
    issueNumber = task.gh_issue_number;
    projectItemNodeId = task.gh_project_item_node_id;
  } else {
    workgroupId = body.workgroupId;
    const communityId = await requireWorkgroupCommunity(workgroupId);
    await requireWorkgroupManager(communityId, workgroupId, session.wallet,
      "Only admins and workgroup leads can edit GitHub issues");
    await requireActiveWorkgroup(workgroupId);

    // The item's installation is the one whose project link we hold; try
    // each until GitHub resolves the item to an issue.
    let found: Awaited<ReturnType<typeof fetchProjectItem>> = null;
    for (const link of await loadProjectLinks(workgroupId)) {
      found = await fetchProjectItem(link.installation_id, body.itemNodeId).catch(() => null);
      if (found) break;
    }
    if (!found) throw new NotFoundError("Project item not found");
    if (!found.issue) throw new BadRequestError("Only GitHub issues can be edited here");
    const link = await loadRepoLink(found.issue.repoId);
    if (!link?.community_id || link.community_id !== communityId || link.workgroup_id !== workgroupId) {
      throw new NotFoundError("Project item not found");
    }
    repo = link;
    issueNumber = found.issue.number;
    projectItemNodeId = found.itemNodeId;
    const existing = await loadGithubIssueTask(repo.id, issueNumber);
    if (existing) {
      task = await loadGithubTaskEditTarget(existing.id);
    }
  }

  if (task) assertSettledEditAllowed(task, edit);
  if ((edit.status !== undefined || edit.amounts !== undefined) && !projectItemNodeId) {
    throw new BadRequestError("This issue is not on a project board, so its status and bounty cannot be changed here");
  }

  const result = await updateGithubIssue({
    installationId: repo.installation_id,
    repoFullName: repo.full_name,
    issueNumber,
    projectItemNodeId,
    edit,
  });

  // Mirror at once so the board is right even before the webhook lands; the
  // re-sync below then applies the import rule (create/update/remove tasks).
  if (task) {
    const patch: Parameters<typeof mirrorGithubTaskEdit>[1] = {
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.body !== undefined ? { body: edit.body } : {}),
      ...(edit.labels !== undefined ? { gh_labels: edit.labels } : {}),
      ...(result.movedToStatus ? { gh_status: result.movedToStatus } : {}),
    };
    if (edit.amounts !== undefined) {
      const amounts: Record<string, string> = { ...(task.amounts ?? {}) };
      for (const [field, raw] of Object.entries(edit.amounts)) {
        if (raw.trim() === "" || result.missingAmountFields.includes(field)) delete amounts[field];
        else amounts[field] = raw.trim();
      }
      patch.amounts = Object.keys(amounts).length > 0 ? amounts : null;
      const lovelace = adaLovelaceFromAmounts(patch.amounts);
      patch.bounty_lovelace = lovelace ? Number(lovelace) : null;
    }
    await mirrorGithubTaskEdit(task.id, patch);
  }

  let synced = 0;
  let deleted = 0;
  try {
    ({ synced, deleted } = await fullSyncRepo(repo));
  } catch (err) {
    // GitHub already has the edit; the webhook and hourly sweep repair the rest.
    console.error(`re-sync after issue edit failed for ${repo.full_name}:`, err);
  }

  const taskRemoved = task ? (await loadGithubTaskEditTarget(task.id)) === null : false;

  return {
    movedToStatus: result.movedToStatus,
    missingAmountFields: result.missingAmountFields,
    synced,
    deleted,
    taskRemoved,
  } satisfies GithubIssueUpdateResponse;
});

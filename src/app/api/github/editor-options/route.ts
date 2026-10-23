import { parseQuery, sessionRoute } from "@/lib/api/route";
import { githubEditorOptionsQuerySchema } from "@/lib/api/schemas";
import type { GithubEditorOptionsResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import {
  loadGithubTaskEditTarget,
  loadProjectLinks,
  loadRepoLink,
} from "@/lib/db/github";
import { requireWorkgroupCommunity, workgroupIsActive } from "@/lib/db/workgroups";
import { BadRequestError, NotFoundError, UpstreamError } from "@/lib/errors";
import { listAssignableLogins } from "@/lib/github/assignable";
import { fetchProjectItem, listProjectNumberFieldNames } from "@/lib/github/projectsV2";

// GET /api/github/editor-options — assignable logins for the issue's repo and
// the project's number field names (bounty picker). Member-readable; powers
// the task and live-item editors. Query is either `taskId` (imported task) or
// `workgroupId` + `itemNodeId` (live project item).

export const GET = sessionRoute(async (req, { session }) => {
  const query = parseQuery(req, githubEditorOptionsQuerySchema);

  let workgroupId: string;
  let installationId: number;
  let repoFullName: string;
  let projectItemNodeId: string | null;

  if ("taskId" in query) {
    const task = await loadGithubTaskEditTarget(query.taskId);
    if (!task || task.gh_repo_id === null) throw new NotFoundError("Task not found");
    workgroupId = task.workgroup_id;
    const communityId = await requireWorkgroupCommunity(workgroupId);
    await requireMember(communityId, session.wallet);
    if (!(await workgroupIsActive(workgroupId))) {
      return { assignableLogins: [], numberFieldNames: [] } satisfies GithubEditorOptionsResponse;
    }
    const link = await loadRepoLink(task.gh_repo_id);
    if (!link?.community_id || link.community_id !== communityId || link.workgroup_id !== workgroupId) {
      throw new NotFoundError("Task not found");
    }
    installationId = link.installation_id;
    repoFullName = link.full_name;
    projectItemNodeId = task.gh_project_item_node_id;
  } else {
    workgroupId = query.workgroupId;
    const communityId = await requireWorkgroupCommunity(workgroupId);
    await requireMember(communityId, session.wallet);
    if (!(await workgroupIsActive(workgroupId))) {
      return { assignableLogins: [], numberFieldNames: [] } satisfies GithubEditorOptionsResponse;
    }
    let found: Awaited<ReturnType<typeof fetchProjectItem>> = null;
    for (const link of await loadProjectLinks(workgroupId)) {
      found = await fetchProjectItem(link.installation_id, query.itemNodeId).catch(() => null);
      if (found) break;
    }
    if (!found) throw new NotFoundError("Project item not found");
    if (!found.issue) throw new BadRequestError("Only GitHub issues can be edited here");
    const link = await loadRepoLink(found.issue.repoId);
    if (!link?.community_id || link.community_id !== communityId || link.workgroup_id !== workgroupId) {
      throw new NotFoundError("Project item not found");
    }
    installationId = link.installation_id;
    repoFullName = link.full_name;
    projectItemNodeId = found.itemNodeId;
  }

  let assignableLogins: string[] = [];
  let numberFieldNames: string[] = [];
  try {
    assignableLogins = await listAssignableLogins(installationId, repoFullName);
  } catch (err) {
    console.error("listing assignable users failed", err);
    throw new UpstreamError("GitHub assignable users could not be loaded");
  }
  if (projectItemNodeId) {
    try {
      numberFieldNames = await listProjectNumberFieldNames(installationId, projectItemNodeId);
    } catch (err) {
      console.error("listing project number fields failed", err);
      throw new UpstreamError("GitHub project fields could not be loaded");
    }
  }

  return { assignableLogins, numberFieldNames } satisfies GithubEditorOptionsResponse;
});

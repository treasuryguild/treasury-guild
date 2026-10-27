import { parseQuery, sessionRoute } from "@/lib/api/route";
import { workgroupIdQuerySchema } from "@/lib/api/schemas";
import { requireMember } from "@/lib/authz";
import type { LiveBoardResponse, LiveProjectBoard } from "@/lib/boardTypes";
import { deleteProjectLink, loadProjectLinks, loadWorkgroupRepos } from "@/lib/db/github";
import { requireWorkgroupCommunity, workgroupIsActive } from "@/lib/db/workgroups";
import { UpstreamError } from "@/lib/errors";
import { fetchProjectBoard, fetchRepoProjects } from "@/lib/github/projectsV2";
import { splitRepoFullName } from "@/lib/github/repoName";
import { upsertProjectLink } from "@/lib/github/sync";

// GET /api/github/board?workgroupId=... — the full live ProjectV2 board(s)
// feeding a workgroup, member-readable. Read-only: the import filter still
// decides which items become payable tasks; this route only powers display.

// Best-effort per-lambda cache: bounds refresh-hammering on a warm instance;
// cold starts simply refetch.
const boardCache = new Map<string, { at: number; board: LiveProjectBoard }>();
const CACHE_TTL_MS = 60_000;

export const GET = sessionRoute(async (req, { session }) => {
  const { workgroupId } = parseQuery(req, workgroupIdQuerySchema);
  // `?fresh=1`: an explicit reload after an in-app edit must not be served
  // the pre-edit board from the cache (it refills the cache instead).
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";

  const communityId = await requireWorkgroupCommunity(workgroupId);
  await requireMember(communityId, session.wallet);
  if (!(await workgroupIsActive(workgroupId))) {
    return { boards: [], hasRepos: true, repos: [] } satisfies LiveBoardResponse;
  }

  const repos = await loadWorkgroupRepos(workgroupId);
  const repoList = repos.map((r) => ({ id: r.id, fullName: r.full_name }));
  if (repos.length === 0) {
    return { boards: [], hasRepos: false, repos: [] } satisfies LiveBoardResponse;
  }

  // Stored links first; fall back to discovering the repos' open projects
  // (webhooks and the hourly sweep normally populate the links).
  let links = await loadProjectLinks(workgroupId);
  if (links.length === 0) {
    for (const repo of repos) {
      try {
        const { owner, repo: name } = splitRepoFullName(repo.full_name);
        const projects = await fetchRepoProjects(
          repo.installation_id,
          owner,
          name,
        );
        for (const p of projects) {
          if (p.closed) continue;
          await upsertProjectLink(p.id, repo.installation_id, workgroupId);
          links.push({
            project_node_id: p.id,
            installation_id: repo.installation_id,
          });
        }
      } catch (err) {
        console.error(`board discovery failed for ${repo.full_name}:`, err);
      }
    }
    links = [...new Map(links.map((l) => [l.project_node_id, l])).values()];
  }

  const boards: LiveProjectBoard[] = [];
  let failures = 0;
  for (const link of links) {
    const cached = fresh ? undefined : boardCache.get(link.project_node_id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      boards.push(cached.board);
      continue;
    }
    try {
      const board = await fetchProjectBoard(
        link.installation_id,
        link.project_node_id,
      );
      if (!board) {
        // Deleted or unreadable project: drop the stale link.
        await deleteProjectLink(link.project_node_id);
        continue;
      }
      boardCache.set(link.project_node_id, { at: Date.now(), board });
      boards.push(board);
    } catch (err) {
      failures += 1;
      console.error(
        `board fetch failed for project ${link.project_node_id}:`,
        err,
      );
    }
  }

  if (links.length > 0 && boards.length === 0 && failures > 0) {
    throw new UpstreamError("GitHub board fetch failed");
  }

  return {
    boards,
    hasRepos: true,
    repos: repoList,
    ...(failures > 0 ? { partial: true } : {}),
  } satisfies LiveBoardResponse;
});

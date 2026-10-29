// Task sync logic shared by the webhook handler, on-demand sync, and cron.
// Import rule: an issue is a task only while its Project v2 item sits in the
// repo's import_status column AND the issue carries payable_label. Tasks that
// stop matching are deleted while unpaid; settled tasks are frozen.
import "server-only";

import { serviceClient } from "@/lib/supabase/service";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { SETTLED_PAY_STATES } from "@/lib/constants";
import { check, maybe, rows } from "@/lib/db/client";
import { addWorkgroupMember } from "@/lib/db/membership";
import { syncGithubAssignees } from "@/lib/db/taskAssignees";
import { workgroupIsActive } from "@/lib/db/workgroups";
import type { GithubRepoRow } from "@/lib/db/types";
import { fetchRepoIssuesWithProjectFields } from "./projectsV2";
import { splitRepoFullName } from "./repoName";
import {
  decideSyncAction,
  matchesImportFilter,
  type SyncAction,
} from "./syncRules";

export interface SyncedIssue {
  repoId: number;
  issueNumber: number;
  nodeId: string;
  title: string;
  body: string | null;
  url: string;
  labels: string[];
  state?: string;
  projectItemNodeId?: string | null;
  projectStatus?: string | null;
  /**
   * Raw number-field values as decimal strings; undefined means "don't touch
   * stored amounts" (the issues webhook has no project data).
   */
  amounts?: Record<string, string> | null;
  /**
   * Every GitHub assignee (login + immutable user id); undefined means "don't
   * touch", [] means unassigned. The task's github assignee rows mirror this
   * list (added on assign, removed on unassign); each row's wallet is
   * auto-filled from the linked contributor only while null — a wallet set
   * manually stays. Manual assignee rows are never touched by the sync.
   */
  assignees?: { login: string; id: number }[];
}

export type RepoLink = GithubRepoRow;

/**
 * Apply the sync decision for one issue. Returns the action taken. Deletion
 * is skipped (with a log) when payouts rows reference the task — leftovers
 * from rejected transactions must keep their task row.
 */
export async function syncGithubIssue(
  repo: RepoLink,
  issue: SyncedIssue,
  matchesFilter: boolean,
): Promise<SyncAction> {
  if (!repo.workgroup_id || !(await workgroupIsActive(repo.workgroup_id))) return "skip";
  const db = serviceClient();

  const existing = maybe<{ id: string; pay_state: string }>(
    await db
      .from("tasks")
      .select("id, pay_state")
      .eq("gh_repo_id", issue.repoId)
      .eq("gh_issue_number", issue.issueNumber)
      .eq("source", "github")
      .maybeSingle(),
    "sync: load task",
  );

  const settled =
    !!existing && SETTLED_PAY_STATES.includes(existing.pay_state);
  const action = decideSyncAction({
    exists: !!existing,
    settled,
    matchesFilter,
  });

  if (action === "skip") return action;

  if (action === "delete") {
    const payout = maybe<{ id: string }>(
      await db
        .from("payouts")
        .select("id")
        .eq("task_id", existing!.id)
        .limit(1)
        .maybeSingle(),
      "sync: check task payouts",
    );
    if (payout) {
      console.warn(
        `sync: task ${existing!.id} no longer matches import filter but has payout rows; keeping`,
      );
      return "skip";
    }
    check(
      await db.from("tasks").delete().eq("id", existing!.id),
      "sync: delete task",
    );
    return action;
  }

  // GitHub-mirrored text/labels — safe to refresh even on settled tasks.
  const mirror: Record<string, unknown> = {
    title: issue.title,
    body: issue.body,
    gh_node_id: issue.nodeId,
    gh_url: issue.url,
    gh_labels: issue.labels,
    ...(issue.projectItemNodeId
      ? { gh_project_item_node_id: issue.projectItemNodeId }
      : {}),
    ...(issue.projectStatus !== undefined
      ? { gh_status: issue.projectStatus }
      : {}),
    updated_at: new Date().toISOString(),
  };

  if (action === "update_mirror_only") {
    await db.from("tasks").update(mirror).eq("id", existing!.id);
    return action;
  }

  const row: Record<string, unknown> = {
    ...mirror,
    workgroup_id: repo.workgroup_id,
    source: "github" as const,
    gh_repo_id: issue.repoId,
    gh_issue_number: issue.issueNumber,
    // Matching the filter implies the payable label is present.
    audited: true,
    pay_state: "payable",
  };
  if (issue.amounts !== undefined) {
    row.amounts = issue.amounts;
    row.bounty_lovelace = adaLovelaceFromAmounts(issue.amounts);
  }
  let taskId: string;
  if (action === "update") {
    await db.from("tasks").update(row).eq("id", existing!.id);
    taskId = existing!.id;
  } else {
    const { data: inserted, error } = await db
      .from("tasks")
      .insert(row)
      .select("id")
      .single();
    if (error || !inserted) {
      throw new Error(`sync: insert task failed: ${error?.message ?? "no row"}`);
    }
    taskId = inserted.id as string;
  }

  if (issue.assignees !== undefined) {
    const { added } = await syncGithubAssignees(taskId, issue.assignees);
    // A newly assigned linked contributor becomes a community member — the
    // private-community access path for GitHub-driven communities. Only new
    // logins are joined so hourly sweeps don't re-upsert membership.
    for (const a of added) {
      if (a.wallet) await addWorkgroupMember(repo.workgroup_id, a.wallet);
    }
  }
  return action;
}

/**
 * Record which ProjectV2 board(s) feed a workgroup, for the live board view.
 * Update-on-conflict so a project that moves to another workgroup's repo
 * self-heals. Discovered from webhooks, the cron sweep, and the board route.
 */
export async function upsertProjectLink(
  projectNodeId: string,
  installationId: number,
  workgroupId: string,
): Promise<void> {
  if (!(await workgroupIsActive(workgroupId))) return;
  await serviceClient()
    .from("github_project_links")
    .upsert(
      {
        project_node_id: projectNodeId,
        installation_id: installationId,
        workgroup_id: workgroupId,
      },
      { onConflict: "project_node_id" },
    );
}

/**
 * Full sweep of a repo: GraphQL query for labeled issues + their project
 * fields, sync each, then delete unpaid tasks that no longer match (catches
 * label removal, column moves, and removal from the project).
 */
export async function fullSyncRepo(
  repo: RepoLink,
): Promise<{ synced: number; deleted: number }> {
  if (!repo.workgroup_id || !(await workgroupIsActive(repo.workgroup_id))) return { synced: 0, deleted: 0 };
  const { owner, repo: name } = splitRepoFullName(repo.full_name);
  const db = serviceClient();

  const issues = await fetchRepoIssuesWithProjectFields(
    repo.installation_id,
    owner,
    name,
    repo.payable_label,
  );

  let synced = 0;
  let deleted = 0;
  const matchedNumbers = new Set<number>();
  // Every project seen on any issue (not just filter matches) — feeds the
  // live full-board view.
  const projectIds = new Set<string>();
  // Existing tasks by issue number, with the project item each was imported
  // from: lets an issue that left the import column (typically moved to the
  // Paid status after payment) keep mirroring the right item's status.
  const existingRows = rows<{ gh_issue_number: number; gh_project_item_node_id: string | null }>(
    await db
      .from("tasks")
      .select("gh_issue_number, gh_project_item_node_id")
      .eq("gh_repo_id", repo.id)
      .eq("source", "github"),
    "sync: load repo tasks",
  );
  const storedItemByIssue = new Map(
    existingRows.map((t) => [t.gh_issue_number, t.gh_project_item_node_id]),
  );

  for (const issue of issues) {
    for (const item of issue.projectItems) {
      if (item.projectId) projectIds.add(item.projectId);
    }
    // First project item sitting in the import column wins.
    const matched = issue.projectItems.find((p) =>
      matchesImportFilter(repo, issue.labels, p.fields.status),
    );
    // No match but a task exists: settled tasks refresh their mirror (status,
    // labels, text) from the item they came from; unpaid ones are deleted here
    // exactly as the deletion pass below would. Issues without any project
    // item keep their last known status. (An issue that also lost the payable
    // label is not fetched at all, so its status freezes — the live board is
    // unaffected.)
    const item =
      matched ??
      (storedItemByIssue.has(issue.number)
        ? (issue.projectItems.find(
            (p) => p.itemNodeId === storedItemByIssue.get(issue.number),
          ) ?? issue.projectItems[0])
        : undefined);
    if (!item) continue; // deletion pass below handles any stale task
    if (matched) matchedNumbers.add(issue.number);

    const amounts = Object.fromEntries(
      Object.entries(item.fields.numbers).map(([k, v]) => [k, String(v)]),
    );
    const action = await syncGithubIssue(
      repo,
      {
        repoId: repo.id,
        issueNumber: issue.number,
        nodeId: issue.nodeId,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        labels: issue.labels,
        state: issue.state,
        assignees: issue.assignees,
        projectItemNodeId: item.itemNodeId,
        projectStatus: item.fields.status,
        amounts: Object.keys(amounts).length > 0 ? amounts : null,
      },
      !!matched,
    );
    if (action === "insert" || action === "update") synced += 1;
    if (action === "delete") deleted += 1;
  }

  // Deletion reconciliation: unpaid tasks whose issue didn't match this sweep.
  if (!(await workgroupIsActive(repo.workgroup_id))) return { synced, deleted };
  const candidates = rows<{ id: string; gh_issue_number: number }>(
    await db
      .from("tasks")
      .select("id, gh_issue_number")
      .eq("gh_repo_id", repo.id)
      .eq("source", "github")
      .in("pay_state", ["none", "payable"]),
    "sync: load deletion candidates",
  );
  const stale = candidates.filter((t) => !matchedNumbers.has(t.gh_issue_number));
  if (stale.length > 0) {
    const staleIds = stale.map((t) => t.id);
    // A failed read here must not look like "no payouts": those tasks would be deleted.
    const guarded = rows<{ task_id: string }>(
      await db.from("payouts").select("task_id").in("task_id", staleIds),
      "sync: check stale task payouts",
    );
    const guardedIds = new Set(guarded.map((p) => p.task_id));
    const deletable = staleIds.filter((id) => !guardedIds.has(id));
    if (deletable.length > 0) {
      check(
        await db.from("tasks").delete().in("id", deletable),
        "sync: delete stale tasks",
      );
      deleted += deletable.length;
    }
    if (guardedIds.size > 0) {
      console.warn(
        `sync: kept ${guardedIds.size} stale task(s) with payout rows in ${repo.full_name}`,
      );
    }
  }

  for (const projectId of projectIds) {
    await upsertProjectLink(projectId, repo.installation_id, repo.workgroup_id);
  }

  await db
    .from("github_repos")
    .update({ sync_cursor: new Date().toISOString() })
    .eq("id", repo.id);

  return { synced, deleted };
}

import "server-only";

import { PgCode, TaskSource } from "@/lib/constants";
import { check, maybe, rows, serviceClient } from "./client";
import {
  REPO_LINK_COLUMNS,
  type GithubInstallationRow,
  type GithubRepoRow,
} from "./types";

export type RepoLink = GithubRepoRow;

/** Link the wallet's contributor row to a GitHub account; "taken" when another wallet holds it. */
export async function linkGithubAccount(
  wallet: string,
  account: { login: string; id: number },
): Promise<"linked" | "taken"> {
  const { error } = await serviceClient()
    .from("contributors")
    .update({ github_username: account.login, github_user_id: account.id })
    .eq("wallet_address", wallet);
  // unique github_user_id: this GitHub account is already linked to another wallet.
  if (error?.code === PgCode.UniqueViolation) return "taken";
  check({ error }, "link github");
  return "linked";
}

export async function unlinkGithubAccount(wallet: string): Promise<void> {
  check(
    await serviceClient()
      .from("contributors")
      .update({ github_username: null, github_user_id: null })
      .eq("wallet_address", wallet),
    "unlink github",
  );
}

/** Every GitHub App installation a community holds (one per GitHub account), by login. */
export async function communityInstallations(
  communityId: string,
): Promise<GithubInstallationRow[]> {
  return rows<GithubInstallationRow>(
    await serviceClient()
      .from("github_installations")
      .select("installation_id, community_id, account_login, account_type")
      .eq("community_id", communityId)
      .order("account_login"),
    "load github installations",
  );
}

/** Which community holds an installation, if any. */
export async function installationOwner(
  installationId: number,
): Promise<{ community_id: string } | null> {
  return maybe<{ community_id: string }>(
    await serviceClient()
      .from("github_installations")
      .select("community_id")
      .eq("installation_id", installationId)
      .maybeSingle(),
    "load installation owner",
  );
}

/**
 * Bind an installation to a community ("insert"), or refresh the account
 * fields of one it already holds ("update", scoped to that community so a
 * row is never moved). The caller decides which with `installationClaim`.
 */
export async function saveInstallation(
  claim: "insert" | "update",
  row: GithubInstallationRow,
): Promise<void> {
  const db = serviceClient().from("github_installations");
  check(
    claim === "insert"
      ? await db.insert(row)
      : await db
          .update({ account_login: row.account_login, account_type: row.account_type })
          .eq("installation_id", row.installation_id)
          .eq("community_id", row.community_id),
    "save installation",
  );
}

/** A linked repo plus its installation's community (null if the App was
 * uninstalled). */
export async function loadRepoLink(
  repoId: number,
): Promise<(RepoLink & { community_id: string | null }) | null> {
  const row = maybe<RepoLink & { github_installations: { community_id: string } | null }>(
    await serviceClient()
      .from("github_repos")
      .select(`${REPO_LINK_COLUMNS}, github_installations(community_id)`)
      .eq("id", repoId)
      .maybeSingle(),
    "load repo link",
  );
  if (!row) return null;
  const { github_installations, ...repo } = row;
  return { ...repo, community_id: github_installations?.community_id ?? null };
}

/** Linked repos never synced or not synced since `staleBefore`. */
export async function staleRepoLinks(
  limit: number,
  staleBefore: string,
): Promise<RepoLink[]> {
  return rows<RepoLink>(
    await serviceClient()
      .from("github_repos")
      .select(REPO_LINK_COLUMNS)
      .not("workgroup_id", "is", null)
      .or(`sync_cursor.is.null,sync_cursor.lt.${staleBefore}`)
      .limit(limit),
    "load stale repo links",
  );
}

/** The repos feeding a workgroup. */
export async function loadWorkgroupRepos(
  workgroupId: string,
): Promise<{ id: number; installation_id: number; full_name: string }[]> {
  return rows<{ id: number; installation_id: number; full_name: string }>(
    await serviceClient()
      .from("github_repos")
      .select("id, installation_id, full_name")
      .eq("workgroup_id", workgroupId),
    "load workgroup repos",
  );
}

export interface ProjectLink {
  project_node_id: string;
  installation_id: number;
}

/** The ProjectV2 boards known to feed a workgroup. */
export async function loadProjectLinks(workgroupId: string): Promise<ProjectLink[]> {
  return rows<ProjectLink>(
    await serviceClient()
      .from("github_project_links")
      .select("project_node_id, installation_id")
      .eq("workgroup_id", workgroupId),
    "load project links",
  );
}

export async function deleteProjectLink(projectNodeId: string): Promise<void> {
  check(
    await serviceClient().from("github_project_links").delete().eq("project_node_id", projectNodeId),
    "drop stale project link",
  );
}

export type RepoLinkState = Pick<GithubRepoRow, "id" | "workgroup_id" | "payable_label" | "import_status" | "paid_status">;

/** The link state of every repo an installation has linked. */
export async function loadInstallationRepoLinks(installationId: number): Promise<RepoLinkState[]> {
  return rows<RepoLinkState>(
    await serviceClient()
      .from("github_repos")
      .select("id, workgroup_id, payable_label, import_status, paid_status")
      .eq("installation_id", installationId),
    "load repo links",
  );
}

/** Which installation and workgroup hold a repo today, or null when it is not linked. */
export async function loadRepoOwnership(
  repoId: number,
): Promise<{ workgroup_id: string | null; installation_id: number } | null> {
  return maybe<{ workgroup_id: string | null; installation_id: number }>(
    await serviceClient()
      .from("github_repos")
      .select("workgroup_id, installation_id")
      .eq("id", repoId)
      .maybeSingle(),
    "load previous link",
  );
}

export async function upsertRepoLink(row: {
  id: number;
  installation_id: number;
  full_name: string;
  workgroup_id: string;
  payable_label: string;
  import_status: string;
  paid_status: string;
}): Promise<void> {
  check(await serviceClient().from("github_repos").upsert(row), "link repo");
}

export async function workgroupHasRepos(workgroupId: string): Promise<boolean> {
  const remaining = rows<{ id: number }>(
    await serviceClient()
      .from("github_repos")
      .select("id")
      .eq("workgroup_id", workgroupId)
      .limit(1),
    "check remaining repos",
  );
  return remaining.length > 0;
}

/**
 * Record a webhook delivery. X-GitHub-Delivery is unique per delivery, so a
 * unique violation is a redelivery: false, and the caller does nothing. Any
 * other failure throws, so the webhook answers 500 and GitHub retries.
 */
export async function recordWebhookDelivery(delivery: {
  deliveryId: string;
  event: string;
  action: string | null;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  const res = await serviceClient().from("webhook_events").insert({
    delivery_id: delivery.deliveryId,
    event: delivery.event,
    action: delivery.action,
    payload: delivery.payload,
  });
  if (res.error?.code === PgCode.UniqueViolation) return false;
  check(res, "record webhook delivery");
  return true;
}

export async function markWebhookProcessed(deliveryId: string, error: string | null): Promise<void> {
  check(
    await serviceClient()
      .from("webhook_events")
      .update({ processed_at: new Date().toISOString(), error })
      .eq("delivery_id", deliveryId),
    "mark webhook processed",
  );
}

export async function deleteInstallation(installationId: number): Promise<void> {
  check(
    await serviceClient().from("github_installations").delete().eq("installation_id", installationId),
    "delete installation",
  );
}

/** Distinct workgroups an installation feeds, via its repo and project links. */
export async function loadInstallationWorkgroupIds(installationId: number): Promise<string[]> {
  const [repos, projects] = await Promise.all([
    rows<{ workgroup_id: string | null }>(
      await serviceClient()
        .from("github_repos")
        .select("workgroup_id")
        .eq("installation_id", installationId),
      "load installation repo workgroups",
    ),
    rows<{ workgroup_id: string }>(
      await serviceClient()
        .from("github_project_links")
        .select("workgroup_id")
        .eq("installation_id", installationId),
      "load installation project workgroups",
    ),
  ]);
  return [...new Set([...repos.map((r) => r.workgroup_id), ...projects.map((p) => p.workgroup_id)].filter((id): id is string => !!id))];
}

export interface GithubTaskEditTarget {
  id: string;
  workgroup_id: string;
  pay_state: string;
  title: string;
  body: string | null;
  gh_repo_id: number | null;
  gh_issue_number: number | null;
  gh_project_item_node_id: string | null;
  gh_status: string | null;
  gh_labels: string[] | null;
  amounts: Record<string, string> | null;
  bounty_lovelace: number | null;
}

/** A GitHub-source task with everything an in-app issue edit needs, or null. */
export async function loadGithubTaskEditTarget(
  taskId: string,
): Promise<GithubTaskEditTarget | null> {
  return maybe<GithubTaskEditTarget>(
    await serviceClient()
      .from("tasks")
      .select("id, workgroup_id, pay_state, title, body, gh_repo_id, gh_issue_number, gh_project_item_node_id, gh_status, gh_labels, amounts, bounty_lovelace")
      .eq("id", taskId)
      .eq("source", TaskSource.Github)
      .maybeSingle(),
    "load github task",
  );
}

/**
 * Mirror an in-app issue edit into the task row right away (the webhook and
 * sweep re-apply the same values from GitHub). Only the fields the edit
 * named are touched, so a racing sync is never rolled back.
 */
export async function mirrorGithubTaskEdit(
  taskId: string,
  patch: {
    title?: string; body?: string | null; gh_status?: string; gh_labels?: string[];
    amounts?: Record<string, string> | null; bounty_lovelace?: number | null;
  },
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  check(
    await serviceClient()
      .from("tasks")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", taskId),
    "mirror github edit",
  );
}

/** The task mirroring a GitHub issue, or null when the issue was never imported. */
export async function loadGithubIssueTask(
  repoId: number,
  issueNumber: number,
): Promise<{ id: string; gh_status: string | null; pay_state: string } | null> {
  return maybe<{ id: string; gh_status: string | null; pay_state: string }>(
    await serviceClient()
      .from("tasks")
      .select("id, gh_status, pay_state")
      .eq("gh_repo_id", repoId)
      .eq("gh_issue_number", issueNumber)
      .eq("source", TaskSource.Github)
      .maybeSingle(),
    "load task",
  );
}

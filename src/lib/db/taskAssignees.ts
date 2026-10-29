// task_assignees writes (service role only; no client write policies).
// 'github' rows are owned by the GitHub sync and mirror the issue's assignee
// list; their wallet is filled from the linked contributor only while null.
// 'manual' rows are replaced wholesale by managers through the API route.
import "server-only";

import { diffAssigneeLogins } from "@/lib/github/syncRules";
import { check, rows, rpc, serviceClient } from "./client";
import type { TaskAssigneeRow } from "./types";

export type AssigneeWrite =
  | { source: "github"; id: string; wallet: string | null }
  | { source: "manual"; wallet: string };

const TASK_ASSIGNEE_ROW_COLUMNS = "id, task_id, source, gh_login, gh_user_id, wallet_address, position";
// GitHub logins are [A-Za-z0-9-]; anything else never reaches a filter string.
const LOGIN_RE = /^[A-Za-z0-9-]+$/;

export type GithubAssigneeRef = { login: string; id: number };

export async function loadTaskAssignees(taskId: string): Promise<TaskAssigneeRow[]> {
  return rows<TaskAssigneeRow>(
    await serviceClient()
      .from("task_assignees")
      .select(TASK_ASSIGNEE_ROW_COLUMNS)
      .eq("task_id", taskId)
      .order("position"),
    "load task assignees",
  );
}

/**
 * Replace a task's assignee set from the editor in one database step
 * (replace_task_assignees, migration 0063): under the task's row lock,
 * refused (409) once the task is queued, paid or in a live payout; wallets
 * on existing github rows are updated in place (a row the sync removed
 * meanwhile is simply skipped), manual rows are replaced in order.
 */
export async function replaceTaskAssignees(
  taskId: string,
  next: AssigneeWrite[],
): Promise<TaskAssigneeRow[]> {
  rpc(await serviceClient().rpc("replace_task_assignees", { p_task_id: taskId, p_assignees: next }));
  return loadTaskAssignees(taskId);
}

/** wallet by lower-cased GitHub login for every contributor linked to one of `logins`. */
async function walletsByLogin(logins: string[]): Promise<Map<string, string>> {
  const safe = logins.filter((l) => LOGIN_RE.test(l));
  const map = new Map<string, string>();
  if (safe.length === 0) return map;
  const contributors = rows<{ wallet_address: string; github_username: string }>(
    await serviceClient()
      .from("contributors")
      .select("wallet_address, github_username")
      .or(safe.map((l) => `github_username.ilike.${l}`).join(",")),
    "load linked contributors",
  );
  for (const c of contributors) map.set(c.github_username.toLowerCase(), c.wallet_address);
  return map;
}

/**
 * Mirror the issue's assignee list onto the task's github rows: delete rows
 * for logins no longer assigned, insert rows for new ones (with GitHub user
 * id), stamp ids onto existing rows, then fill any github row still without a
 * wallet from the linked contributor (never overwriting, and never
 * duplicating a wallet already on the task). Manual rows are untouched.
 * Returns the newly assigned logins with their wallet (when linked) so the
 * caller can auto-join them to the community.
 */
export async function syncGithubAssignees(
  taskId: string,
  assignees: readonly GithubAssigneeRef[],
): Promise<{ added: { login: string; wallet: string | null }[] }> {
  const db = serviceClient();
  const all = await loadTaskAssignees(taskId);
  const github = all.filter((a) => a.source === "github");
  const logins = assignees.map((a) => a.login);
  const idByLogin = new Map(assignees.map((a) => [a.login.toLowerCase(), a.id]));
  const diff = diffAssigneeLogins(
    github.map((a) => a.gh_login as string),
    logins,
  );

  if (diff.removed.length > 0) {
    const removedKeys = new Set(diff.removed.map((l) => l.toLowerCase()));
    const ids = github
      .filter((a) => removedKeys.has((a.gh_login as string).toLowerCase()))
      .map((a) => a.id);
    check(await db.from("task_assignees").delete().in("id", ids), "remove github assignees");
  }

  if (diff.added.length > 0) {
    const nextPosition = all.reduce((max, a) => Math.max(max, a.position + 1), 0);
    check(
      await db.from("task_assignees").insert(
        diff.added.map((login, i) => ({
          task_id: taskId,
          source: "github",
          gh_login: login,
          gh_user_id: idByLogin.get(login.toLowerCase()) ?? null,
          position: nextPosition + i,
        })),
      ),
      "insert github assignees",
    );
  }

  // Stamp the immutable id onto rows that only have a login (pre-0077 or a
  // rename that kept the row): never clear an id that disagrees.
  for (const row of github) {
    const id = idByLogin.get((row.gh_login as string).toLowerCase());
    if (id === undefined || row.gh_user_id === id) continue;
    if (row.gh_user_id !== null) continue;
    check(
      await db.from("task_assignees").update({ gh_user_id: id }).eq("id", row.id),
      "stamp assignee github user id",
    );
  }

  const current = diff.removed.length > 0 || diff.added.length > 0
    ? await loadTaskAssignees(taskId)
    : all;
  const unlinked = current.filter((a) => a.source === "github" && !a.wallet_address);
  const wallets = await walletsByLogin(unlinked.map((a) => a.gh_login as string));
  const taken = new Set(current.map((a) => a.wallet_address).filter((w): w is string => !!w));
  for (const a of unlinked) {
    const wallet = wallets.get((a.gh_login as string).toLowerCase());
    if (!wallet || taken.has(wallet)) continue;
    check(
      await db.from("task_assignees").update({ wallet_address: wallet }).eq("id", a.id),
      "fill assignee wallet",
    );
    taken.add(wallet);
  }

  return {
    added: diff.added.map((login) => ({
      login,
      wallet: wallets.get(login.toLowerCase()) ?? null,
    })),
  };
}

/**
 * OAuth link backfill: give this wallet to every unlinked github row carrying
 * this GitHub user id, on active tasks only (the archived guard would abort
 * the link flow) and never where the task already pays this wallet. Login
 * alone is unverified (a renamed handle could be re-registered). Returns the
 * number of rows filled.
 */
export async function fillAssigneeWalletsByGithubUser(
  githubUserId: number,
  wallet: string,
): Promise<number> {
  const db = serviceClient();
  const candidates = rows<{
    id: string;
    task_id: string;
    tasks: { archived_at: string | null; workgroups: { archived_at: string | null } | null } | null;
  }>(
    await db
      .from("task_assignees")
      .select("id, task_id, tasks!inner(archived_at, workgroups!inner(archived_at))")
      .eq("gh_user_id", githubUserId)
      .is("wallet_address", null),
    "load unlinked assignee rows by github user id",
  );
  const active = candidates.filter(
    (c) => !c.tasks?.archived_at && !c.tasks?.workgroups?.archived_at,
  );
  if (active.length === 0) return 0;

  const taken = new Set(
    rows<{ task_id: string }>(
      await db
        .from("task_assignees")
        .select("task_id")
        .in("task_id", [...new Set(active.map((c) => c.task_id))])
        .eq("wallet_address", wallet),
      "load tasks already paying wallet",
    ).map((r) => r.task_id),
  );
  const ids = active.filter((c) => !taken.has(c.task_id)).map((c) => c.id);
  if (ids.length === 0) return 0;
  check(
    await db.from("task_assignees").update({ wallet_address: wallet }).in("id", ids),
    "backfill assignee wallets",
  );
  return ids.length;
}

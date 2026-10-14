// Pure helpers for task assignees — the single home for "who gets paid" logic
// shared by the board, Payday and the build-payout route. Client-safe.
//
// Every assignee of a task is paid the task's full amounts; a task is payable
// only when it has at least one assignee and every assignee has a wallet.

import type { TaskAssignee } from "@/lib/db/types";
import { shortAddress } from "@/lib/format";

type Positioned = { position: number };
type Walleted = Positioned & { wallet_address: string | null };
type Labelled = Walleted & Pick<TaskAssignee, "gh_login" | "contributors">;

/** Assignees in stored order (position, then insertion). */
export function sortedAssignees<T extends Positioned>(
  rows: readonly T[] | null | undefined,
): T[] {
  return [...(rows ?? [])].sort((a, b) => a.position - b.position);
}

/** Distinct non-null wallets in position order — one payout output each. */
export function assigneeWallets(rows: readonly Walleted[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const a of sortedAssignees(rows)) {
    if (a.wallet_address) seen.add(a.wallet_address);
  }
  return [...seen];
}

/** True when the task has ≥1 assignee and every one of them has a wallet. */
export function everyAssigneeHasWallet(
  rows: readonly Walleted[] | null | undefined,
): boolean {
  const list = rows ?? [];
  return list.length > 0 && list.every((a) => !!a.wallet_address);
}

/**
 * Why a task cannot be paid yet, as build-payout `problems` lines; empty when
 * it can. Mirrors `everyAssigneeHasWallet` with a reason per assignee.
 */
export function assigneeProblems(
  title: string,
  rows: readonly (Walleted & { gh_login: string | null })[] | null | undefined,
): string[] {
  const list = sortedAssignees(rows);
  if (list.length === 0) return [`${title}: no assignees`];
  return list.flatMap((a, i) => {
    if (a.wallet_address) return [];
    return a.gh_login
      ? [`${title}: @${a.gh_login} has no wallet linked`]
      : [`${title}: assignee #${i + 1} has no wallet`];
  });
}

/** Handle first (self-chosen), then GitHub name, address only as last resort. */
export function contributorLabel(p: {
  wallet: string;
  handle: string | null;
  githubUsername: string | null;
}): string {
  if (p.handle) {
    return p.githubUsername ? `${p.handle} (@${p.githubUsername})` : p.handle;
  }
  return p.githubUsername ? `@${p.githubUsername}` : shortAddress(p.wallet);
}

/** Display label for one assignee row. */
export function assigneeLabel(a: Labelled): string {
  const handle = a.contributors?.handle ?? null;
  const githubUsername = a.gh_login ?? a.contributors?.github_username ?? null;
  if (!handle && !githubUsername && !a.wallet_address) return "unassigned";
  return contributorLabel({ wallet: a.wallet_address ?? "", handle, githubUsername });
}

/** "alice (@alice), @bob, addr_test1…abcdef" */
export function describeAssignees(rows: readonly Labelled[] | null | undefined): string {
  return sortedAssignees(rows).map(assigneeLabel).join(", ");
}

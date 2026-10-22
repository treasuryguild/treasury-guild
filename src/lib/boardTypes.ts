// Pure board helpers and shared task shape — kept free of server-only
// imports so components and unit tests can use them directly.

import { ADA_ASSET, formatQuantity, scaleDecimal } from "@/lib/assets";
import { PAID_PAY_STATES } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import type { BoardColumnRow, TaskAssignee } from "@/lib/db/types";

export interface BoardTask {
  id: string;
  /** Sequential per community; what the on-chain payout metadata cites. */
  number: number;
  title: string;
  body: string | null;
  source: string;
  column_id: string | null;
  /** Every assignee is paid the full amounts (see src/lib/assignees.ts). */
  task_assignees: TaskAssignee[];
  bounty_lovelace: number | null;
  amounts: Record<string, string> | null;
  pay_state: string;
  archived_at: string | null;
  /** Budget month the task is attributed to ("YYYY-MM-DD", day 1) or null. */
  budget_month: string | null;
  /** Hash of the confirmed transaction that paid the task, once confirmed. */
  paid_tx_hash: string | null;
  /** The task number the on-chain payout record names, on a task the chain
   * import created; differs from `number` when it was imported under a new one. */
  chain_number: number | null;
  gh_url: string | null;
  gh_status: string | null;
  gh_labels: string[] | null;
  gh_node_id: string | null;
  gh_repo_id: number | null;
  gh_issue_number: number | null;
}

/** An assignee choice in the task editor. */
export interface MemberOption {
  wallet: string;
  handle: string | null;
  githubUsername: string | null;
}

/** community_members (+contributor profile) rows -> assignee options. */
export function toMemberOptions(
  members: {
    wallet_address: string;
    contributors: { handle: string | null; github_username: string | null } | null;
  }[],
): MemberOption[] {
  return members.map((m) => ({
    wallet: m.wallet_address,
    handle: m.contributors?.handle ?? null,
    githubUsername: m.contributors?.github_username ?? null,
  }));
}

/** Default kanban seeded for app-native boards (workgroup creation and the
 *  empty-board chooser). Audited is the payable trigger; Paid is filled by
 *  the confirm poller once a payout is on-chain. */
export const DEFAULT_BOARD_COLUMNS = [
  { name: "To Do", position: 0, marks_payable: false, marks_paid: false },
  { name: "In Progress", position: 1, marks_payable: false, marks_paid: false },
  { name: "Done", position: 2, marks_payable: false, marks_paid: false },
  { name: "Audited", position: 3, marks_payable: true, marks_paid: false },
  { name: "Paid", position: 4, marks_payable: false, marks_paid: true },
] as const;

/** Paid and reconciled cards stay where the poller put them; archived ones
 *  are off the board anyway. */
export function isTaskDraggable(task: Pick<BoardTask, "pay_state" | "archived_at">): boolean {
  return !task.archived_at && !PAID_PAY_STATES.includes(task.pay_state);
}

/** A card can be dropped anywhere except the Paid column, which only the
 *  confirm poller writes into. */
export function canDropTask(
  task: Pick<BoardTask, "pay_state" | "archived_at">,
  column: Pick<BoardColumnRow, "marks_paid">,
): boolean {
  return isTaskDraggable(task) && !column.marks_paid;
}

// ---------------------------------------------------------------------------
// Live GitHub board wire types (shared by /api/github/board and the client).

export interface LiveBoardItem {
  itemNodeId: string;
  kind: "issue" | "draft" | "pull_request" | "unknown";
  /** Issue node id when kind === "issue" — primary task-match key. */
  contentNodeId: string | null;
  number: number | null;
  title: string;
  url: string | null;
  state: string | null;
  /** Extracted Status single-select value. */
  status: string | null;
  /** Number field values (bounty display). */
  numbers: Record<string, number>;
  labels: string[];
  assigneeLogins: string[];
  repoId: number | null;
  repoFullName: string | null;
}

export interface LiveProjectBoard {
  projectId: string;
  title: string;
  url: string;
  /** Status options in GitHub's board column order, empty columns included. */
  statusOptions: string[];
  items: LiveBoardItem[];
  /** True when the item pagination cap was hit. */
  truncated: boolean;
}

export interface LiveBoardResponse {
  boards: LiveProjectBoard[];
  /** False when the workgroup has no linked repos at all. */
  hasRepos: boolean;
  /** True when some (but not all) projects failed to fetch. */
  partial?: boolean;
}

export interface MergedBoardItem {
  itemNodeId: string;
  title: string;
  url: string | null;
  number: number | null;
  draft: boolean;
  isPullRequest: boolean;
  assigneeLogins: string[];
  labels: string[];
  /** Issue state as GitHub spells it ("OPEN" / "CLOSED"); null for drafts and PRs. */
  state: string | null;
  amounts: Record<string, number>;
  /** Synced task for this item, when the import filter matched it. */
  task: BoardTask | null;
}

export interface MergedBoardColumn {
  name: string;
  items: MergedBoardItem[];
}

export interface MergedBoard {
  projectId: string;
  title: string;
  url: string;
  columns: MergedBoardColumn[];
}

/**
 * Overlay synced tasks onto a live project board. Columns follow
 * statusOptions order and empty ones are kept (the point of the live view);
 * items with no/unknown status collect in a trailing "No status" column that
 * only appears when non-empty. Tasks match by Issue node id first, then by
 * (repo id, issue number); only github-source tasks participate.
 */
export function mergeLiveBoard(
  board: LiveProjectBoard,
  tasks: BoardTask[],
): MergedBoard {
  const byNodeId = new Map<string, BoardTask>();
  const byRepoIssue = new Map<string, BoardTask>();
  for (const t of tasks) {
    if (t.source !== "github") continue;
    if (t.gh_node_id) byNodeId.set(t.gh_node_id, t);
    if (t.gh_repo_id != null && t.gh_issue_number != null) {
      byRepoIssue.set(`${t.gh_repo_id}#${t.gh_issue_number}`, t);
    }
  }

  const toMerged = (item: LiveBoardItem): MergedBoardItem => {
    let task: BoardTask | null = null;
    if (item.kind === "issue") {
      task =
        (item.contentNodeId ? byNodeId.get(item.contentNodeId) : undefined) ??
        (item.repoId != null && item.number != null
          ? byRepoIssue.get(`${item.repoId}#${item.number}`)
          : undefined) ??
        null;
    }
    return {
      itemNodeId: item.itemNodeId,
      title: item.title,
      url: item.url,
      number: item.number,
      draft: item.kind === "draft",
      isPullRequest: item.kind === "pull_request",
      assigneeLogins: item.assigneeLogins,
      labels: item.labels,
      state: item.state,
      amounts: item.numbers,
      task,
    };
  };

  const known = new Set(board.statusOptions);
  const columns: MergedBoardColumn[] = board.statusOptions.map((name) => ({
    name,
    items: [],
  }));
  const byName = new Map(columns.map((c) => [c.name, c]));
  const noStatus: MergedBoardItem[] = [];
  for (const item of board.items) {
    const column = item.status && known.has(item.status)
      ? byName.get(item.status)
      : undefined;
    if (column) column.items.push(toMerged(item));
    else noStatus.push(toMerged(item));
  }
  if (noStatus.length > 0) columns.push({ name: "No status", items: noStatus });

  return {
    projectId: board.projectId,
    title: board.title,
    url: board.url,
    columns,
  };
}

export interface GhStatusGroup {
  status: string | null;
  tasks: BoardTask[];
}

/**
 * Group GitHub-synced tasks into columns by their Project v2 status, in
 * first-seen order (tasks arrive ordered by created_at). Tasks without a
 * status collect in a trailing null group.
 */
export function groupTasksByGhStatus(tasks: BoardTask[]): GhStatusGroup[] {
  const groups = new Map<string, GhStatusGroup>();
  const unstatused: BoardTask[] = [];
  for (const task of tasks) {
    if (!task.gh_status) {
      unstatused.push(task);
      continue;
    }
    let group = groups.get(task.gh_status);
    if (!group) {
      group = { status: task.gh_status, tasks: [] };
      groups.set(task.gh_status, group);
    }
    group.tasks.push(task);
  }
  const out = [...groups.values()];
  if (unstatused.length > 0) out.push({ status: null, tasks: unstatused });
  return out;
}

export interface AmountRow {
  ticker: string;
  amount: string;
}

const AMOUNT_RE = /^\d+(\.\d+)?$/;

/** A call's (or linked meeting's) reward as editable rows; a new one starts with an ADA row. */
export function rewardRows(amounts: Record<string, string> | null | undefined): AmountRow[] {
  return amounts
    ? amountRowsFromTask({ amounts, bounty_lovelace: null })
    : [{ ticker: ADA_ASSET.fieldName, amount: "" }];
}

/** Reward rows -> amounts per attendee. Throws the message to show when invalid or empty. */
export function rewardFromRows(rows: AmountRow[]): Record<string, string> {
  let amounts: Record<string, string> | null;
  try {
    amounts = amountsFromRows(rows);
  } catch (err) {
    throw new Error(errorMessage(err, "Invalid reward"));
  }
  if (!amounts) throw new Error("Set a reward per attendee");
  return amounts;
}

/** A task's bounty as editable rows: amounts entries, else legacy ADA. */
export function amountRowsFromTask(task: {
  amounts: Record<string, string> | null;
  bounty_lovelace: number | null;
}): AmountRow[] {
  if (task.amounts && Object.keys(task.amounts).length > 0) {
    return Object.entries(task.amounts).map(([ticker, amount]) => ({
      ticker,
      amount: String(amount),
    }));
  }
  if (task.bounty_lovelace) {
    return [
      { ticker: ADA_ASSET.fieldName, amount: formatQuantity(BigInt(task.bounty_lovelace), ADA_ASSET.decimals) },
    ];
  }
  return [];
}

/**
 * Editor rows -> tasks.amounts. Blank rows are dropped; an empty result is
 * null (not {}) so the legacy bounty_lovelace fallback in resolveTaskAmounts
 * keeps applying to untouched rows. Throws on malformed amounts and on
 * duplicate tickers (case-insensitive — field matching downstream is ci).
 */
export function amountsFromRows(
  rows: AmountRow[],
): Record<string, string> | null {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const ticker = row.ticker.trim();
    const amount = row.amount.trim();
    if (!ticker && !amount) continue;
    if (!ticker) throw new Error("Every amount needs a token ticker");
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
      throw new Error(`Invalid amount for ${ticker}`);
    }
    const key = ticker.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate ticker ${ticker}`);
    // ADA has known decimals; catching it here beats a silent null bounty.
    if (key === "ada") {
      try {
        scaleDecimal(amount, ADA_ASSET.decimals);
      } catch {
        throw new Error("ADA supports at most 6 decimal places");
      }
    }
    seen.add(key);
    out[ticker] = amount;
  }
  return Object.keys(out).length > 0 ? out : null;
}

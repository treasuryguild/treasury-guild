import "server-only";

import { PayState, PgCode, TaskSource, TxState } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";
import { check, maybe, must, rows, rpc, serviceClient } from "./client";
import { TASK_ASSIGNEE_COLUMNS, TASK_ASSIGNEES_EMBED, type TaskAssignee, type TaskAssigneeRow } from "./types";

/**
 * Queued tasks with no payouts row in a pending, submitted or confirmed
 * transaction go back to payable (release_orphaned_queued_tasks). A rejected
 * or deleted transaction releases its own tasks; this repairs what an older
 * failed release left behind. Returns how many were released.
 */
export async function releaseOrphanedQueuedTasks(): Promise<number> {
  return rpc<number | null>(await serviceClient().rpc("release_orphaned_queued_tasks")) ?? 0;
}

/**
 * Of `taskIds`, the tasks that already have payouts rows in a transaction
 * that was not rejected (pending, submitted or confirmed): paying them again
 * would pay twice, whatever their pay_state says.
 */
export async function tasksWithLivePayouts(taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const payoutRows = rows<{ task_id: string }>(
    await serviceClient()
      .from("payouts")
      .select("task_id, transactions!inner(state)")
      .in("task_id", taskIds)
      .neq("transactions.state", TxState.Rejected),
    "load live payouts",
  );
  return new Set(payoutRows.map((p) => p.task_id));
}

/**
 * Atomically claim `taskIds` for a pending payout transaction: lock in id
 * order, refuse any task that is not payable / already claimed / already in a
 * live payout, then set `live_payout_tx_id` and `pay_state = queued`.
 */
export async function claimTasksForPayout(transactionId: string, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  rpc(
    await serviceClient().rpc("claim_tasks_for_payout", {
      p_transaction_id: transactionId,
      p_task_ids: taskIds,
    }),
    {
      [PgCode.UniqueViolation]: ConflictError,
      [PgCode.CheckViolation]: ConflictError,
      [PgCode.NoDataFound]: ConflictError,
    },
  );
}

/**
 * Stamp a budget month on tasks that have none, so the stored attribution
 * matches what the payout metadata records on-chain. `month` is "YYYY-MM".
 */
export async function setBudgetMonthIfNull(
  taskIds: string[],
  month: string,
): Promise<void> {
  if (taskIds.length === 0) return;
  check(
    await serviceClient()
      .from("tasks")
      .update({ budget_month: `${month}-01` })
      .in("id", taskIds)
      .is("budget_month", null),
    "stamp budget month",
  );
}

export async function markTaskReconciled(taskId: string): Promise<void> {
  check(
    await serviceClient()
      .from("tasks")
      .update({ pay_state: PayState.Reconciled })
      .eq("id", taskId),
    "reconcile task",
  );
}

/** A task as loaded for payout building (joined workgroup + assignees). */
export interface TaskForBuild {
  id: string;
  /** Community task number — the task's on-chain identifier. */
  number: number;
  title: string;
  source: string;
  bounty_lovelace: string | number | null;
  amounts: Record<string, string> | null;
  pay_state: string;
  archived_at: string | null;
  /** "YYYY-MM-DD" (first of month) or null when never assigned. */
  budget_month: string | null;
  workgroup_id: string;
  /** The task proposal that created it (apply_task_proposal), cited by its payout. */
  proposal_id: string | null;
  workgroups: { community_id: string; name: string; archived_at: string | null };
  /** Every assignee is paid the full amounts; all must have a wallet to build. */
  task_assignees: Omit<TaskAssigneeRow, "task_id">[];
}

const TASK_FOR_BUILD_COLUMNS = `id, number, title, source, bounty_lovelace, amounts, pay_state, archived_at, budget_month, workgroup_id, proposal_id, workgroups!inner(community_id, name, archived_at), task_assignees(${TASK_ASSIGNEE_COLUMNS})`;

/**
 * Tasks for a payout build, scoped to `communityId` so a foreign UUID never
 * enters the planner (no title / status disclosure). Assignees editing uses
 * {@link loadTaskForManager} instead (authorize after load).
 */
export async function loadTasksForBuild(
  taskIds: string[],
  communityId: string,
): Promise<TaskForBuild[]> {
  if (taskIds.length === 0) return [];
  return rows<TaskForBuild>(
    await serviceClient()
      .from("tasks")
      .select(TASK_FOR_BUILD_COLUMNS)
      .in("id", taskIds)
      .eq("workgroups.community_id", communityId),
    "load tasks for payout",
  );
}

/** One task by id for assignee edits (authorize on the task's own community). */
export async function loadTaskForManager(taskId: string): Promise<TaskForBuild | null> {
  return maybe<TaskForBuild>(
    await serviceClient()
      .from("tasks")
      .select(TASK_FOR_BUILD_COLUMNS)
      .eq("id", taskId)
      .maybeSingle(),
    "load task for assignees",
  );
}

/** A task as the agent API lists it (src/lib/api/v1/tasks.ts). */
export interface CommunityTask {
  id: string;
  number: number;
  title: string;
  source: string;
  pay_state: string;
  archived_at: string | null;
  bounty_lovelace: number | null;
  amounts: Record<string, string> | null;
  budget_month: string | null;
  paid_tx_hash: string | null;
  gh_url: string | null;
  created_at: string;
  workgroup_id: string;
  workgroups: { name: string } | { name: string }[];
  board_columns: { name: string } | { name: string }[] | null;
  task_assignees: TaskAssignee[];
}

const COMMUNITY_TASK_COLUMNS = `id, number, title, source, pay_state, archived_at, bounty_lovelace, amounts, budget_month, paid_tx_hash, gh_url, created_at, workgroup_id, workgroups!inner(name, community_id), board_columns(name), ${TASK_ASSIGNEES_EMBED}`;

export interface CommunityTaskFilter {
  /** Only these workgroups; all of the community's when omitted. */
  workgroupIds?: string[];
  payState?: PayState;
  includeArchived: boolean;
  limit: number;
}

/** The community's tasks, newest number first, with how many match in all. */
export async function listCommunityTasks(
  communityId: string,
  filter: CommunityTaskFilter,
): Promise<{ tasks: CommunityTask[]; total: number }> {
  let query = serviceClient()
    .from("tasks")
    .select(COMMUNITY_TASK_COLUMNS, { count: "exact" })
    .eq("workgroups.community_id", communityId);
  if (filter.workgroupIds) query = query.in("workgroup_id", filter.workgroupIds);
  if (filter.payState) query = query.eq("pay_state", filter.payState);
  if (!filter.includeArchived) query = query.is("archived_at", null);
  const res = await query.order("number", { ascending: false }).limit(filter.limit);
  return { tasks: rows<CommunityTask>(res, "list community tasks"), total: res.count ?? 0 };
}

/** How many of the community's live tasks are payable right now. */
export async function countPayableTasks(communityId: string): Promise<number> {
  const res = await serviceClient()
    .from("tasks")
    .select("id, workgroups!inner(community_id)", { count: "exact", head: true })
    .eq("workgroups.community_id", communityId)
    .eq("pay_state", PayState.Payable)
    .is("archived_at", null);
  check(res, "count payable tasks");
  return res.count ?? 0;
}

// --- Agent API task writes (src/lib/api/v1/taskWrite.ts) --------------------
// The browser writes tasks through RLS and column grants (0046); the agent API
// writes as the service role, so its endpoint checks in code what those
// guards check (manager, active native board, never past 'none').

/** The fields the agent API may set on an app-board task. */
export interface NativeTaskFields {
  title: string;
  body: string | null;
  amounts: Record<string, string> | null;
  bounty_lovelace: string | null;
  budget_month: string | null;
}

/** A task as the agent API edits it. */
export interface EditableTask extends Omit<NativeTaskFields, "bounty_lovelace"> {
  id: string;
  number: number;
  source: string;
  pay_state: string;
  archived_at: string | null;
  bounty_lovelace: number | string | null;
  community_id: string;
  workgroup_id: string;
}

const EDITABLE_TASK_COLUMNS =
  "id, number, title, body, amounts, bounty_lovelace, budget_month, source, pay_state, archived_at, community_id, workgroup_id";

/** The community's task #N, or null. */
export async function loadTaskByNumber(communityId: string, number: number): Promise<EditableTask | null> {
  return maybe<EditableTask>(
    await serviceClient()
      .from("tasks")
      .select(EDITABLE_TASK_COLUMNS)
      .eq("community_id", communityId)
      .eq("number", number)
      .maybeSingle(),
    "load task by number",
  );
}

/** A task by id, as the agent API edits it, or null. */
export async function loadEditableTask(taskId: string): Promise<EditableTask | null> {
  return maybe<EditableTask>(
    await serviceClient().from("tasks").select(EDITABLE_TASK_COLUMNS).eq("id", taskId).maybeSingle(),
    "load task",
  );
}

/**
 * The board's first column a new task may start in: neither the payable nor
 * the paid one (the rule apply_task_proposal follows), or null.
 */
export async function firstOpenColumn(workgroupId: string): Promise<{ id: string; name: string } | null> {
  return rows<{ id: string; name: string }>(
    await serviceClient()
      .from("board_columns")
      .select("id, name")
      .eq("workgroup_id", workgroupId)
      .eq("marks_payable", false)
      .eq("marks_paid", false)
      .order("position")
      .limit(1),
    "load first open column",
  )[0] ?? null;
}

/** The task an agent API draft created, if it created one. */
export async function findTaskByDraft(draftId: string): Promise<{ id: string; number: number } | null> {
  return maybe<{ id: string; number: number }>(
    await serviceClient().from("tasks").select("id, number").eq("agent_draft_id", draftId).maybeSingle(),
    "find draft task",
  );
}

/**
 * A native task in `columnId`, not payable ('none'), keyed by the draft;
 * null when the draft already made one (unique agent_draft_id).
 */
export async function insertNativeTask(row: NativeTaskFields & {
  workgroup_id: string;
  column_id: string;
  agent_draft_id: string;
}): Promise<{ id: string; number: number } | null> {
  const res = await serviceClient()
    .from("tasks")
    .insert({ ...row, source: TaskSource.Native, pay_state: PayState.None, audited: false })
    .select("id, number")
    .single();
  if (res.error?.code === PgCode.UniqueViolation) return null;
  return must<{ id: string; number: number }>(res, "insert native task");
}

/**
 * Set these fields on a native, unarchived task that is still 'none' (neither
 * payable, queued nor paid). False when it is no longer such a task: the
 * condition is part of the update, so nothing can move it in between.
 */
export async function updateNativeTaskFields(taskId: string, fields: NativeTaskFields): Promise<boolean> {
  return rows<{ id: string }>(
    await serviceClient()
      .from("tasks")
      .update(fields)
      .eq("id", taskId)
      .eq("source", TaskSource.Native)
      .eq("pay_state", PayState.None)
      .is("archived_at", null)
      .select("id"),
    "update native task",
  ).length > 0;
}

/** Each of these tasks' number (#N), by id; a task that is gone is absent. */
export async function taskNumberMap(taskIds: readonly string[]): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  return new Map(rows<{ id: string; number: number }>(
    await serviceClient().from("tasks").select("id, number").in("id", [...new Set(taskIds)]),
    "load task numbers",
  ).map((t) => [t.id, t.number]));
}

/** The numbers of these tasks, in the given order (tasks that are gone left out). */
export async function taskNumbers(taskIds: readonly string[]): Promise<number[]> {
  const found = await taskNumberMap(taskIds);
  return taskIds.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}

/** The community's tasks with these numbers (#N), with their workgroup. */
export async function tasksByNumbers(
  communityId: string,
  numbers: readonly number[],
): Promise<{ id: string; number: number; workgroup_id: string }[]> {
  if (numbers.length === 0) return [];
  return rows<{ id: string; number: number; workgroup_id: string }>(
    await serviceClient().from("tasks").select("id, number, workgroup_id").eq("community_id", communityId).in("number", [...numbers]),
    "load tasks by number",
  );
}

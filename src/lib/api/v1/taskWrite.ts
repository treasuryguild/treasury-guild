// Creating or editing a task on an app (native) board through the agent API.
// task_preview checks what the board would allow (a workgroup manager, an
// active app board, a task never past 'none') and shows before and after;
// draft_confirm writes it, keyed by the draft (tasks.agent_draft_id, 0065).
//
// Deliberately narrow: a task is created in the board's first column that is
// neither payable nor paid, and an edit never moves a column or touches the
// payment state. Making a task payable, one step from a payout, stays in the app.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import type { V1DraftPreview, V1TaskSaveResponse } from "@/lib/api/types";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { sha256Hex } from "@/lib/auth/crypto";
import { requireWorkgroupManager } from "@/lib/authz";
import { rewardFromRows } from "@/lib/boardTypes";
import { taskBudgetPeriod } from "@/lib/budgetSetups";
import { MAX_PROPOSAL_TITLE, PayState, TaskSource } from "@/lib/constants";
import { loadBudgetSetupsForWorkgroups } from "@/lib/db/budgetSetups";
import {
  findTaskByDraft, firstOpenColumn, insertNativeTask, loadEditableTask, loadTaskByNumber, updateNativeTaskFields,
  type EditableTask, type NativeTaskFields,
} from "@/lib/db/tasks";
import { listCommunityWorkgroups, type CommunityWorkgroup } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, errorMessage } from "@/lib/errors";
import { canonicalJson } from "@/lib/governance/rules";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { CONFIRM_NEXT } from "./shape";
import { appLink, communityInput, memberCommunity, resolveCommunityWorkgroup } from "./shared";

const BODY_MAX = 20_000;
const month = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, "Use a month as YYYY-MM");

const taskInput = z.object({
  community: communityInput,
  task: z.coerce.number().int().positive().optional()
    .describe("Edit this task (its number, as task_list shows it); omit to create a task"),
  workgroup: z.string().trim().min(1).max(200).optional()
    .describe("Create on this app board: a workgroup's name or id (workgroup_list)"),
  title: z.string().trim().min(1).max(MAX_PROPOSAL_TITLE).optional().describe("Required to create"),
  body: z.string().max(BODY_MAX).nullable().optional().describe("The task's description (markdown); null clears it"),
  reward: z.record(z.string(), z.string()).nullable().optional()
    .describe('Bounty per assignee, ticker -> amount in display units, e.g. {"ADA": "250"}; null clears it'),
  budgetMonth: month.nullable().optional()
    .describe("The budget month it counts against, YYYY-MM (a quarterly budget's quarter is its first month); null clears it"),
});
type TaskInput = z.infer<typeof taskInput>;

/** The stored reward: validated as the task editor does, with the ADA mirror. */
function rewardFields(reward: Record<string, string> | null): Pick<NativeTaskFields, "amounts" | "bounty_lovelace"> {
  if (reward === null || Object.keys(reward).length === 0) return { amounts: null, bounty_lovelace: null };
  let amounts: Record<string, string>;
  try {
    amounts = rewardFromRows(Object.entries(reward).map(([ticker, amount]) => ({ ticker, amount })));
  } catch (err) {
    throw new BadRequestError(errorMessage(err, "Invalid reward"));
  }
  return { amounts, bounty_lovelace: adaLovelaceFromAmounts(amounts) };
}

/** "YYYY-MM-01", moved to its quarter's first month when the workgroup is budgeted by quarter then. */
async function budgetMonthField(workgroupId: string, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const setups = (await loadBudgetSetupsForWorkgroups([workgroupId])).get(workgroupId) ?? [];
  return `${taskBudgetPeriod(`${value}-01`, setups, value).month}-01`;
}

function snapshot(task: Pick<EditableTask, "title" | "body" | "amounts" | "bounty_lovelace" | "budget_month">): NativeTaskFields {
  return {
    title: task.title,
    body: task.body ?? null,
    amounts: task.amounts && Object.keys(task.amounts).length > 0 ? task.amounts : null,
    bounty_lovelace: task.bounty_lovelace === null ? null : String(task.bounty_lovelace),
    budget_month: task.budget_month ? task.budget_month.slice(0, 10) : null,
  };
}

/** A shown form of the fields, for before / after. */
function shown(f: NativeTaskFields) {
  return {
    title: f.title,
    body: f.body === null ? null : f.body.length > 500 ? `${f.body.slice(0, 499)}…` : f.body,
    reward: f.amounts ?? {},
    budgetMonth: f.budget_month ? f.budget_month.slice(0, 7) : null,
  };
}

/** An active app board the caller manages. */
async function requireEditableBoard(communityId: string, workgroup: CommunityWorkgroup, wallet: string): Promise<void> {
  await requireWorkgroupManager(communityId, workgroup.id, wallet, "Only admins and the workgroup's leads can change its tasks");
  if (workgroup.archived_at !== null) throw new ConflictError(`${workgroup.name} is archived`);
  if (workgroup.kind !== TaskSource.Native) {
    throw new BadRequestError(`${workgroup.name} is a GitHub board: its tasks come from GitHub issues`);
  }
}

async function workgroupById(communityId: string, workgroupId: string): Promise<CommunityWorkgroup> {
  const workgroup = (await listCommunityWorkgroups(communityId)).find((w) => w.id === workgroupId);
  if (!workgroup) throw new BadRequestError("The task's workgroup is gone");
  return workgroup;
}

/** Why this task cannot be edited here, or null. */
function editRefusal(task: EditableTask): string | null {
  if (task.source !== TaskSource.Native) return `Task #${task.number} comes from GitHub: edit the issue there`;
  if (task.archived_at !== null) return `Task #${task.number} is archived`;
  if (task.pay_state !== PayState.None) {
    return `Task #${task.number} is ${task.pay_state}: once a task is payable its reward and budget month change only in the app`;
  }
  return null;
}

export const previewTaskSave = defineEndpoint({
  scope: "tasks:write",
  input: taskInput,
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const base = {
      community: { slug: community.slug, name: community.name },
      action: "task_save",
      next: CONFIRM_NEXT,
    };
    if (input.task === undefined) {
      const created = await createPlan(community.id, input, caller.wallet);
      const { token, expiresAt } = await mintDraftToken(caller, {
        action: "task_save", community: community.slug, request: created.request, fingerprint: created.fingerprint, rulesHash: "",
      });
      return {
        ...base,
        summary: `Create the task "${created.fields.title}" on ${created.workgroup.name}`,
        details: { change: "create", workgroup: created.workgroup.name, column: created.column.name, ...shown(created.fields) },
        effects: [
          `It starts in ${created.column.name}, not payable: the board's leads move it on like any other task.`,
          "Every member can see it on the board.",
        ],
        draftToken: token,
        expiresAt,
      };
    }

    const edit = await editPlan(community.id, input, caller.wallet);
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "task_save", community: community.slug, request: edit.request, fingerprint: edit.fingerprint, rulesHash: "",
    });
    return {
      ...base,
      summary: `Edit task #${edit.task.number}: ${edit.task.title}`,
      details: { change: "update", number: edit.task.number, workgroup: edit.workgroup.name, before: shown(edit.before), after: shown(edit.after) },
      effects: ["Its column and payment state stay as they are."],
      draftToken: token,
      expiresAt,
    };
  },
});

async function createPlan(communityId: string, input: TaskInput, wallet: string) {
  if (!input.workgroup || !input.title) throw new BadRequestError("To create a task give workgroup and title (or task to edit one)");
  const workgroup = await resolveCommunityWorkgroup(communityId, input.workgroup);
  await requireEditableBoard(communityId, workgroup, wallet);
  const column = await firstOpenColumn(workgroup.id);
  if (!column) throw new ConflictError(`${workgroup.name} has no column a new task can start in`);
  const fields: NativeTaskFields = {
    title: input.title,
    body: input.body?.trim() ? input.body : null,
    ...rewardFields(input.reward ?? null),
    budget_month: await budgetMonthField(workgroup.id, input.budgetMonth ?? null),
  };
  const request = { mode: "create", workgroupId: workgroup.id, columnId: column.id, fields };
  return { workgroup, column, fields, request, fingerprint: sha256Hex(canonicalJson(request)) };
}

async function editPlan(communityId: string, input: TaskInput, wallet: string) {
  const task = await loadTaskByNumber(communityId, input.task!);
  if (!task) throw new BadRequestError(`No task #${input.task} in this community`);
  const workgroup = await workgroupById(communityId, task.workgroup_id);
  await requireEditableBoard(communityId, workgroup, wallet);
  const refusal = editRefusal(task);
  if (refusal) throw new BadRequestError(refusal);
  const before = snapshot(task);
  const after: NativeTaskFields = {
    ...before,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body?.trim() ? input.body : null } : {}),
    ...(input.reward !== undefined ? rewardFields(input.reward) : {}),
    ...(input.budgetMonth !== undefined ? { budget_month: await budgetMonthField(workgroup.id, input.budgetMonth) } : {}),
  };
  if (canonicalJson(before) === canonicalJson(after)) throw new BadRequestError("Nothing to change: give title, body, reward or budgetMonth");
  const request = { mode: "update", taskId: task.id, before, after };
  return { task, workgroup, before, after, request, fingerprint: sha256Hex(canonicalJson(request)) };
}

/** The task_save action, run by draft_confirm. */
export async function confirmTaskSave(caller: ApiCaller, draft: VerifiedDraft): Promise<V1TaskSaveResponse> {
  const { community } = await memberCommunity(caller, draft.community);
  if (sha256Hex(canonicalJson(draft.request)) !== draft.fingerprint) throw new BadRequestError("This draft is not valid: preview it again");
  const req = draft.request as {
    mode: "create" | "update"; workgroupId?: string; columnId?: string; taskId?: string;
    fields?: NativeTaskFields; before?: NativeTaskFields; after?: NativeTaskFields;
  };
  const answer = (created: boolean, change: string, number: number, title: string, workgroup: CommunityWorkgroup): V1TaskSaveResponse => ({
    community: { slug: community.slug, name: community.name },
    created,
    change,
    number,
    title,
    workgroup: workgroup.name,
    url: appLink(routes.board(community.slug, workgroup.id)),
  });

  if (req.mode === "create" && req.workgroupId && req.columnId && req.fields) {
    const workgroup = await workgroupById(community.id, req.workgroupId);
    const existing = await findTaskByDraft(draft.draftId);
    if (existing) return answer(false, "created", existing.number, req.fields.title, workgroup);
    await requireEditableBoard(community.id, workgroup, caller.wallet);
    const column = await firstOpenColumn(workgroup.id);
    if (column?.id !== req.columnId) throw new ConflictError(`${workgroup.name}'s columns changed since the preview. Preview it again.`);
    const made = await insertNativeTask({ ...req.fields, workgroup_id: workgroup.id, column_id: column.id, agent_draft_id: draft.draftId });
    if (made) return answer(true, "created", made.number, req.fields.title, workgroup);
    // A concurrent confirm of the same draft won the insert: answer as a repeat.
    const raced = await findTaskByDraft(draft.draftId);
    if (!raced) throw new ConflictError("The task could not be created. Preview it again.");
    return answer(false, "created", raced.number, req.fields.title, workgroup);
  }

  if (req.mode === "update" && req.taskId && req.before && req.after) {
    const task = await loadTaskById(community.id, req.taskId);
    const workgroup = await workgroupById(community.id, task.workgroup_id);
    await requireEditableBoard(community.id, workgroup, caller.wallet);
    const current = snapshot(task);
    // Confirmed before: the task already reads as the preview's "after".
    if (canonicalJson(current) === canonicalJson(req.after)) return answer(false, "updated", task.number, task.title, workgroup);
    if (canonicalJson(current) !== canonicalJson(req.before)) {
      throw new ConflictError(`Task #${task.number} changed since the preview. Preview the edit again.`);
    }
    const refusal = editRefusal(task);
    if (refusal || !(await updateNativeTaskFields(task.id, req.after))) {
      throw new ConflictError(refusal ?? `Task #${task.number} moved on since the preview (it is no longer an unpaid draft task).`);
    }
    return answer(true, "updated", task.number, req.after.title, workgroup);
  }
  throw new BadRequestError("This draft is not valid: preview it again");
}

async function loadTaskById(communityId: string, taskId: string): Promise<EditableTask> {
  const task = await loadEditableTask(taskId);
  if (!task || task.community_id !== communityId) throw new BadRequestError("The task is gone");
  return task;
}

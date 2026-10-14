// A community's tasks: reward, assignees and where each stands on the way to
// being paid.
import "server-only";

import { z } from "zod";
import type { V1Task, V1TasksResponse } from "@/lib/api/types";
import { everyAssigneeHasWallet } from "@/lib/assignees";
import { PayState, TaskSource } from "@/lib/constants";
import { optionalRelation, relation } from "@/lib/db/client";
import { countPayableTasks, listCommunityTasks, type CommunityTask } from "@/lib/db/tasks";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { assigneeSummaries, budgetMonthOf, taskReward } from "./shape";
import { appLink, communityInput, memberCommunity, resolveCommunityWorkgroup } from "./shared";

export const TASK_LIST_MAX = 200;

function describeTask(slug: string, task: CommunityTask): V1Task {
  const archived = task.archived_at !== null;
  return {
    number: task.number,
    title: task.title,
    workgroup: relation(task.workgroups).name,
    column: optionalRelation(task.board_columns)?.name ?? null,
    source: task.source === TaskSource.Native ? "native" : "github",
    payState: task.pay_state,
    archived,
    reward: taskReward(task),
    assignees: assigneeSummaries(task.task_assignees),
    readyToPay: task.pay_state === PayState.Payable && !archived && everyAssigneeHasWallet(task.task_assignees),
    budgetMonth: budgetMonthOf(task.budget_month),
    paidTxHash: task.paid_tx_hash,
    githubUrl: task.gh_url,
    url: appLink(routes.board(slug, task.workgroup_id)),
  };
}

export const listTasks = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    workgroup: z.string().trim().min(1).max(200).optional()
      .describe("Only this workgroup: its name (case-insensitive) or id"),
    payState: z.enum([PayState.None, PayState.Payable, PayState.Queued, PayState.Paid, PayState.Reconciled]).optional()
      .describe("Only tasks in this payment state: payable = approved and waiting for a payout"),
    includeArchived: z.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(TASK_LIST_MAX).default(50)
      .describe("Newest tasks first, at most this many"),
  }),
  async run(caller, input): Promise<V1TasksResponse> {
    const { community } = await memberCommunity(caller, input.community);

    const workgroupIds = input.workgroup
      ? [(await resolveCommunityWorkgroup(community.id, input.workgroup)).id]
      : undefined;

    const [{ tasks, total }, payableCount] = await Promise.all([
      listCommunityTasks(community.id, {
        workgroupIds,
        payState: input.payState,
        includeArchived: input.includeArchived,
        limit: input.limit,
      }),
      countPayableTasks(community.id),
    ]);

    return {
      community: { slug: community.slug, name: community.name },
      tasks: tasks.map((task) => describeTask(community.slug, task)),
      total,
      payableCount,
    };
  },
});

// Payout drafts through the agent API. payout_preview picks the tasks (the
// numbers given, or every task ready to pay) and the treasury they are routed
// to, runs every check of a payout build (planPayout, the code behind the
// Payday page) and shows who would receive what; draft_confirm builds it again
// and stores it as the treasury's pending transaction, keyed by the draft
// (transactions.agent_draft_id, 0065).
//
// Nothing is paid here: the transaction waits for the treasury's signers,
// who sign it in the app with their wallets. No tool signs or submits.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import type { V1DraftPreview, V1PayoutCreateResponse } from "@/lib/api/types";
import { unitTicker } from "@/lib/assetRegistry";
import { everyAssigneeHasWallet } from "@/lib/assignees";
import { sha256Hex } from "@/lib/auth/crypto";
import { pathLabel, pathRule } from "@/lib/cardano/spendingPaths";
import { requiredSignatures } from "@/lib/cardano/thresholds";
import { PayState } from "@/lib/constants";
import { loadMemberLabels } from "@/lib/db/payments";
import { listCommunityTasks, tasksByNumbers } from "@/lib/db/tasks";
import { findTransactionByDraft, type DraftTransaction } from "@/lib/db/transactions";
import { listCommunityTreasuries } from "@/lib/db/treasuries";
import { listCommunityWorkgroups } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError } from "@/lib/errors";
import { spendProblemText } from "@/lib/governance/spendCheck";
import { canonicalJson } from "@/lib/governance/rules";
import { voterName } from "@/lib/governance/labels";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { persistPayout, planPayout, type PayoutPlan } from "@/lib/payout/build";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { CONFIRM_NEXT, displayQuantity, taskReward } from "./shape";
import { appLink, communityInput, memberCommunity, resolveCommunityTreasury, resolveCommunityWorkgroup } from "./shared";

const MAX_PAYOUT_TASKS = 200;

/** What the user agrees to: who is paid what for which tasks, from where, on which path, with which budget problems. */
function payoutFingerprint(plan: PayoutPlan): string {
  return sha256Hex(canonicalJson({
    treasuryId: plan.treasuryId,
    path: plan.path,
    recipients: plan.recipients
      .map((r) => ({
        wallet: r.contributorWallet,
        tasks: r.tasks
          .map((t) => ({ task: t.taskId, amounts: t.amounts.map((a) => [a.unit, a.quantity.toString()]).sort() }))
          .sort((a, b) => a.task.localeCompare(b.task)),
      }))
      .sort((a, b) => a.wallet.localeCompare(b.wallet)),
    spendProblems: plan.spendProblems,
  }));
}

function amountText(plan: PayoutPlan, unit: string, quantity: bigint): { token: string; amount: string } {
  return { token: unitTicker(unit, plan.unitDisplay), amount: displayQuantity(quantity, plan.unitDisplay.get(unit)?.decimals ?? 0) };
}

export const previewPayout = defineEndpoint({
  scope: "payouts:write",
  input: z.object({
    community: communityInput,
    tasks: z.array(z.coerce.number().int().positive()).min(1).max(MAX_PAYOUT_TASKS).optional()
      .describe("The task numbers to pay; omit to pay every task that is ready (payable, every assignee linked, a bounty set)"),
    treasury: z.string().trim().min(1).max(200).optional()
      .describe("The treasury to pay from: name or id. Defaults to the one the tasks' workgroups are routed to, or the community's only treasury"),
    workgroup: z.string().trim().min(1).max(200).optional()
      .describe("With no task numbers: only this workgroup's ready tasks"),
  }),
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const [treasuries, workgroups] = await Promise.all([
      listCommunityTreasuries(community.id),
      listCommunityWorkgroups(community.id),
    ]);
    if (treasuries.length === 0) throw new BadRequestError("This community has no treasury yet");
    const routedTo = new Map(workgroups.map((w) => [w.id, w.treasury_id]));

    // The tasks: the numbers asked for, or every ready one.
    let selected: { id: string; number: number; workgroup_id: string }[];
    if (input.tasks) {
      const numbers = [...new Set(input.tasks)];
      selected = await tasksByNumbers(community.id, numbers);
      const missing = numbers.filter((n) => !selected.some((t) => t.number === n));
      if (missing.length > 0) throw new BadRequestError(`No task #${missing.join(", #")} in this community`);
    } else {
      const only = input.workgroup ? (await resolveCommunityWorkgroup(community.id, input.workgroup)).id : null;
      const { tasks } = await listCommunityTasks(community.id, {
        workgroupIds: only ? [only] : undefined,
        payState: PayState.Payable,
        includeArchived: false,
        limit: MAX_PAYOUT_TASKS,
      });
      selected = tasks
        .filter((t) => everyAssigneeHasWallet(t.task_assignees) && Object.keys(taskReward(t)).length > 0)
        .map((t) => ({ id: t.id, number: t.number, workgroup_id: t.workgroup_id }));
    }

    // The treasury: asked for, the only one, or the one the tasks' workgroups are routed to now.
    let treasury = input.treasury ? await resolveCommunityTreasury(community.id, input.treasury) : null;
    if (!treasury) {
      if (treasuries.length === 1) {
        treasury = treasuries[0]!;
      } else {
        const routed = [...new Set(selected.map((t) => routedTo.get(t.workgroup_id)).filter((id): id is string => !!id))];
        if (routed.length !== 1) {
          throw new BadRequestError(
            `Say which treasury to pay from: ${routed.length > 1 ? "these tasks are routed to different treasuries" : "the tasks' workgroups are not routed to one"}. Treasuries: ${treasuries.map((t) => t.name).join(", ")}`,
          );
        }
        treasury = treasuries.find((t) => t.id === routed[0])!;
      }
    }
    // Paying everything ready from one treasury: leave out what another treasury pays.
    if (!input.tasks) {
      selected = selected.filter((t) => {
        const routed = routedTo.get(t.workgroup_id);
        return !routed || routed === treasury.id;
      });
    }
    if (selected.length === 0) throw new BadRequestError(`No task is ready to pay from ${treasury.name}`);

    const request = { treasuryId: treasury.id, taskIds: selected.map((t) => t.id).sort() };
    const plan = await planPayout(request, caller.wallet);
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "payout_create",
      community: community.slug,
      request,
      fingerprint: payoutFingerprint(plan),
      rulesHash: "",
    });

    const names = await loadMemberLabels(community.id, plan.recipients.map((r) => r.contributorWallet));
    const totals = [...plan.built.totalByUnit.entries()].map(([unit, quantity]) => amountText(plan, unit, quantity));
    const rule = pathRule(plan.ctx.treasury, plan.ctx.signers, plan.path);
    return {
      community: { slug: community.slug, name: community.name },
      action: "payout_create",
      summary: `Prepare a payout of ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} to ${plan.recipients.length} recipient${plan.recipients.length === 1 ? "" : "s"} from ${treasury.name}: ${totals.map((t) => `${t.amount} ${t.token}`).join(" + ")}`,
      details: {
        treasury: treasury.name,
        spendingPath: pathLabel(plan.path),
        requiredSignatures: requiredSignatures(rule),
        tasks: plan.tasks.map((t) => ({ number: t.number, title: t.title, workgroup: t.workgroups.name, budgetPeriod: plan.periods.get(t.id)?.code })),
        recipients: plan.recipients.map((r) => ({
          name: voterName(r.contributorWallet, names.get(r.contributorWallet)),
          wallet: r.contributorWallet,
          tasks: r.tasks.map((t) => t.taskNumber),
          amounts: Object.values(
            r.tasks.flatMap((t) => t.amounts).reduce<Record<string, { unit: string; quantity: bigint }>>((sum, a) => {
              sum[a.unit] = { unit: a.unit, quantity: (sum[a.unit]?.quantity ?? 0n) + a.quantity };
              return sum;
            }, {}),
          ).map((a) => amountText(plan, a.unit, a.quantity)),
        })),
        total: totals,
      },
      effects: [
        `It becomes ${treasury.name}'s pending transaction: no other payout or payment can be built from that treasury until it is signed and submitted, or rejected.`,
        `Nothing is paid until ${requiredSignatures(rule)} signer${requiredSignatures(rule) === 1 ? "" : "s"} sign it in the app; the network fee is added when it is built.`,
        "The tasks are queued for this payout and leave the payable list.",
      ],
      ...(plan.spendProblems.length > 0 ? { problems: plan.spendProblems.map(spendProblemText) } : {}),
      next: CONFIRM_NEXT,
      draftToken: token,
      expiresAt,
    };
  },
});

/** The payout_create action, run by draft_confirm: the pending transaction, never a signature. */
export async function confirmPayout(caller: ApiCaller, draft: VerifiedDraft): Promise<V1PayoutCreateResponse> {
  const { community } = await memberCommunity(caller, draft.community);
  const treasuryId = typeof draft.request.treasuryId === "string" ? draft.request.treasuryId : "";
  const taskIds = Array.isArray(draft.request.taskIds) ? draft.request.taskIds.filter((id): id is string => typeof id === "string") : [];
  const treasuries = await listCommunityTreasuries(community.id);
  const treasury = treasuries.find((t) => t.id === treasuryId);
  if (!treasury || taskIds.length === 0) throw new BadRequestError("This draft is not valid: preview it again");

  // The count follows the path the transaction was stored on, so a repeat answers like the first.
  const answer = (created: boolean, tx: Pick<DraftTransaction, "id" | "tx_hash" | "spending_path">): V1PayoutCreateResponse => ({
    community: { slug: community.slug, name: community.name },
    created,
    txId: tx.id,
    txHash: tx.tx_hash,
    treasury: treasury.name,
    requiredSignatures: requiredSignatures(pathRule(treasury, treasury.treasury_signers, tx.spending_path)),
    url: appLink(routes.tx(community.slug, tx.id)),
  });
  // Confirmed before: answer with the transaction it made.
  const existing = await findTransactionByDraft(draft.draftId);
  if (existing) return answer(false, existing);

  const plan = await planPayout({ treasuryId, taskIds }, caller.wallet);
  if (payoutFingerprint(plan) !== draft.fingerprint) {
    throw new ConflictError("The payout changed since the preview (tasks, amounts, recipients or budget problems). Preview it again.");
  }
  try {
    return answer(true, await persistPayout(plan, caller.wallet, { agentDraftId: draft.draftId }));
  } catch (err) {
    // A confirmation racing this one stored it first (the one pending transaction per treasury).
    const raced = err instanceof ConflictError ? await findTransactionByDraft(draft.draftId) : null;
    if (raced) return answer(false, raced);
    throw err;
  }
}

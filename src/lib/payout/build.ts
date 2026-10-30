// Building a payout transaction, in two steps: planPayout runs every check
// build-payout makes (who may build, the tasks, routing, tokens, assignees,
// the spending check, recipients' network) and builds the unsigned
// transaction, writing nothing; persistPayout stores it as the treasury's
// pending transaction with its payouts rows and queued tasks. The route
// (POST /api/tx/build-payout) runs both; the agent API's payout draft runs
// planPayout for its preview and both again when the user confirms.
import "server-only";

import { unitDisplayFromRegistry, unitTicker } from "@/lib/assetRegistry";
import { AssetResolutionError, resolveTaskAmounts, type AssetDef } from "@/lib/assets";
import { assigneeProblems, assigneeWallets } from "@/lib/assignees";
import { isTreasuryActor, leadsAllWorkgroups } from "@/lib/authz";
import { currentBudgetMonth, isFutureBudgetMonth } from "@/lib/budgets";
import { taskBudgetPeriod, type TaskBudgetPeriod } from "@/lib/budgetSetups";
import { buildPayoutTx } from "@/lib/cardano/payoutBuilder";
import { countPayments, groupByRecipient, recipientsOffNetwork } from "@/lib/cardano/payoutRecipients";
import { getProvider } from "@/lib/cardano/provider";
import { fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { networkName } from "@/lib/config";
import { PayState, TxKind, type SpendingPath } from "@/lib/constants";
import { recordProposalAnchors } from "@/lib/db/anchors";
import { loadAssetRegistry, upsertAssetMappings } from "@/lib/db/assets";
import { loadBudgetSetupsForWorkgroups, loadBudgetSources } from "@/lib/db/budgetSetups";
import { loadProposalCitations } from "@/lib/db/governance";
import { claimTasksForPayout, loadTasksForBuild, setBudgetMonthIfNull, tasksWithLivePayouts, type TaskForBuild } from "@/lib/db/tasks";
import { assertNoPendingTx, insertPayouts, withTransactionRow } from "@/lib/db/transactions";
import { assertTreasuryActive } from "@/lib/db/treasuries";
import type { TransactionRow } from "@/lib/db/types";
import { loadTreasuryAssignmentsForWorkgroups } from "@/lib/db/workgroupRouting";
import { BadRequestError, ConflictError, ForbiddenError } from "@/lib/errors";
import { loadDueAnchorsBestEffort } from "@/lib/governance/anchorsDue";
import { citationsOf } from "@/lib/governance/citations";
import { budgetOwnerKey } from "@/lib/governance/payload";
import { spendKey, type SpendProblem } from "@/lib/governance/spendCheck";
import { budgetsForLines, guardSpend, type SpendGuardLine } from "@/lib/governance/spendGuard";
import { matchTokensToFields } from "@/lib/tokenMatch";
import { resolveTreasuryScript } from "@/lib/treasury";
import { builtTickers, loadBuildContext, resolveSpendingPath, validFromSlotFor, validToSlotFor, type BuildContext } from "@/lib/tx";
import { payoutDescription } from "@/lib/txDescription";
import { routedTreasuryAt } from "@/lib/workgroupRouting";

const ADA_FIELD = "ada";

/** What the builder throws as a plain Error but is the request's problem, not the server's. */
const BUILD_REFUSALS = [/insufficient treasury funds/i, /payout too large/i, /no recipients/i];

export interface PayoutInput {
  treasuryId: string;
  path?: SpendingPath;
  taskIds: string[];
  /** Bounty field name -> token unit, for fields auto-matching did not resolve. */
  connections?: Record<string, string>;
}

type Built = Awaited<ReturnType<typeof buildPayoutTx>>;
type Recipient = ReturnType<typeof groupByRecipient>[number];

export interface PayoutPlan {
  treasuryId: string;
  ctx: BuildContext;
  path: SpendingPath;
  tasks: TaskForBuild[];
  periods: Map<string, TaskBudgetPeriod>;
  recipients: Recipient[];
  payments: number;
  unitDisplay: ReturnType<typeof unitDisplayFromRegistry>;
  spendProblems: SpendProblem[];
  built: Built;
  carried: Awaited<ReturnType<typeof loadDueAnchorsBestEffort>>;
  /** Token mappings to remember: auto-matched (unless overridden) and manual. */
  mappings: AssetDef[];
  /** Spend TTL slot stamped on the CBOR and the transaction row. */
  validToSlot: number;
}

/** Every check of a payout build, and the unsigned transaction; writes nothing. */
export async function planPayout(input: PayoutInput, wallet: string): Promise<PayoutPlan> {
  const { treasuryId, path: requestedPath, taskIds, connections } = input;
  const ctx = await loadBuildContext(treasuryId, wallet);
  const { treasury, signers, network } = ctx;
  assertTreasuryActive(treasury);
  // Base signers of this treasury can build for any workgroup; a workgroup
  // lead can build only when every selected task is in a workgroup they
  // lead (checked below, once tasks are loaded). Community admin alone is
  // not enough. Signing stays signer-only.
  const canBuildAnywhere = isTreasuryActor(ctx.role, ctx.isSigner);
  // Payouts never take the recovery path, so the path only picks the rule.
  const path = resolveSpendingPath(ctx, requestedPath, TxKind.Payout);

  await assertNoPendingTx(treasuryId);

  const persisted = await loadAssetRegistry(treasury.community_id);
  // Scoped to this community: foreign UUIDs never load (no title disclosure).
  const tasks = await loadTasksForBuild(taskIds, treasury.community_id);
  const problems: string[] = [];
  const foundIds = new Set(tasks.map((t) => t.id));
  for (const id of new Set(taskIds)) {
    if (!foundIds.has(id)) {
      problems.push(`${id}: task not found or not in this community`);
    }
  }
  if (tasks.some((task) => task.archived_at)) {
    throw new BadRequestError("Restore archived tasks before creating payouts");
  }
  if (tasks.some((task) => task.workgroups.archived_at)) {
    throw new ConflictError("Restore archived workgroups before creating payouts");
  }

  if (!canBuildAnywhere) {
    const wgIds = tasks.map((t) => t.workgroup_id);
    if (!(await leadsAllWorkgroups(wallet, wgIds))) {
      throw new ForbiddenError(
        "Only signers of this treasury, or leads of all selected workgroups, can build payouts",
      );
    }
  }

  // pay_state alone is not trusted: a task a live transaction already pays
  // is refused even if its state was reset to payable.
  const alreadyPaid = await tasksWithLivePayouts(tasks.map((t) => t.id));

  // Every task resolves to the budget period its workgroup's setup defines
  // for its month (a quarter in a quarterly workgroup); tasks nobody assigned
  // to a budget month take the period they are paid in. The aligned month is
  // written back to the task when persisting so the database and the on-chain
  // metadata agree, and the workgroup's wallet routing is read for that same period.
  const defaultMonth = currentBudgetMonth();
  const workgroupIds = [...new Set(tasks.map((t) => t.workgroup_id))];
  const [setupsByWorkgroup, assignmentsByWorkgroup] = await Promise.all([
    loadBudgetSetupsForWorkgroups(workgroupIds),
    loadTreasuryAssignmentsForWorkgroups(workgroupIds),
  ]);
  const periods = new Map(
    tasks.map((t) => [
      t.id,
      taskBudgetPeriod(t.budget_month, setupsByWorkgroup.get(t.workgroup_id) ?? [], defaultMonth),
    ]),
  );

  // Auto-match remaining bounty fields against tokens the wallet holds;
  // manual connections from the request fill (or override) the rest.
  const fieldNames = [
    ...new Set(tasks.flatMap((t) => Object.keys(t.amounts ?? {}))),
  ];
  const walletAssets = await fetchWalletAssets(network, treasury.address);
  const { auto } = matchTokensToFields(fieldNames, persisted, walletAssets.tokens);
  const registry: AssetDef[] = [...persisted, ...auto];
  const manual: AssetDef[] = [];
  for (const [field, unit] of Object.entries(connections ?? {})) {
    const lower = field.toLowerCase();
    if (lower === ADA_FIELD) {
      problems.push(`${field}: ADA is built in and cannot be reconnected`);
      continue;
    }
    // The batch's own spelling: the registry key is case-sensitive, so a
    // connection typed in another case would land beside the auto row.
    const canonical = fieldNames.find((f) => f.toLowerCase() === lower);
    if (!canonical) {
      continue; // connection for a field not in this batch: ignore
    }
    const token = walletAssets.tokens.find((t) => t.unit === unit);
    if (!token) {
      problems.push(`${canonical}: connected token is not held by this wallet`);
      continue;
    }
    const def: AssetDef = { fieldName: canonical, unit, decimals: token.decimals };
    manual.push(def);
    // Manual picks override persisted/auto mappings for the same field.
    const idx = registry.findIndex((a) => a.fieldName.toLowerCase() === lower);
    if (idx >= 0) registry.splice(idx, 1);
    registry.push(def);
  }
  const unitDisplay = unitDisplayFromRegistry(registry);

  const amountsByTask = new Map<string, Map<string, bigint>>();
  const validTasks = tasks.filter((t) => {
    const wg = t.workgroups;
    // The wallet routed for the task's own budget period: a task from before
    // a scheduled wallet change is still paid from the wallet of its period.
    const period = periods.get(t.id)!;
    if (isFutureBudgetMonth(period.month)) {
      problems.push(`${t.title}: budget period ${period.code} is in the future`);
      return false;
    }
    const routed = routedTreasuryAt(assignmentsByWorkgroup.get(t.workgroup_id) ?? [], period.month);
    if (routed && routed !== treasuryId) {
      problems.push(
        `${t.title}: workgroup "${wg.name}" is assigned to a different wallet for ${period.code}`,
      );
      return false;
    }
    if (t.pay_state !== PayState.Payable) {
      problems.push(`${t.title}: not payable (state: ${t.pay_state})`);
      return false;
    }
    if (alreadyPaid.has(t.id)) {
      problems.push(`${t.title}: already in a payout transaction`);
      return false;
    }
    // Every assignee is paid in full, so every assignee needs a wallet.
    const unpayable = assigneeProblems(t.title, t.task_assignees);
    if (unpayable.length > 0) {
      problems.push(...unpayable);
      return false;
    }
    try {
      const resolved = resolveTaskAmounts(t, registry);
      if (resolved.size === 0) {
        problems.push(`${t.title}: no bounty set`);
        return false;
      }
      amountsByTask.set(t.id, resolved);
    } catch (err) {
      problems.push(
        err instanceof AssetResolutionError
          ? `${t.title}: ${err.message}`
          : `${t.title}: invalid amounts`,
      );
      return false;
    }
    return true;
  });
  if (validTasks.length === 0 || problems.length > 0) {
    throw new BadRequestError("Some tasks are not payable", { problems });
  }

  // What each task's payout counts against and cites: the budget in force
  // for its workgroup and period (and the proposal that set it), plus the
  // proposal that created the task. Every assignee is paid in full, so a
  // task's spend is its amounts times its assignees.
  const budgetSources = await loadBudgetSources(workgroupIds.map((id) => budgetOwnerKey({ workgroupId: id, treasuryId: null })));
  const lines: SpendGuardLine[] = validTasks.flatMap((t) => {
    const wallets = assigneeWallets(t.task_assignees).length;
    const ownerKey = budgetOwnerKey({ workgroupId: t.workgroup_id, treasuryId: null });
    return [...amountsByTask.get(t.id)!.entries()].map(([unit, quantity]) => ({
      ownerKey, ownerType: "workgroup" as const, ownerId: t.workgroup_id, ownerName: t.workgroups.name,
      periodMonth: periods.get(t.id)!.month, unit, amount: quantity * BigInt(wallets),
      ticker: unitTicker(unit, unitDisplay), decimals: unitDisplay.get(unit)?.decimals ?? 0,
    }));
  });
  const budgets = budgetsForLines(lines, budgetSources);
  const citedIdsOf = (t: TaskForBuild) => [
    t.proposal_id,
    budgets.get(spendKey(budgetOwnerKey({ workgroupId: t.workgroup_id, treasuryId: null }), periods.get(t.id)!.month))?.proposalId,
  ];
  const cited = await loadProposalCitations(validTasks.flatMap(citedIdsOf).filter((id): id is string => !!id));
  const citations = new Map(validTasks.map((t) => [t.id, citationsOf(citedIdsOf(t), cited)]));
  const spendProblems = await guardSpend(treasury.community_id, lines, budgetSources);

  // One recipient per distinct wallet; a task with several assignees is paid
  // in full to each of them.
  const recipients = groupByRecipient(validTasks, amountsByTask, periods, citations);
  const offNetwork = recipientsOffNetwork(recipients, network);
  if (offNetwork.length > 0) {
    throw new BadRequestError("Some assignee wallets are on a different network", {
      problems: offNetwork.map(
        (r) => `Tasks #${r.taskNumbers.join(", #")}: ${r.wallet} is not a ${networkName(network)} address`,
      ),
    });
  }
  const payments = countPayments(recipients);

  // The community's due proposal anchors ride along (label 190002) in the
  // room the payout record leaves; a failure to load them never blocks the payout.
  const anchors = await loadDueAnchorsBestEffort(treasury.community_id);

  const { scriptCbor } = resolveTreasuryScript(treasury, signers);
  const validToSlot = validToSlotFor(network);
  let built: Built;
  try {
    built = await buildPayoutTx({
      treasuryAddress: treasury.address,
      scriptCbor,
      communitySlug: ctx.communitySlug,
      network,
      provider: getProvider(network),
      recipients,
      unitDisplay,
      anchors,
      validFromSlot: validFromSlotFor(treasury, path),
      validToSlot,
    });
  } catch (err) {
    // The builder's refusals of the request itself are a 400 with their text,
    // not an anonymous 500.
    if (err instanceof Error && err.constructor === Error && BUILD_REFUSALS.some((re) => re.test(err.message))) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }

  // The mappings this payout relied on (auto-matched + manual), remembered on
  // persist so post-payout displays and GitHub write-back keep stable
  // ticker/decimals even after the token leaves the wallet. Manual picks
  // overwrite: one row per field (an upsert cannot touch the same row twice).
  const overridden = new Set(manual.map((m) => m.fieldName));
  return {
    treasuryId,
    ctx,
    path,
    tasks: validTasks,
    periods,
    recipients,
    payments,
    unitDisplay,
    spendProblems,
    built,
    carried: built.anchorsCarried as typeof anchors,
    mappings: [...auto.filter((a) => !overridden.has(a.fieldName)), ...manual],
    validToSlot,
  };
}

/**
 * Store a planned payout: the remembered token mappings, then the pending
 * transaction with its payouts rows, stamped budget months, queued tasks and
 * carried anchors (all undone with the row if any step fails). With
 * `agentDraftId` the row is keyed by that agent API draft.
 */
export async function persistPayout(
  plan: PayoutPlan,
  wallet: string,
  opts: { agentDraftId?: string } = {},
): Promise<TransactionRow> {
  const { ctx, path, built, recipients, tasks: validTasks, periods } = plan;
  await upsertAssetMappings(ctx.treasury.community_id, plan.mappings);

  const tickers = builtTickers(built, plan.unitDisplay);
  return withTransactionRow(
    {
      treasury_id: plan.treasuryId,
      kind: TxKind.Payout,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: payoutDescription({
        tasks: validTasks.length,
        payments: plan.payments,
        contributors: recipients.length,
        tickers,
      }),
      created_by: wallet,
      spend_problems: plan.spendProblems,
      valid_to_slot: plan.validToSlot,
      ...(opts.agentDraftId ? { agent_draft_id: opts.agentDraftId } : {}),
    },
    async (tx) => {
      // Claim before payouts: two treasuries racing on the same task cannot
      // both queue; the loser rolls back via withTransactionRow.
      await claimTasksForPayout(tx.id, validTasks.map((t) => t.id));
      // One payout row per (task, wallet, unit)
      const payoutRows = recipients.flatMap((r) =>
        r.tasks.flatMap((t) =>
          t.amounts.map((a) => ({
            transaction_id: tx.id,
            task_id: t.taskId,
            contributor_wallet: r.contributorWallet,
            unit: a.unit,
            amount: a.quantity.toString(),
          })),
        ),
      );
      await insertPayouts(payoutRows);
      // Unset tasks are stamped with their resolved month: the quarter's
      // first month in a quarterly workgroup, as the task dialog would write.
      const unsetByMonth = new Map<string, string[]>();
      for (const t of validTasks) {
        if (t.budget_month) continue;
        const month = periods.get(t.id)!.month;
        unsetByMonth.set(month, [...(unsetByMonth.get(month) ?? []), t.id]);
      }
      for (const [month, ids] of unsetByMonth) {
        await setBudgetMonthIfNull(ids, month);
      }
      await recordProposalAnchors(tx.id, plan.carried);
      return tx;
    },
  );
}

// The co-signer check (docs/onchain-anchoring-estimate.md, phase 7): the
// one home of the deterministic decision whether a co-signed transaction
// may get the co-signer's signature. A person co-signing reads its result
// on the transaction page; the app-held key signs only when it passes.
//
//   1. the transaction's own CBOR moves exactly what the stored rows say
//      (compare.ts);
//   2. the spend fits the voted budgets (spendCheck, every problem refuses;
//      only while the community's budget kind is on, like the build routes);
//   3. every cited proposal is passed, applied and unchanged.
//
// Per kind: payouts and payments take all three steps; a transfer to a
// sibling treasury only step 1 (it is no spend); an anchor has no outputs
// but change; a mint forges exactly the stored assets.
import "server-only";

import { resolveTxHash } from "@meshsdk/core-cst";
import { unitDisplayFromRegistry, unitTicker } from "@/lib/assetRegistry";
import { budgetOwnerLabel, taskBudgetPeriod } from "@/lib/budgetSetups";
import { currentBudgetMonth, isFutureBudgetMonth } from "@/lib/budgets";
import { decodeTxMint, decodeTxOutputs, extractPayoutMetadata } from "@/lib/cardano/cborMetadata";
import { ExecutionState, ProposalKind, ProposalState, TxKind } from "@/lib/constants";
import { loadAssetRegistry } from "@/lib/db/assets";
import { loadBudgetSetupsForTreasury, loadBudgetSetupsForWorkgroups, loadBudgetSources } from "@/lib/db/budgetSetups";
import {
  loadMintsForTx,
  loadPaymentsForTx,
  loadPayoutsForCheck,
  loadProposalsByNumbers,
} from "@/lib/db/cosigner";
import { loadGovernanceSettings } from "@/lib/db/governance";
import { loadSiblingTreasuries } from "@/lib/db/payments";
import { loadSpentForTargets, type SpentTarget } from "@/lib/db/spendCheck";
import type { TransactionRow, TreasuryRow } from "@/lib/db/types";
import { budgetOwnerKey } from "@/lib/governance/payload";
import { spendCheck, spendKey, spendProblemText } from "@/lib/governance/spendCheck";
import { budgetsForLines, type SpendGuardLine } from "@/lib/governance/spendGuard";
import { isRecord } from "@/lib/guards";
import { compareTxToRows } from "./compare";

export interface CosignerCheck {
  passed: boolean;
  /** Every reason the check refuses, in words; empty when it passed. */
  problems: string[];
}

/** The `g` citations of a record: [number, contentHash, ...]. */
function citationsOf(meta: unknown): { number: number; contentHash: string }[] {
  if (!isRecord(meta) || !Array.isArray(meta.g)) return [];
  const out: { number: number; contentHash: string }[] = [];
  for (const g of meta.g) {
    if (Array.isArray(g) && typeof g[0] === "number" && typeof g[1] === "string") out.push({ number: g[0], contentHash: g[1] });
  }
  return out;
}

/** Step 2: the spend's lines against the budgets in force and what is already spent, this transaction excluded. */
async function budgetProblems(
  tx: TransactionRow,
  treasury: TreasuryRow,
  payouts: Awaited<ReturnType<typeof loadPayoutsForCheck>>,
  payments: Awaited<ReturnType<typeof loadPaymentsForTx>>,
): Promise<string[]> {
  const budgetKind = await loadGovernanceSettings(treasury.community_id, ProposalKind.Budget);
  if (!budgetKind.enabled) return [];

  const registry = await loadAssetRegistry(treasury.community_id);
  const display = unitDisplayFromRegistry(registry);
  const defaultMonth = currentBudgetMonth();
  const lines: SpendGuardLine[] = [];

  if (tx.kind === TxKind.Payout) {
    const workgroupIds = [...new Set(payouts.map((p) => p.tasks.workgroup_id))];
    const setups = await loadBudgetSetupsForWorkgroups(workgroupIds);
    // Rows are per (task, wallet, unit): summing them per task and unit is
    // the task's amount times its assignees, as the build charged it.
    const byTaskUnit = new Map<string, { row: (typeof payouts)[number]; amount: bigint }>();
    for (const p of payouts) {
      const key = `${p.task_id}|${p.unit}`;
      const entry = byTaskUnit.get(key);
      if (entry) entry.amount += BigInt(p.amount);
      else byTaskUnit.set(key, { row: p, amount: BigInt(p.amount) });
    }
    for (const { row, amount } of byTaskUnit.values()) {
      const period = taskBudgetPeriod(row.tasks.budget_month, setups.get(row.tasks.workgroup_id) ?? [], defaultMonth);
      lines.push({
        ownerKey: budgetOwnerKey({ workgroupId: row.tasks.workgroup_id, treasuryId: null }),
        ownerType: "workgroup", ownerId: row.tasks.workgroup_id, ownerName: row.tasks.workgroups.name,
        periodMonth: period.month, unit: row.unit, amount,
        ticker: unitTicker(row.unit, display), decimals: display.get(row.unit)?.decimals ?? 0,
      });
    }
  } else if (tx.kind === TxKind.Payment) {
    const setups = await loadBudgetSetupsForTreasury(treasury.id);
    const ownerKey = budgetOwnerKey({ workgroupId: null, treasuryId: treasury.id });
    for (const p of payments) {
      if (p.recipient_treasury_id !== null || !p.budget_month) continue;
      const period = taskBudgetPeriod(p.budget_month, setups, defaultMonth);
      lines.push({
        ownerKey, ownerType: "treasury", ownerId: treasury.id, ownerName: budgetOwnerLabel("treasury", treasury.name),
        periodMonth: period.month, unit: p.unit, amount: BigInt(p.amount),
        ticker: unitTicker(p.unit, display), decimals: display.get(p.unit)?.decimals ?? 0,
      });
    }
  }
  if (lines.length === 0) return [];

  // Stored budget_month can be set ahead of the build; refuse a future period
  // here too so a co-signer never signs what the build should have rejected.
  const future = lines.find((l) => isFutureBudgetMonth(l.periodMonth));
  if (future) return [`Budget period ${future.periodMonth} is in the future`];

  const sources = await loadBudgetSources([...new Set(lines.map((l) => l.ownerKey))]);
  const budgets = budgetsForLines(lines, sources);
  const targets = new Map<string, SpentTarget>();
  for (const line of lines) {
    const key = spendKey(line.ownerKey, line.periodMonth);
    const budget = budgets.get(key);
    if (!budget || targets.has(key)) continue;
    targets.set(key, {
      ownerKey: line.ownerKey, ownerType: line.ownerType, ownerId: line.ownerId,
      periodMonth: line.periodMonth, cadence: budget.cadence,
    });
  }
  const spent = await loadSpentForTargets(treasury.community_id, [...targets.values()], { excludeTransactionId: tx.id });
  return spendCheck({ lines, budgets, spent }).map(spendProblemText);
}

/** Step 3: every cited proposal exists here, passed, was applied and still has that content hash. */
async function citationProblems(communityId: string, meta: unknown): Promise<string[]> {
  const cited = citationsOf(meta);
  if (cited.length === 0) return [];
  const proposals = new Map(
    (await loadProposalsByNumbers(communityId, cited.map((c) => c.number))).map((p) => [p.number, p]),
  );
  const problems: string[] = [];
  for (const c of cited) {
    const p = proposals.get(c.number);
    if (!p) problems.push(`Cited proposal #${c.number} does not exist in this community`);
    else if (p.state !== ProposalState.Passed) problems.push(`Cited proposal #${c.number} did not pass`);
    else if (p.execution_state !== ExecutionState.Applied) problems.push(`Cited proposal #${c.number} was not applied`);
    else if (p.content_hash !== c.contentHash) problems.push(`Cited proposal #${c.number} has another content hash than the record`);
  }
  return problems;
}

/** Run the whole check on a transaction of the treasury. Never throws for a refusal; a load failure does. */
export async function runCosignerCheck(tx: TransactionRow, treasury: TreasuryRow): Promise<CosignerCheck> {
  const problems: string[] = [];
  let hashOk = true;
  try {
    if (resolveTxHash(tx.tx_cbor) !== tx.tx_hash) {
      hashOk = false;
      problems.push("The stored transaction hash does not match the transaction bytes");
    }
  } catch {
    hashOk = false;
    problems.push("The transaction bytes cannot be read");
  }
  if (!hashOk) return { passed: false, problems };

  const [payouts, payments, mints, siblings] = await Promise.all([
    tx.kind === TxKind.Payout ? loadPayoutsForCheck(tx.id) : [],
    tx.kind === TxKind.Payment ? loadPaymentsForTx(tx.id) : [],
    tx.kind === TxKind.Mint ? loadMintsForTx(tx.id) : [],
    loadSiblingTreasuries(treasury.community_id, treasury.id),
  ]);
  const payoutMeta = extractPayoutMetadata(tx.tx_cbor);

  problems.push(...compareTxToRows({
    kind: tx.kind,
    treasuryAddress: treasury.address,
    siblingAddresses: new Set(siblings.map((s) => s.address)),
    outputs: decodeTxOutputs(tx.tx_cbor),
    mint: decodeTxMint(tx.tx_cbor),
    payoutMeta,
    payouts: payouts.map((p) => ({ taskNumber: p.tasks.number, contributorWallet: p.contributor_wallet, unit: p.unit, amount: p.amount })),
    payments: payments.map((p) => ({ recipientWallet: p.recipient_wallet, recipientTreasuryId: p.recipient_treasury_id, unit: p.unit, amount: p.amount })),
    mints: mints.map((m) => ({ policyId: m.policy_id, assetNameHex: m.asset_name_hex, quantity: m.quantity, recipient: m.recipient })),
  }));

  if (tx.kind === TxKind.Payout || tx.kind === TxKind.Payment) {
    problems.push(...await budgetProblems(tx, treasury, payouts, payments));
    problems.push(...await citationProblems(treasury.community_id, payoutMeta));
  }

  return { passed: problems.length === 0, problems };
}

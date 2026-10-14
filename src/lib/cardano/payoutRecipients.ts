// Pure fan-out from validated tasks to payout recipients: every assignee of a
// task is paid the task's full amounts, and a wallet assigned to several tasks
// gets one aggregated output. Recipients are emitted in first-seen order —
// that order is the tx output index the label-190001 metadata records, so a
// task paid to N wallets appears under N output entries with identical
// amounts. No I/O and no server-only imports so it is unit-testable.

import { assigneeWallets } from "@/lib/assignees";
import type { Network } from "@/lib/config";
import { InvariantError } from "@/lib/errors";
import type { Citation } from "./metadata";
import { addressToNetwork } from "./multisigSDK";
import type { PayoutRecipient } from "./payoutOutputs";

export interface RecipientTaskInput {
  id: string;
  /** Community task number — the task's on-chain identifier. */
  number: number;
  workgroups: { name: string };
  task_assignees: { wallet_address: string | null; position: number }[];
}

/**
 * One recipient per distinct wallet, carrying what the metadata records.
 * `periods` holds each task's resolved budget period code (see
 * `taskBudgetPeriod`), keyed by task id; `citations` the proposals each
 * task's payout cites (absent = none).
 */
export function groupByRecipient(
  tasks: RecipientTaskInput[],
  amountsByTask: Map<string, Map<string, bigint>>,
  periods: ReadonlyMap<string, { code: string }>,
  citations: ReadonlyMap<string, readonly Citation[]> = new Map(),
): PayoutRecipient[] {
  const byWallet = new Map<string, PayoutRecipient>();
  for (const t of tasks) {
    const wallets = assigneeWallets(t.task_assignees);
    if (wallets.length === 0) {
      throw new InvariantError(`Task ${t.id} has no assignee wallets`);
    }
    const amounts = amountsByTask.get(t.id);
    if (!amounts) throw new InvariantError(`Task ${t.id} has no resolved amounts`);
    const period = periods.get(t.id);
    if (!period) throw new InvariantError(`Task ${t.id} has no budget period`);
    for (const addr of wallets) {
      let recipient = byWallet.get(addr);
      if (!recipient) {
        recipient = { contributorWallet: addr, tasks: [] };
        byWallet.set(addr, recipient);
      }
      recipient.tasks.push({
        taskId: t.id,
        taskNumber: t.number,
        workgroupName: t.workgroups.name,
        budgetPeriod: period.code,
        amounts: [...amounts.entries()].map(([unit, quantity]) => ({ unit, quantity })),
        citations: [...(citations.get(t.id) ?? [])],
      });
    }
  }
  return [...byWallet.values()];
}

/**
 * Recipients whose wallet is not on the treasury's network, with the task
 * numbers that would pay them. A preprod address in a mainnet payout (or the
 * reverse) fails at submit time at best and strands funds at worst, so the
 * build refuses instead.
 */
export function recipientsOffNetwork(
  recipients: readonly PayoutRecipient[],
  network: Network,
): { wallet: string; taskNumbers: number[] }[] {
  return recipients
    .filter((r) => addressToNetwork(r.contributorWallet) !== network)
    .map((r) => ({
      wallet: r.contributorWallet,
      taskNumbers: r.tasks.map((t) => t.taskNumber),
    }));
}

/** Number of (task, wallet) payments across the recipients. */
export function countPayments(recipients: readonly PayoutRecipient[]): number {
  return recipients.reduce((n, r) => n + r.tasks.length, 0);
}

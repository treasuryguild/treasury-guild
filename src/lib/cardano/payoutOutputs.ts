// Pure output planning: one output per recipient, amounts aggregated per
// unit, lovelace bumped to the ledger min-UTxO for that token bundle. No I/O
// and no server-only imports so it is unit-testable; the tx builders
// (payoutBuilder.ts for task payouts, paymentBuilder.ts for manual payments)
// consume the plan.

import { addQuantity, LOVELACE } from "@/lib/assets";
import type { Citation } from "./metadata";
import { minLovelaceForOutput } from "./utxoSelect";
import { assetNameByteLength, splitUnit } from "./units";

export interface TaskPayment {
  taskId: string;
  /** Community task number, the task's on-chain identifier. */
  taskNumber: number;
  workgroupName: string;
  /** Budget period the task counts against: "YYYY-MM" or "YYYY-Qn". */
  budgetPeriod: string;
  /** On-chain quantities per unit ("lovelace" or policyId+assetNameHex). */
  amounts: { unit: string; quantity: bigint }[];
  /** The proposals the task's payout cites (metadata `g`); empty when none. */
  citations: Citation[];
}

export interface PayoutRecipient {
  contributorWallet: string;
  /** One entry per task being paid to this contributor */
  tasks: TaskPayment[];
}

export interface PlannedOutput {
  address: string;
  /** Lovelace first (incl. any min-UTxO bump), then native tokens. */
  assets: { unit: string; quantity: bigint }[];
}

export interface PayoutPlan {
  outputs: PlannedOutput[];
  totalByUnit: Map<string, bigint>;
}

/** Any recipient of a treasury tx: an address and what it is paid per unit. */
export interface OutputRecipient {
  address: string;
  amounts: { unit: string; quantity: bigint }[];
}

/** A task payout: every task's amounts to one contributor become one output. */
export function planPayoutOutputs(recipients: PayoutRecipient[]): PayoutPlan {
  return planOutputs(recipients.map((r) => ({
    address: r.contributorWallet,
    amounts: r.tasks.flatMap((task) => task.amounts),
  })));
}

/** One output per recipient, in order, each bumped to the min-UTxO its tokens need. */
export function planOutputs(recipients: OutputRecipient[]): PayoutPlan {
  const outputs = recipients.map((r) => {
    const byUnit = new Map<string, bigint>();
    for (const a of r.amounts) {
      if (a.quantity <= 0n) continue;
      addQuantity(byUnit, a.unit, a.quantity);
    }
    const tokens = [...byUnit.entries()].filter(([u]) => u !== LOVELACE);
    const policies = new Set(tokens.map(([u]) => splitUnit(u).policyId));
    const nameBytes = tokens.reduce(
      (sum, [u]) => sum + assetNameByteLength(u),
      0,
    );
    const minLovelace = minLovelaceForOutput({
      policies: policies.size,
      assets: tokens.length,
      totalNameBytes: nameBytes,
    });
    const explicit = byUnit.get(LOVELACE) ?? 0n;
    const lovelace = explicit > minLovelace ? explicit : minLovelace;
    const assets: { unit: string; quantity: bigint }[] = [
      { unit: LOVELACE, quantity: lovelace },
      ...tokens.map(([unit, quantity]) => ({ unit, quantity })),
    ];
    if (tokens.length === 0 && lovelace <= 0n) {
      throw new Error(`Nothing to pay ${r.address}`);
    }
    return { address: r.address, assets };
  });

  const totalByUnit = new Map<string, bigint>();
  for (const o of outputs) {
    for (const a of o.assets) {
      addQuantity(totalByUnit, a.unit, a.quantity);
    }
  }

  return { outputs, totalByUnit };
}

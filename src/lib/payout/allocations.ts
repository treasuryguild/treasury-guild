// Pure Payday allocation math: N% of paid tokens on top of bounties, merged
// by destination. Client-safe — no I/O. The build route maps spend legs to
// treasury budget lines and persists transfer/spend as payments rows.

import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import type { Network } from "@/lib/config";
import { networkName } from "@/lib/config";
import type { PaydayAllocationUnitScope } from "@/lib/db/types";

/** A configured rule as the build sees it (enabled ones only). */
export interface AllocationRuleInput {
  id: string;
  label: string;
  basis_points: number;
  unit_scope: PaydayAllocationUnitScope;
  /** Empty when unit_scope is all. */
  units: readonly string[];
  recipient_wallet: string | null;
  recipient_treasury_id: string | null;
  /** Resolved address of the sibling treasury when recipient_treasury_id is set. */
  recipientTreasuryAddress?: string | null;
  recipientTreasuryName?: string | null;
}

export interface AllocationAmount {
  unit: string;
  quantity: bigint;
  ticker: string;
  decimals: number;
}

/** One destination after merging rules that share an address. */
export interface AllocationRecipient {
  address: string;
  /** Transfer to a sibling treasury ⇔ recipientTreasuryId set. */
  recipientTreasuryId: string | null;
  label: string;
  amounts: AllocationAmount[];
  /** Rule ids that contributed to this merged output. */
  ruleIds: string[];
}

export interface AllocationSpendLine {
  unit: string;
  amount: bigint;
  ticker: string;
  decimals: number;
}

export interface ApplyAllocationsResult {
  recipients: AllocationRecipient[];
  /** Non-transfer amounts only — charged to the paying treasury's budget. */
  spendLines: AllocationSpendLine[];
  problems: string[];
}

export interface ApplyAllocationsInput {
  rules: readonly AllocationRuleInput[];
  /** Gross bounty totals per unit (after assignee multiplication), base units. */
  payoutTotals: ReadonlyMap<string, bigint>;
  unitDisplay: ReadonlyMap<string, { ticker: string; decimals: number }>;
  network: Network;
  payingTreasuryAddress: string;
}

function unitMeta(
  unit: string,
  display: ReadonlyMap<string, { ticker: string; decimals: number }>,
): { ticker: string; decimals: number } {
  const known = display.get(unit);
  return { ticker: known?.ticker ?? unit, decimals: known?.decimals ?? 0 };
}

/** floor(total * basisPoints / 10000); 0 when total or rate is empty. */
export function allocationAmount(total: bigint, basisPoints: number): bigint {
  if (total <= 0n || basisPoints <= 0) return 0n;
  return (total * BigInt(basisPoints)) / 10000n;
}

/**
 * Apply enabled rules to payout totals: per-rule floor %, skip zeros and
 * selected units absent from the payout, merge by destination address.
 * Misconfigured destinations become problems (caller refuses the build).
 */
export function applyAllocationRules(input: ApplyAllocationsInput): ApplyAllocationsResult {
  const { rules, payoutTotals, unitDisplay, network, payingTreasuryAddress } = input;
  const problems: string[] = [];
  const merged = new Map<string, AllocationRecipient>();

  for (const rule of rules) {
    const transfer = !!rule.recipient_treasury_id;
    const address = transfer
      ? (rule.recipientTreasuryAddress ?? "").trim()
      : (rule.recipient_wallet ?? "").trim();
    if (!address) {
      problems.push(`Allocation "${rule.label}": destination is missing`);
      continue;
    }
    if (transfer && !rule.recipientTreasuryAddress) {
      problems.push(`Allocation "${rule.label}": sibling treasury address is missing`);
      continue;
    }
    if (address === payingTreasuryAddress) {
      problems.push(`Allocation "${rule.label}": cannot pay the paying treasury`);
      continue;
    }
    try {
      if (addressToNetwork(address) !== network) {
        problems.push(
          `Allocation "${rule.label}": destination is not a ${networkName(network)} address`,
        );
        continue;
      }
    } catch {
      problems.push(`Allocation "${rule.label}": destination address is invalid`);
      continue;
    }

    const scopeUnits = rule.unit_scope === "all"
      ? [...payoutTotals.keys()]
      : rule.units.filter((u) => payoutTotals.has(u));

    const amounts: AllocationAmount[] = [];
    for (const unit of scopeUnits) {
      const total = payoutTotals.get(unit) ?? 0n;
      const quantity = allocationAmount(total, rule.basis_points);
      if (quantity <= 0n) continue;
      const { ticker, decimals } = unitMeta(unit, unitDisplay);
      amounts.push({ unit, quantity, ticker, decimals });
    }
    if (amounts.length === 0) continue;

    const key = address;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        address,
        recipientTreasuryId: transfer ? rule.recipient_treasury_id : null,
        label: transfer
          ? (rule.recipientTreasuryName ?? rule.label)
          : rule.label,
        amounts: [...amounts],
        ruleIds: [rule.id],
      });
      continue;
    }
    // Same address from two rules: merge amounts; prefer treasury id if either is a transfer.
    if (transfer && !existing.recipientTreasuryId) {
      existing.recipientTreasuryId = rule.recipient_treasury_id;
      existing.label = rule.recipientTreasuryName ?? rule.label;
    }
    existing.ruleIds.push(rule.id);
    const byUnit = new Map(existing.amounts.map((a) => [a.unit, a]));
    for (const a of amounts) {
      const prev = byUnit.get(a.unit);
      if (prev) prev.quantity += a.quantity;
      else {
        const next = { ...a };
        byUnit.set(a.unit, next);
        existing.amounts.push(next);
      }
    }
  }

  const recipients = [...merged.values()];
  const spendLines: AllocationSpendLine[] = [];
  for (const r of recipients) {
    if (r.recipientTreasuryId) continue;
    for (const a of r.amounts) {
      spendLines.push({
        unit: a.unit,
        amount: a.quantity,
        ticker: a.ticker,
        decimals: a.decimals,
      });
    }
  }

  return { recipients, spendLines, problems };
}

/** Sum contributor payout amounts per unit (base units). */
export function sumPayoutTotals(
  recipients: readonly { tasks: readonly { amounts: readonly { unit: string; quantity: bigint }[] }[] }[],
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const r of recipients) {
    for (const t of r.tasks) {
      for (const a of t.amounts) {
        if (a.quantity <= 0n) continue;
        totals.set(a.unit, (totals.get(a.unit) ?? 0n) + a.quantity);
      }
    }
  }
  return totals;
}

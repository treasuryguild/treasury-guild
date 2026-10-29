// Ranked payout suggestions for an incoming refund tx.
import "server-only";

import { optionalRelation, rows, serviceClient } from "@/lib/db/client";
import { LOVELACE } from "@/lib/assets";
import type { MatchSuggestion } from "./types";

export interface RefundMatchPayout {
  id: string;
  task_id: string;
  contributor_wallet: string;
  unit: string;
  amount: string;
  taskTitle: string;
}

export interface RefundIncoming {
  from_addresses: string[];
  amount_lovelace: string;
  assets?: Record<string, string> | null;
}

/** How much of `unit` the inflow actually received, or null when it has none. */
export function incomingQuantity(incoming: RefundIncoming, unit: string): bigint | null {
  if (unit === LOVELACE) return BigInt(incoming.amount_lovelace);
  const qty = incoming.assets?.[unit];
  return qty === undefined ? null : BigInt(qty);
}

/**
 * Why a refund match amount/unit is refused, or null when it is allowed.
 * Caps the credit at the inflow's received quantity (and the payout, when set)
 * so a signer cannot invent a huge refund that zeros budget spend forever.
 */
export function refundMatchProblem(
  incoming: RefundIncoming,
  amount: string,
  unit: string,
  payout: { amount: string; unit: string } | null,
): string | null {
  const available = incomingQuantity(incoming, unit);
  if (available === null) return "This inflow did not receive that asset";
  let credit: bigint;
  try {
    credit = BigInt(amount);
  } catch {
    return "Amount must be a whole base-unit quantity";
  }
  if (credit <= 0n) return "Amount must be positive";
  if (credit > available) return "Amount exceeds what this inflow received";
  if (payout) {
    if (payout.unit !== unit) return "Unit must match the payout";
    if (credit > BigInt(payout.amount)) return "Amount exceeds the payout";
  }
  return null;
}

/**
 * Score known payouts against an incoming refund. Pure: the loader
 * (`suggestMatches`) supplies the rows.
 */
export function scoreRefundMatches(
  payouts: readonly RefundMatchPayout[],
  incoming: RefundIncoming,
): MatchSuggestion[] {
  const refundByUnit = new Map<string, bigint>([
    [LOVELACE, BigInt(incoming.amount_lovelace)],
  ]);
  for (const [unit, qty] of Object.entries(incoming.assets ?? {})) {
    refundByUnit.set(unit, BigInt(qty));
  }
  const fromSet = new Set(incoming.from_addresses);

  return payouts
    .map((p) => {
      let score = 0;
      // strongest signal: refund came from the wallet we paid
      if (fromSet.has(p.contributor_wallet)) score += 100;
      const refund = refundByUnit.get(p.unit);
      if (refund !== undefined && refund > 0n) {
        const paid = BigInt(p.amount);
        if (paid === refund) score += 50; // same-unit exact amount
        else if (paid > refund) score += 10; // partial refund plausible
      }
      return {
        payoutId: p.id,
        taskId: p.task_id,
        taskTitle: p.taskTitle,
        contributorWallet: p.contributor_wallet,
        unit: p.unit,
        amount: p.amount,
        score,
      };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export async function suggestMatches(incomingTx: {
  treasury_id: string;
  from_addresses: string[];
  amount_lovelace: string;
  assets?: Record<string, string> | null;
}): Promise<MatchSuggestion[]> {
  const db = serviceClient();
  const payouts = rows<{
    id: string;
    task_id: string;
    contributor_wallet: string;
    unit: string;
    amount: string;
    created_at: string;
    status: string;
    tasks: { title: string } | { title: string }[] | null;
  }>(
    await db
      .from("payouts")
      .select(
        "id, task_id, contributor_wallet, unit, amount, created_at, status, tasks(title), transactions!inner(treasury_id)",
      )
      .in("status", ["confirmed", "written_back"])
      .eq("transactions.treasury_id", incomingTx.treasury_id)
      .order("created_at", { ascending: false })
      .limit(200),
    "load payouts to match",
  );

  return scoreRefundMatches(
    payouts.map((p) => ({
      id: p.id,
      task_id: p.task_id,
      contributor_wallet: p.contributor_wallet,
      unit: p.unit,
      amount: p.amount,
      taskTitle: optionalRelation(p.tasks)?.title ?? "",
    })),
    incomingTx,
  );
}

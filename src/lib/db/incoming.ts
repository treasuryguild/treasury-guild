// Incoming (received) transactions of a treasury, service role.
import "server-only";

import { NotFoundError } from "@/lib/errors";
import { PayoutStatus } from "@/lib/constants";
import { check, maybe, relation, serviceClient } from "./client";
import type { IncomingTxRow } from "./types";

export type IncomingWithTreasury = IncomingTxRow & {
  treasuries: { id: string; community_id: string };
};

/** The incoming tx with its receiving treasury; 404 when unknown. */
export async function loadIncomingWithTreasury(txHash: string): Promise<IncomingWithTreasury> {
  const incoming = maybe<IncomingTxRow & { treasuries: IncomingWithTreasury["treasuries"] | IncomingWithTreasury["treasuries"][] }>(
    await serviceClient()
      .from("incoming_txs")
      // Named FK: incoming_txs also references treasuries through from_treasury_id.
      .select("*, treasuries!incoming_txs_treasury_id_fkey!inner(id, community_id)")
      .eq("tx_hash", txHash)
      .maybeSingle(),
    "load incoming transaction",
  );
  if (!incoming) throw new NotFoundError("Incoming transaction not found");
  return { ...incoming, treasuries: relation(incoming.treasuries) };
}

/** Whether the inflow already has a reconciliation (a refund matched to a payout). */
export async function incomingHasReconciliation(txHash: string): Promise<boolean> {
  const reconciliation = maybe<{ id: string }>(
    await serviceClient()
      .from("reconciliations")
      .select("id")
      .eq("incoming_tx_hash", txHash)
      .limit(1)
      .maybeSingle(),
    "check incoming reconciliation",
  );
  return reconciliation !== null;
}

export async function saveIncomingDetails(txHash: string, patch: Record<string, unknown>): Promise<void> {
  check(
    await serviceClient().from("incoming_txs").update(patch).eq("tx_hash", txHash),
    "save incoming details",
  );
}

/** A payout's task and the treasury that paid it, or null when there is no such payout. */
export async function loadPayoutTreasury(payoutId: string): Promise<{ task_id: string; treasury_id: string } | null> {
  const payout = maybe<{ task_id: string; transactions: { treasury_id: string } | { treasury_id: string }[] }>(
    await serviceClient()
      .from("payouts")
      .select("task_id, transactions!inner(treasury_id)")
      .eq("id", payoutId)
      .maybeSingle(),
    "load payout",
  );
  return payout && { task_id: payout.task_id, treasury_id: relation(payout.transactions).treasury_id };
}

/** Record the match and mark the inflow reconciled. */
export async function recordReconciliation(input: {
  txHash: string;
  payoutId: string | null;
  amount: string;
  unit: string;
  note: string | null;
  createdBy: string;
}): Promise<void> {
  const db = serviceClient();
  check(
    await db.from("reconciliations").insert({
      incoming_tx_hash: input.txHash,
      payout_id: input.payoutId,
      amount: input.amount,
      unit: input.unit,
      note: input.note,
      created_by: input.createdBy,
    }),
    "record reconciliation",
  );
  check(
    await db.from("incoming_txs").update({ matched: true }).eq("tx_hash", input.txHash),
    "mark incoming matched",
  );
}

export async function markPayoutAdjusted(payoutId: string): Promise<void> {
  check(
    await serviceClient().from("payouts").update({ status: PayoutStatus.Adjusted }).eq("id", payoutId),
    "adjust payout",
  );
}

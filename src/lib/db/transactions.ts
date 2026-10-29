import "server-only";

import { MSG, PayoutStatus, PgCode, TxState, type SpendingPath, type TxKind } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";
import { check, maybe, must, rows, rpc, serviceClient } from "./client";
import type { SpendProblem } from "@/lib/governance/spendCheck";
import type { GovernanceAction, TransactionRow } from "./types";

/**
 * One pending tx per treasury: a second would spend the same UTxOs.
 * Throws 409 when one exists. The early, cheap check; the unique index
 * transactions_one_pending_uq (0059) is what two racing builds hit, mapped
 * to the same error by insertTransaction.
 */
export async function assertNoPendingTx(treasuryId: string): Promise<void> {
  const pending = rows<{ id: string }>(
    await serviceClient()
      .from("transactions")
      .select("id")
      .eq("treasury_id", treasuryId)
      .eq("state", TxState.Pending)
      .limit(1),
    "check pending transactions",
  );
  if (pending.length > 0) throw new ConflictError(MSG.pendingTxExists);
}

export interface NewTransaction {
  treasury_id: string;
  kind: TxKind;
  tx_cbor: string;
  tx_hash: string;
  description: string;
  created_by: string;
  /** The branch of the script it was built for (whose signatures count). */
  spending_path: SpendingPath;
  /** What the budget check found (warn mode); omitted = []. */
  spend_problems?: SpendProblem[];
  /** The agent API draft that made it (0065); one draft, one transaction. */
  agent_draft_id?: string;
  /** Stake / DRep / vote details (0075). */
  governance_action?: GovernanceAction;
}

export async function insertTransaction(
  row: NewTransaction,
): Promise<TransactionRow> {
  const res = await serviceClient().from("transactions").insert(row).select().single();
  if (res.error?.code === PgCode.UniqueViolation) throw new ConflictError(MSG.pendingTxExists);
  return must<TransactionRow>(res, "insert transaction");
}

/**
 * Insert a transaction row, then run the dependent writes; if they throw the
 * row is deleted again so a failed build never leaves an orphan pending tx
 * blocking the treasury, and tasks it already queued go back to payable in
 * the same step.
 */
export async function withTransactionRow<T>(
  row: NewTransaction,
  fn: (tx: TransactionRow) => Promise<T>,
): Promise<T> {
  const tx = await insertTransaction(row);
  try {
    return await fn(tx);
  } catch (err) {
    await deletePendingTransaction(tx.id).catch((cleanupErr) =>
      console.error(`compensating delete of tx ${tx.id} failed`, cleanupErr),
    );
    throw err;
  }
}

/** The transaction an agent API draft made, if it made one. */
export type DraftTransaction = Pick<TransactionRow, "id" | "tx_hash" | "treasury_id" | "spending_path">;

export async function findTransactionByDraft(draftId: string): Promise<DraftTransaction | null> {
  return maybe<DraftTransaction>(
    await serviceClient().from("transactions").select("id, tx_hash, treasury_id, spending_path").eq("agent_draft_id", draftId).maybeSingle(),
    "find draft transaction",
  );
}

export type PendingTransaction = Pick<
  TransactionRow,
  "id" | "treasury_id" | "kind" | "description" | "signed_addresses" | "rejected_addresses" | "created_at" | "created_by" | "spending_path"
>;

/** The pending (unsubmitted) transaction of each of these treasuries: at most one each. */
export async function loadPendingTransactions(treasuryIds: string[]): Promise<PendingTransaction[]> {
  if (treasuryIds.length === 0) return [];
  return rows<PendingTransaction>(
    await serviceClient()
      .from("transactions")
      .select("id, treasury_id, kind, description, signed_addresses, rejected_addresses, created_at, created_by, spending_path")
      .in("treasury_id", treasuryIds)
      .eq("state", TxState.Pending),
    "load pending transactions",
  );
}

export type TransactionListItem = Pick<
  TransactionRow,
  | "id" | "treasury_id" | "kind" | "description" | "signed_addresses" | "rejected_addresses" | "state" | "tx_hash"
  | "created_at" | "submitted_at" | "block_time" | "spending_path" | "spend_problems"
>;

/** These treasuries' transactions, newest first, at most `limit`, with the count matching the filter. */
export async function listTreasuryTransactions(
  treasuryIds: string[],
  filter: { kind?: TxKind; state?: TxState; limit: number },
): Promise<{ transactions: TransactionListItem[]; total: number }> {
  if (treasuryIds.length === 0) return { transactions: [], total: 0 };
  let query = serviceClient()
    .from("transactions")
    .select(
      "id, treasury_id, kind, description, signed_addresses, rejected_addresses, state, tx_hash, created_at, submitted_at, block_time, spending_path, spend_problems",
      { count: "exact" },
    )
    .in("treasury_id", treasuryIds);
  if (filter.kind) query = query.eq("kind", filter.kind);
  if (filter.state !== undefined) query = query.eq("state", filter.state);
  const res = await query.order("created_at", { ascending: false }).limit(filter.limit);
  return { transactions: rows<TransactionListItem>(res, "list treasury transactions"), total: res.count ?? 0 };
}

/**
 * Append a signature (add_signature): it lands only if no other signature
 * arrived since the signer read the cbor. False means refetch and re-sign.
 */
export async function addSignature(input: {
  txId: string;
  wallet: string;
  txCbor: string;
  expectedCount: number;
}): Promise<boolean> {
  const landed = maybe<boolean>(
    await serviceClient().rpc("add_signature", {
      p_tx: input.txId,
      p_addr: input.wallet,
      p_cbor: input.txCbor,
      p_expected: input.expectedCount,
    }),
    "add signature",
  );
  return landed === true;
}

/**
 * Record a rejection (reject_transaction), killing the transaction when the
 * threshold can no longer be reached: a dead transaction's queued tasks go
 * back to payable in the same step. Guarded on the state and on the lists
 * the caller read: false means a concurrent submit, signature or rejection
 * changed the row.
 */
export async function recordRejection(input: {
  tx: Pick<TransactionRow, "id" | "signed_addresses" | "rejected_addresses">;
  rejected: string[];
  dead: boolean;
}): Promise<boolean> {
  const recorded = rpc<boolean | null>(
    await serviceClient().rpc("reject_transaction", {
      p_transaction_id: input.tx.id,
      p_expected_signed: input.tx.signed_addresses,
      p_expected_rejected: input.tx.rejected_addresses,
      p_rejected: input.rejected,
      p_dead: input.dead,
    }),
  );
  return recorded === true;
}

/**
 * Delete a transaction only while it is still pending
 * (delete_pending_transaction), releasing its queued tasks back to payable in
 * the same step; false when a submit got there first.
 */
export async function deletePendingTransaction(txId: string): Promise<boolean> {
  const deleted = rpc<boolean | null>(
    await serviceClient().rpc("delete_pending_transaction", { p_transaction_id: txId }),
  );
  return deleted === true;
}

/**
 * A submitted transaction is on-chain (confirm_transaction): the row, its
 * payouts and its tasks (paid, with the confirming hash, native ones moved
 * to their board's Paid column) change together. False when it was not
 * submitted any more: another poll confirmed it first.
 */
export async function confirmTransaction(txId: string, blockTime: string): Promise<boolean> {
  const confirmed = rpc<boolean | null>(
    await serviceClient().rpc("confirm_transaction", { p_transaction_id: txId, p_block_time: blockTime }),
  );
  return confirmed === true;
}

/** Bookkeeping after the network accepted the transaction: the row and its pending payouts. */
export async function markTransactionSubmitted(txId: string, txHash: string, txCbor: string): Promise<void> {
  const db = serviceClient();
  check(
    await db
      .from("transactions")
      .update({
        state: TxState.Submitted,
        tx_hash: txHash,
        tx_cbor: txCbor,
        submitted_at: new Date().toISOString(),
      })
      .eq("id", txId),
    "mark transaction submitted",
  );
  check(
    await db
      .from("payouts")
      .update({ status: PayoutStatus.Submitted })
      .eq("transaction_id", txId)
      .eq("status", PayoutStatus.Pending),
    "mark payouts submitted",
  );
}

/** One payout row per (transaction, task, wallet, unit). */
export async function insertPayouts(payouts: {
  transaction_id: string;
  task_id: string;
  contributor_wallet: string;
  unit: string;
  amount: string;
}[]): Promise<void> {
  check(await serviceClient().from("payouts").insert(payouts), "insert payouts");
}

// One transaction with everything it pays, for the agent API's
// transaction_detail: the query plan of the transaction page
// (src/lib/db/txPage.ts, which reads through RLS) as the service role,
// scoped to the community's treasuries by the caller.
import "server-only";

import { TxState } from "@/lib/constants";
import { isUuid } from "@/lib/guards";
import { relation, rows, serviceClient } from "./client";
import {
  COSIGNER_DECISION_COLUMNS, PAYMENT_COLUMNS, type CosignerDecisionRow, type MintRow, type PaymentRow, type TransactionRow,
} from "./types";

const TX_DETAIL_COLUMNS =
  "id, treasury_id, kind, tx_cbor, tx_hash, description, signed_addresses, rejected_addresses, state, created_by, submitted_at, created_at, discord_notified_at, spend_problems, block_time, spending_path";

/**
 * The transaction `ref` names among these treasuries: its id, or its
 * on-chain hash. A hash is not unique (a rebuilt transaction can share it with
 * a rejected one), so a live row wins over a rejected one, then the newest.
 */
export async function findCommunityTransaction(
  treasuryIds: readonly string[],
  ref: string,
): Promise<TransactionRow | null> {
  if (treasuryIds.length === 0) return null;
  const byId = isUuid(ref);
  const found = rows<TransactionRow>(
    await serviceClient()
      .from("transactions")
      .select(TX_DETAIL_COLUMNS)
      .in("treasury_id", [...treasuryIds])
      .eq(byId ? "id" : "tx_hash", byId ? ref : ref.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(10),
    "find transaction",
  );
  return found.find((tx) => tx.state !== TxState.Rejected) ?? found[0] ?? null;
}

export interface TxPayoutLine {
  wallet: string;
  unit: string;
  amount: string;
  taskNumber: number;
  taskTitle: string;
  workgroup: string;
}

export interface TransactionDetailData {
  payouts: TxPayoutLine[];
  payments: PaymentRow[];
  mints: Pick<MintRow, "asset_name" | "ticker" | "quantity" | "decimals" | "recipient" | "asset_kind" | "policy_id">[];
  decisions: CosignerDecisionRow[];
}

/** What the transaction pays or mints, and the app-held co-signer's decisions on it. */
export async function loadTransactionDetail(tx: Pick<TransactionRow, "id">): Promise<TransactionDetailData> {
  const db = serviceClient();
  const [payouts, payments, mints, decisions] = await Promise.all([
    db.from("payouts")
      .select("contributor_wallet, unit, amount, tasks!inner(number, title, workgroups!inner(name))")
      .eq("transaction_id", tx.id)
      .order("id"),
    db.from("payments").select(PAYMENT_COLUMNS).eq("transaction_id", tx.id).order("id"),
    db.from("mints").select("asset_name, ticker, quantity, decimals, recipient, asset_kind, policy_id").eq("transaction_id", tx.id),
    db.from("cosigner_decisions").select(COSIGNER_DECISION_COLUMNS).eq("transaction_id", tx.id)
      .order("decided_at", { ascending: false }),
  ]);
  type PayoutJoin = {
    contributor_wallet: string; unit: string; amount: string;
    tasks: { number: number; title: string; workgroups: { name: string } | { name: string }[] } | { number: number; title: string; workgroups: { name: string } | { name: string }[] }[];
  };
  return {
    payouts: rows<PayoutJoin>(payouts, "load payouts").map((p) => {
      const task = relation(p.tasks);
      return {
        wallet: p.contributor_wallet,
        unit: p.unit,
        amount: String(p.amount),
        taskNumber: task.number,
        taskTitle: task.title,
        workgroup: relation(task.workgroups).name,
      };
    }),
    payments: rows<PaymentRow>(payments, "load payments"),
    mints: rows<TransactionDetailData["mints"][number]>(mints, "load mints"),
    decisions: rows<CosignerDecisionRow>(decisions, "load co-signer decisions"),
  };
}

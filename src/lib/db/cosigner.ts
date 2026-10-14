// Service-role reads and writes of the co-signer template (0061): the
// app-held key, the decision log, and the stored rows the check compares a
// transaction against.
import "server-only";

import { CosignerKind, SpendingPath, TxState, type CosignTrigger } from "@/lib/constants";
import { check, maybe, must, relation, rows, serviceClient } from "./client";
import {
  COSIGNER_DECISION_COLUMNS,
  PAYMENT_COLUMNS,
  type CosignerDecisionRow,
  type PaymentRow,
  type TransactionRow,
} from "./types";

/** The app-held key row: the encrypted seed never leaves the server. */
export interface CosignerKeyRow {
  treasury_id: string;
  key_hash: string;
  public_key_hex: string;
  encrypted_key: string;
}

export async function insertCosignerKey(row: CosignerKeyRow): Promise<void> {
  check(await serviceClient().from("treasury_cosigner_keys").insert(row), "insert co-signer key");
}

export async function loadCosignerKey(treasuryId: string): Promise<CosignerKeyRow | null> {
  return maybe<CosignerKeyRow>(
    await serviceClient()
      .from("treasury_cosigner_keys")
      .select("treasury_id, key_hash, public_key_hex, encrypted_key")
      .eq("treasury_id", treasuryId)
      .maybeSingle(),
    "load co-signer key",
  );
}

export async function insertCosignerDecision(decision: {
  transactionId: string;
  trigger: CosignTrigger;
  passed: boolean;
  problems: string[];
  signed: boolean;
  /** Why the witness could not be added after a pass. */
  error?: string;
}): Promise<CosignerDecisionRow> {
  return must<CosignerDecisionRow>(
    await serviceClient()
      .from("cosigner_decisions")
      .insert({
        transaction_id: decision.transactionId,
        trigger: decision.trigger,
        passed: decision.passed,
        problems: decision.problems,
        signed: decision.signed,
        error: decision.error ?? null,
      })
      .select(COSIGNER_DECISION_COLUMNS)
      .single(),
    "record co-signer decision",
  );
}

/** Newest first. */
export async function loadCosignerDecisions(transactionId: string): Promise<CosignerDecisionRow[]> {
  return rows<CosignerDecisionRow>(
    await serviceClient()
      .from("cosigner_decisions")
      .select(COSIGNER_DECISION_COLUMNS)
      .eq("transaction_id", transactionId)
      .order("decided_at", { ascending: false }),
    "load co-signer decisions",
  );
}

/** One payout row with the task it pays, for the check. */
export interface PayoutForCheck {
  task_id: string;
  contributor_wallet: string;
  unit: string;
  amount: string;
  tasks: {
    number: number;
    workgroup_id: string;
    budget_month: string | null;
    workgroups: { name: string };
  };
}

export async function loadPayoutsForCheck(transactionId: string): Promise<PayoutForCheck[]> {
  const raw = rows<Omit<PayoutForCheck, "tasks"> & { tasks: PayoutForCheck["tasks"] | PayoutForCheck["tasks"][] }>(
    await serviceClient()
      .from("payouts")
      .select("task_id, contributor_wallet, unit, amount, tasks!inner(number, workgroup_id, budget_month, workgroups!inner(name))")
      .eq("transaction_id", transactionId)
      .order("id"),
    "load payouts for the check",
  );
  return raw.map((r) => {
    const task = relation(r.tasks);
    return { ...r, tasks: { ...task, workgroups: relation(task.workgroups) } };
  });
}

export async function loadPaymentsForTx(transactionId: string): Promise<PaymentRow[]> {
  return rows<PaymentRow>(
    await serviceClient().from("payments").select(PAYMENT_COLUMNS).eq("transaction_id", transactionId).order("id"),
    "load payments for the check",
  );
}

export interface MintForCheck {
  policy_id: string;
  asset_name_hex: string;
  quantity: string;
  recipient: string;
}

export async function loadMintsForTx(transactionId: string): Promise<MintForCheck[]> {
  return rows<MintForCheck>(
    await serviceClient()
      .from("mints")
      .select("policy_id, asset_name_hex, quantity, recipient")
      .eq("transaction_id", transactionId)
      .order("id"),
    "load mints for the check",
  );
}

export interface CitedProposalRow {
  number: number;
  content_hash: string;
  state: string;
  execution_state: string | null;
}

/** The community's proposals with these numbers, for checking citations. */
export async function loadProposalsByNumbers(communityId: string, numbers: readonly number[]): Promise<CitedProposalRow[]> {
  if (numbers.length === 0) return [];
  return rows<CitedProposalRow>(
    await serviceClient()
      .from("proposals")
      .select("number, content_hash, state, execution_state")
      .eq("community_id", communityId)
      .in("number", [...numbers]),
    "load cited proposals",
  );
}

/** Pending co-signed transactions of treasuries whose co-signer is the app (the sweep's candidates). */
export async function listPendingAppCosignedTransactions(limit = 20): Promise<TransactionRow[]> {
  return rows<TransactionRow>(
    await serviceClient()
      .from("transactions")
      .select("*, treasuries!inner(cosigner_kind)")
      .eq("state", TxState.Pending)
      .eq("spending_path", SpendingPath.Cosigned)
      .eq("treasuries.cosigner_kind", CosignerKind.App)
      .order("created_at")
      .limit(limit),
    "list pending co-signed transactions",
  );
}

// Pure helpers for the Treasury page's activity list: how an external
// (on-chain, no `transactions` row) outgoing tx is described, and how app
// transactions and external ones merge into one recent-first list.

import { parsePayoutMeta } from "@/lib/cardano/metadata";
import { parsePaymentMeta } from "@/lib/cardano/paymentMetadata";
import type { ExternalTxRow, TransactionSummary } from "@/lib/db/types";
import { plural } from "@/lib/format";

/** Title and detail line for an external tx card. */
export function describeExternalTx(row: ExternalTxRow): { title: string; detail: string } {
  const payment = parsePaymentMeta(row.payout_meta);
  if (payment) {
    const transfers = payment.outputs.filter((o) => o.transfer).length;
    return {
      title: `Payment on-chain: ${plural(payment.outputs.length, "output")}${transfers > 0 ? ` (${plural(transfers, "transfer")})` : ""}`,
      detail: payment.memo ?? (payment.period ? `Treasury Guild payment · ${payment.period}` : "Treasury Guild payment"),
    };
  }
  const meta = parsePayoutMeta(row.payout_meta);
  if (meta) {
    return {
      title: `Payout on-chain: ${plural(meta.taskNumbers.length, "task")}, ${plural(meta.outputs, "output")}`,
      detail: meta.workgroups.length > 0 ? meta.workgroups.join(", ") : "Treasury Guild payout",
    };
  }
  return {
    title: "Outgoing transfer",
    detail: `to ${plural(row.to_addresses.length, "address", "addresses")}`,
  };
}

export type TreasuryActivity =
  | { kind: "app"; at: string; tx: TransactionSummary }
  | { kind: "external"; at: string; tx: ExternalTxRow };

/** App transactions (by creation) and external txs (by block time), newest first. */
export function recentTreasuryActivity(
  app: readonly TransactionSummary[],
  external: readonly ExternalTxRow[],
  limit: number,
): TreasuryActivity[] {
  const items: TreasuryActivity[] = [
    ...app.map((tx) => ({ kind: "app" as const, at: tx.created_at, tx })),
    ...external.map((tx) => ({ kind: "external" as const, at: tx.block_time, tx })),
  ];
  return items
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

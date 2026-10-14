"use client";

// Human rendering of a manual payment: one row per output of the tx body
// with who is paid (member handle, treasury name or short address), whether
// it is a transfer to another of the community's treasuries, and the
// amounts exactly as the label-190001 record states them. The record is
// decoded from the tx CBOR, so signers verify what is actually on chain; the
// database rows only supply the display labels.

import { parsePaymentMeta } from "@/lib/cardano/paymentMetadata";
import type { DecodedTxOutput } from "@/lib/cardano/types";
import type { PaymentRow } from "@/lib/db/types";
import { plural, shortAddress } from "@/lib/format";
import { Badge, Card, InsetRow } from "@/components/ui";
import { CitationLinks } from "./CitationLinks";

export function PaymentPreview({ slug, payoutMeta, outputs, payments, citedProposals }: {
  slug: string;
  payoutMeta: unknown;
  outputs: DecodedTxOutput[];
  payments: PaymentRow[];
  /** Cited proposal number → its id here, for links. */
  citedProposals: Record<number, string>;
}) {
  const parsed = parsePaymentMeta(payoutMeta);
  if (!parsed) return null;
  const labels = new Map(payments.filter((p) => p.label).map((p) => [p.recipient_wallet, p.label!]));
  const spends = parsed.outputs.filter((o) => !o.transfer).length;
  return (
    <Card className="mb-4">
      <h3 className="mb-1 text-sm font-medium text-zinc-400">
        Payment · {plural(parsed.outputs.length, "output")}
      </h3>
      <p className="mb-3 text-xs text-zinc-500">
        {spends > 0
          ? `Counts against this treasury's budget for ${parsed.period || "the current period"}.`
          : "Transfers between your treasuries: not budget spending."}
        {parsed.memo && <span className="ml-1">Memo: {parsed.memo}</span>}
        {parsed.citations.length > 0 && (
          <span className="ml-1">
            Decisions: <CitationLinks slug={slug} citations={parsed.citations} citedProposals={citedProposals} />
          </span>
        )}
      </p>
      <div className="space-y-2">
        {parsed.outputs.map((entry) => {
          const address = outputs[entry.outputIndex]?.address;
          const label = address ? labels.get(address) : undefined;
          return (
            <InsetRow key={entry.outputIndex}>
              <span className="min-w-0">
                <span className="block truncate text-sm">
                  {label ?? (address ? shortAddress(address) : `Output #${entry.outputIndex + 1}`)}
                </span>
                {label && address && <span className="block font-mono text-[11px] text-zinc-500">{shortAddress(address)}</span>}
              </span>
              <span className="flex items-center gap-2 text-right text-sm font-medium">
                {entry.transfer && <Badge tone="blue">Transfer</Badge>}
                <span>
                  {entry.amounts.map((a) => (
                    <span key={a.ticker} className="block">{a.amount} {a.ticker}</span>
                  ))}
                  {entry.amounts.length === 0 && <span className="text-zinc-500">—</span>}
                </span>
              </span>
            </InsetRow>
          );
        })}
      </div>
    </Card>
  );
}

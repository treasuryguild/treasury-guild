"use client";

import type { UnitDisplay } from "@/lib/assetRegistry";
import { payoutOrPaymentLegend } from "@/lib/cardano/metadataLegend";
import { formatTxAsset } from "@/lib/cardano/txDisplay";
import type { DecodedTxMint, DecodedTxOutput } from "@/lib/cardano/types";
import { formatLovelace, shortAddress } from "@/lib/format";
import { Card, InsetRow, JsonDetails } from "@/components/ui";
import { PayoutMetadataTable } from "./PayoutMetadataTable";

export function OutputsCard({
  slug,
  outputs,
  fee,
  message,
  payoutMeta,
  localTaskNumbers,
  citedProposals,
  treasuryAddress,
  isMintTx,
  mintByUnit,
  display,
  cip25Meta,
  transferAddresses,
  metadataLabel = "On-chain payout metadata (label 190001)",
}: {
  slug: string;
  outputs: DecodedTxOutput[];
  fee: string | null;
  message: string | null;
  payoutMeta: unknown;
  localTaskNumbers: Record<number, number>;
  /** Cited proposal number → its id, for links. */
  citedProposals: Record<number, string>;
  treasuryAddress: string;
  isMintTx: boolean;
  mintByUnit: Map<string, DecodedTxMint>;
  display: UnitDisplay;
  cip25Meta: unknown;
  /** Addresses of the community's other treasuries paid by this tx (a payment's transfers). */
  transferAddresses?: ReadonlySet<string>;
  metadataLabel?: string;
}) {
  return (
    <Card className="mb-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-400">Outputs</h3>
      <div className="space-y-2">
        {outputs.map((o, i) => {
          const toTreasury = o.address === treasuryAddress;
          const carriesMint =
            isMintTx && o.assets.some((a) => mintByUnit.has(a.unit));
          const transfer = transferAddresses?.has(o.address) ?? false;
          return (
            <InsetRow key={i}>
              <span className="font-mono text-xs">
                {shortAddress(o.address)}
                {toTreasury && (
                  <span className="ml-2 text-zinc-500">
                    {carriesMint ? "(treasury)" : "(change)"}
                  </span>
                )}
                {transfer && <span className="ml-2 text-zinc-500">(transfer)</span>}
              </span>
              <span className="text-right text-sm font-medium">
                {formatLovelace(o.lovelace)}
                {o.assets.map((a) => (
                  <span key={a.unit} className="block text-xs text-zinc-300">
                    {formatTxAsset(a.unit, a.quantity, display, mintByUnit, cip25Meta)}
                  </span>
                ))}
              </span>
            </InsetRow>
          );
        })}
      </div>
      {fee && (
        <p className="mt-3 text-xs text-zinc-500">Fee: {formatLovelace(fee)}</p>
      )}
      {message && <p className="mt-2 text-sm text-zinc-300">💬 {message}</p>}
      <PayoutMetadataTable meta={payoutMeta} slug={slug} localTaskNumbers={localTaskNumbers} citedProposals={citedProposals} />
      <JsonDetails label={metadataLabel} value={payoutMeta} legend={payoutOrPaymentLegend(payoutMeta)} />
    </Card>
  );
}

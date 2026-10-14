// Builds a manual payment transaction from a multisig treasury: one output
// per recipient (outside addresses, members, sibling treasuries), the
// label-190001 payment record and a CIP-20 message. Funding, script inputs,
// change and hashing are shared with payouts (completeTreasuryTx).
import "server-only";

import type { IFetcher } from "@meshsdk/common";
import type { UnitDisplay } from "@/lib/assetRegistry";
import type { Network } from "@/lib/config";
import { paymentRecipientSummary } from "@/lib/txDescription";
import { buildMessageMetadata, CIP20_LABEL, PAYOUT_METADATA_LABEL, type Citation } from "./metadata";
import { assertPaymentMetadataFits, buildPaymentMetadata } from "./paymentMetadata";
import { attachAnchors, completeTreasuryTx, metadataDisplay, type DueAnchorLike } from "./payoutBuilder";
import { planOutputs, type PlannedOutput } from "./payoutOutputs";

/** A resolved recipient of a manual payment (see lib/payments/recipients.ts). */
export interface PaymentRecipient {
  address: string;
  /** Set when the address is another treasury of the community: a transfer. */
  treasuryId: string | null;
  /** Member handle or treasury name, for display. */
  label: string | null;
  amounts: { unit: string; quantity: bigint }[];
}

export interface BuildPaymentResult {
  unsignedTxHex: string;
  txHash: string;
  /** One output per recipient; lovelace includes any min-UTxO bump. */
  outputs: PlannedOutput[];
  totalByUnit: Map<string, bigint>;
  /** The due anchors the transaction carries under label 190002 (the rest stay due). */
  anchorsCarried: DueAnchorLike[];
}

export async function buildPaymentTx(opts: {
  treasuryAddress: string;
  scriptCbor: string;
  communitySlug: string;
  network: Network;
  provider: IFetcher;
  recipients: PaymentRecipient[];
  /** Budget period the spend outputs count against: "YYYY-MM" or "YYYY-Qn". */
  budgetPeriod: string;
  memo: string | null;
  /** The proposals the payment cites (metadata `g`); none when absent. */
  citations?: readonly Citation[];
  /** unit -> ticker/decimals, for metadata and readable errors. */
  unitDisplay?: UnitDisplay;
  /** The community's due anchors, in order; as many as fit ride along (label 190002). */
  anchors?: readonly DueAnchorLike[];
  /** The lock slot when the path needs the validity interval to start there. */
  validFromSlot?: number | null;
}): Promise<BuildPaymentResult> {
  const { communitySlug, recipients, budgetPeriod, memo, unitDisplay } = opts;
  if (recipients.length === 0) throw new Error("No recipients to pay");

  const { outputs, totalByUnit } = planOutputs(recipients);

  // Recipient order is output order (completeTreasuryTx appends change last).
  const metadata = buildPaymentMetadata(communitySlug, budgetPeriod, memo, recipients.map((r, outputIndex) => ({
    outputIndex,
    transfer: r.treasuryId !== null,
    amounts: r.amounts.map((a) => ({ ...metadataDisplay(a.unit, unitDisplay), quantity: a.quantity })),
  })), opts.citations ?? []);
  assertPaymentMetadataFits(metadata);
  const anchors = attachAnchors(communitySlug, metadata, opts.anchors);

  const dateStr = new Date().toISOString().slice(0, 10);
  const summary = paymentRecipientSummary({
    recipients: recipients.length,
    transfers: recipients.filter((r) => r.treasuryId !== null).length,
  });
  const { unsignedTxHex, txHash } = await completeTreasuryTx({
    ...opts,
    outputs,
    totalByUnit,
    metadata: [
      [PAYOUT_METADATA_LABEL, metadata],
      ...anchors.metadata,
      [CIP20_LABEL, buildMessageMetadata(
        `Treasury Guild payment: ${communitySlug} ${dateStr}, ${summary}${memo ? `: ${memo}` : ""}`,
      )],
    ],
  });

  return { unsignedTxHex, txHash, outputs, totalByUnit, anchorsCarried: anchors.carried };
}

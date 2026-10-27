// Builds a manual payment transaction from a multisig treasury: one output
// per recipient (outside addresses, members, sibling treasuries), the
// label-190001 payment record and a CIP-20 message. Funding, script inputs,
// change and hashing are shared with payouts (completeTreasuryTx). A drain
// empties the paying wallet into one recipient (completeDrainTx).
import "server-only";

import type { IFetcher } from "@meshsdk/common";
import type { UnitDisplay } from "@/lib/assetRegistry";
import { LOVELACE } from "@/lib/assets";
import type { Network } from "@/lib/config";
import { paymentRecipientSummary } from "@/lib/txDescription";
import { buildMessageMetadata, CIP20_LABEL, PAYOUT_METADATA_LABEL, type Citation } from "./metadata";
import { assertPaymentMetadataFits, buildPaymentMetadata } from "./paymentMetadata";
import {
  attachAnchors, completeDrainTx, completeTreasuryTx, metadataDisplay, type DueAnchorLike,
} from "./payoutBuilder";
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
  /** Recipients with the amounts recorded on-chain (ADA after fee when draining). */
  recipients: PaymentRecipient[];
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
  /**
   * Empty the paying treasury into the single recipient: every UTxO is spent,
   * ADA after the fee goes with the tokens, and nothing is left as change.
   */
  drain?: boolean;
}): Promise<BuildPaymentResult> {
  const { communitySlug, budgetPeriod, memo, unitDisplay, drain } = opts;
  if (opts.recipients.length === 0) throw new Error("No recipients to pay");
  if (drain && opts.recipients.length !== 1) {
    throw new Error("Move all assets pays one recipient");
  }

  if (drain) {
    return buildDrainPayment(opts);
  }

  const recipients = opts.recipients;
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

  return {
    unsignedTxHex, txHash, outputs, totalByUnit, recipients, anchorsCarried: anchors.carried,
  };
}

async function buildDrainPayment(opts: {
  treasuryAddress: string;
  scriptCbor: string;
  communitySlug: string;
  network: Network;
  provider: IFetcher;
  recipients: PaymentRecipient[];
  budgetPeriod: string;
  memo: string | null;
  citations?: readonly Citation[];
  unitDisplay?: UnitDisplay;
  anchors?: readonly DueAnchorLike[];
  validFromSlot?: number | null;
}): Promise<BuildPaymentResult> {
  const { communitySlug, budgetPeriod, memo, unitDisplay } = opts;
  const recipient = opts.recipients[0]!;
  const dateStr = new Date().toISOString().slice(0, 10);
  const summary = paymentRecipientSummary({
    recipients: 1,
    transfers: recipient.treasuryId !== null ? 1 : 0,
  });
  const message = buildMessageMetadata(
    `Treasury Guild payment: ${communitySlug} ${dateStr}, ${summary}${memo ? `: ${memo}` : ""}`,
  );

  let anchorsCarried: DueAnchorLike[] = [];
  const drained = await completeDrainTx({
    treasuryAddress: opts.treasuryAddress,
    scriptCbor: opts.scriptCbor,
    network: opts.network,
    provider: opts.provider,
    recipientAddress: recipient.address,
    validFromSlot: opts.validFromSlot,
    unitDisplay,
    // Amounts (ADA after fee + every token) come from the UTxOs being spent,
    // so metadata stays aligned with the body even if the wallet moves.
    metadataFor: (amounts) => {
      const metadata = buildPaymentMetadata(communitySlug, budgetPeriod, memo, [{
        outputIndex: 0,
        transfer: recipient.treasuryId !== null,
        amounts: amounts.map((a) => ({ ...metadataDisplay(a.unit, unitDisplay), quantity: a.quantity })),
      }], opts.citations ?? []);
      assertPaymentMetadataFits(metadata);
      const anchors = attachAnchors(communitySlug, metadata, opts.anchors);
      anchorsCarried = anchors.carried;
      return [
        [PAYOUT_METADATA_LABEL, metadata],
        ...anchors.metadata,
        [CIP20_LABEL, message],
      ];
    },
  });

  const finalAmounts = drained.output.assets
    .filter((a) => a.quantity > 0n)
    .map((a) => ({ unit: a.unit, quantity: a.quantity }));
  // Lovelace first, then the rest in body order.
  finalAmounts.sort((a, b) => (a.unit === LOVELACE ? -1 : b.unit === LOVELACE ? 1 : 0));

  return {
    unsignedTxHex: drained.unsignedTxHex,
    txHash: drained.txHash,
    outputs: [drained.output],
    totalByUnit: drained.totalByUnit,
    recipients: [{ ...recipient, amounts: finalAmounts }],
    anchorsCarried,
  };
}

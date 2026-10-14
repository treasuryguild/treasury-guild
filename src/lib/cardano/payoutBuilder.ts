// Builds the batch payout transaction from a multisig treasury, and the
// treasury-tx completion step it shares with manual payments
// (paymentBuilder.ts). Multi-asset aware: outputs may carry native tokens;
// every output's lovelace is bumped to the ledger min-UTxO, and UTxO
// selection covers all units.
import "server-only";

import { MeshTxBuilder } from "@meshsdk/core";
import type { IFetcher } from "@meshsdk/common";
import { resolveTxHash } from "@meshsdk/core-cst";
import { networkName, type Network } from "@/lib/config";
import { ADA_ASSET, LOVELACE } from "@/lib/assets";
import type { UnitDisplay } from "@/lib/assetRegistry";
import { shortUnit } from "@/lib/format";
import { ANCHOR_METADATA_LABEL, fitAnchorEntries, type AnchorEntry } from "./anchorMetadata";
import {
  assertPayoutMetadataFits,
  buildMessageMetadata,
  buildPayoutMetadata,
  CIP20_LABEL,
  MAX_METADATA_JSON_BYTES,
  metadataJsonBytes,
  PAYOUT_METADATA_LABEL,
  type PayoutForMetadata,
} from "./metadata";
import {
  planPayoutOutputs,
  type PayoutRecipient,
  type PlannedOutput,
  type TaskPayment,
} from "./payoutOutputs";
import { selectUtxos } from "./utxoSelect";

export type { PayoutRecipient, TaskPayment, UnitDisplay };

export interface BuildPayoutResult {
  unsignedTxHex: string;
  txHash: string;
  /** One output per contributor; lovelace includes any min-UTxO bump. */
  outputs: PlannedOutput[];
  totalByUnit: Map<string, bigint>;
  /** The due anchors the transaction carries under label 190002 (the rest stay due). */
  anchorsCarried: DueAnchorLike[];
}

/** What a build needs of a due anchor: its record entry (and whatever the route links it by). */
export type DueAnchorLike = { entry: AnchorEntry };

/** Fee headroom beyond summed outputs, plus change min-ADA per token unit. */
const SELECTION_HEADROOM = 5_000_000n;
const PER_UNIT_CHANGE_HEADROOM = 500_000n;

function displayAmount(
  unit: string,
  qty: bigint,
  display?: UnitDisplay,
): string {
  if (unit === LOVELACE) return `${qty.toString()} lovelace`;
  const label = display?.get(unit)?.ticker ?? shortUnit(unit);
  return `${qty.toString()} ${label} (base units)`;
}

/** Ticker and decimals a unit is written with on-chain (ADA built in, unknown tokens in base units). */
export function metadataDisplay(
  unit: string,
  display?: UnitDisplay,
): { ticker: string; decimals: number } {
  if (unit === LOVELACE) return { ticker: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals };
  const known = display?.get(unit);
  // No ellipsis: this string lands in on-chain metadata. Unknown decimals →
  // 0, i.e. the metadata shows base units.
  return { ticker: known?.ticker ?? shortUnit(unit, false), decimals: known?.decimals ?? 0 };
}

/**
 * Fund and complete a treasury transaction: select UTxOs covering every
 * unit plus fee/min-UTxO headroom, spend them through the multisig script,
 * emit the planned outputs in order (the change output is appended last, so
 * an output's index in `outputs` is its index in the body), attach the
 * metadata and hash the unsigned body with core-cst.
 */
export async function completeTreasuryTx(opts: {
  treasuryAddress: string;
  scriptCbor: string;
  network: Network;
  provider: IFetcher;
  outputs: PlannedOutput[];
  totalByUnit: Map<string, bigint>;
  /** [label, value] pairs, e.g. the 190001 record and the 674 message. */
  metadata: [label: string, value: object][];
  /** unit -> ticker/decimals, for readable shortfall errors. */
  unitDisplay?: UnitDisplay;
  /**
   * The slot the transaction becomes valid at: the treasury's lock slot on
   * a lock-until treasury or a clawback's recovery path, whose `after`
   * script node needs the validity interval to start there.
   */
  validFromSlot?: number | null;
}): Promise<{ unsignedTxHex: string; txHash: string }> {
  const { treasuryAddress, scriptCbor, network, provider, outputs, totalByUnit, unitDisplay, validFromSlot } = opts;

  const tokenUnitCount = totalByUnit.size - (totalByUnit.has(LOVELACE) ? 1 : 0);
  const headroom =
    SELECTION_HEADROOM + PER_UNIT_CHANGE_HEADROOM * BigInt(tokenUnitCount);

  const utxos = await provider.fetchAddressUTxOs(treasuryAddress);
  const { selected, shortfall } = selectUtxos(utxos, totalByUnit, headroom);
  if (shortfall) {
    const parts = [...shortfall.entries()].map(([unit, missing]) =>
      displayAmount(unit, missing, unitDisplay),
    );
    throw new Error(
      `Insufficient treasury funds: short ${parts.join(", ")} (incl. fee/min-UTxO headroom)`,
    );
  }

  const txBuilder = new MeshTxBuilder({ fetcher: provider, verbose: false });
  txBuilder.setNetwork(networkName(network));

  for (const utxo of selected) {
    txBuilder
      .txIn(
        utxo.input.txHash,
        utxo.input.outputIndex,
        utxo.output.amount,
        utxo.output.address,
      )
      .txInScript(scriptCbor);
  }

  for (const output of outputs) {
    txBuilder.txOut(
      output.address,
      output.assets.map((a) => ({
        unit: a.unit,
        quantity: a.quantity.toString(),
      })),
    );
  }

  for (const [label, value] of opts.metadata) {
    txBuilder.metadataValue(label, value);
  }
  txBuilder.changeAddress(treasuryAddress);
  if (validFromSlot !== undefined && validFromSlot !== null) {
    txBuilder.invalidBefore(validFromSlot);
  }

  const unsignedTxHex = await txBuilder.complete();
  const txHash = resolveTxHash(unsignedTxHex);
  return { unsignedTxHex, txHash };
}

export async function buildPayoutTx(opts: {
  treasuryAddress: string;
  scriptCbor: string;
  communitySlug: string;
  network: Network;
  provider: IFetcher;
  recipients: PayoutRecipient[];
  /** unit -> ticker/decimals, for metadata and readable errors. */
  unitDisplay?: UnitDisplay;
  /** The community's due anchors, in order; as many as fit ride along (label 190002). */
  anchors?: readonly DueAnchorLike[];
  /** The lock slot when the path needs the validity interval to start there. */
  validFromSlot?: number | null;
}): Promise<BuildPayoutResult> {
  const { communitySlug, unitDisplay } = opts;

  const recipients = opts.recipients.filter((r) => r.tasks.length > 0);
  if (recipients.length === 0) {
    throw new Error("No recipients to pay");
  }

  const { outputs, totalByUnit } = planPayoutOutputs(recipients);

  // Metadata records bounty amounts only: the min-UTxO bump planPayoutOutputs
  // adds to token outputs is a ledger rule, not a payment, and stays in the
  // body. The recipient's position is its output index: planPayoutOutputs
  // emits one output per recipient in order, and completeTreasuryTx follows
  // that order with the change output last.
  const payoutsForMetadata: PayoutForMetadata[] = recipients.flatMap(
    (r, outputIndex) =>
      r.tasks.map((t) => ({
        outputIndex,
        taskNumber: t.taskNumber,
        workgroupName: t.workgroupName,
        budgetPeriod: t.budgetPeriod,
        amounts: t.amounts.map((a) => ({ ...metadataDisplay(a.unit, unitDisplay), quantity: a.quantity })),
        citations: t.citations,
      })),
  );

  const payoutMetadata = buildPayoutMetadata(communitySlug, payoutsForMetadata);
  assertPayoutMetadataFits(payoutMetadata);
  // The payout record has priority; due anchors ride in whatever room the
  // metadata guard leaves, and the rest stay due.
  const anchors = attachAnchors(communitySlug, payoutMetadata, opts.anchors);

  const dateStr = new Date().toISOString().slice(0, 10);
  const { unsignedTxHex, txHash } = await completeTreasuryTx({
    ...opts,
    outputs,
    totalByUnit,
    metadata: [
      [PAYOUT_METADATA_LABEL, payoutMetadata],
      ...anchors.metadata,
      [
        CIP20_LABEL,
        buildMessageMetadata(
          `Treasury Guild payout: ${communitySlug} ${dateStr}, ${recipients.length} contributors`,
        ),
      ],
    ],
  });

  return { unsignedTxHex, txHash, outputs, totalByUnit, anchorsCarried: anchors.carried };
}

/**
 * The label-190002 pair carrying as many of the due anchors as fit beside
 * `record` under the metadata guard, and which ones; nothing when none is
 * due or none fits.
 */
export function attachAnchors<T extends { entry: AnchorEntry }>(
  communitySlug: string,
  record: object,
  anchors: readonly T[] | undefined,
): { metadata: [label: string, value: object][]; carried: T[] } {
  if (!anchors || anchors.length === 0) return { metadata: [], carried: [] };
  const fitted = fitAnchorEntries(communitySlug, anchors, MAX_METADATA_JSON_BYTES - metadataJsonBytes(record));
  if (!fitted) return { metadata: [], carried: [] };
  return { metadata: [[ANCHOR_METADATA_LABEL, fitted.record]], carried: fitted.carried };
}

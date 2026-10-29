// Builds a CIP-0146 registration transaction: script inputs, no external
// outputs, change back to the treasury, label-1854 record. Spending a UTxO
// exposes the native script on-chain (discovery reconstructs from it) and
// a later self-spend with new 1854 metadata supersedes the old one.
import type { IFetcher } from "@meshsdk/common";

import type { Network } from "@/lib/config";
import {
  buildTreasuryLabel1854Metadata,
  METADATA_LABEL_1854,
  type Label1854Metadata,
} from "./cip146Registration";
import { assertMetadataFits, buildMessageMetadata, CIP20_LABEL } from "./metadata";
import { completeTreasuryTx } from "./payoutBuilder";
import type { TreasuryRow, TreasurySignerRow } from "@/lib/db/types";

export function registrationRecord(
  treasury: Pick<TreasuryRow, "name">,
  signers: readonly Pick<
    TreasurySignerRow,
    "key_hash" | "stake_key_hash" | "drep_key_hash" | "display_name" | "signer_group"
  >[],
): Label1854Metadata {
  return buildTreasuryLabel1854Metadata(treasury, signers);
}

export async function buildRegistrationTx(opts: {
  treasuryAddress: string;
  scriptCbor: string;
  network: Network;
  provider: IFetcher;
  record: Label1854Metadata;
  message: string;
  /** The lock slot when the path needs the validity interval to start there. */
  validFromSlot?: number | null;
}): Promise<{ unsignedTxHex: string; txHash: string }> {
  assertMetadataFits(opts.record, "Registration record too large");
  return completeTreasuryTx({
    treasuryAddress: opts.treasuryAddress,
    scriptCbor: opts.scriptCbor,
    network: opts.network,
    provider: opts.provider,
    validFromSlot: opts.validFromSlot,
    outputs: [],
    totalByUnit: new Map(),
    metadata: [
      [METADATA_LABEL_1854, opts.record],
      [CIP20_LABEL, buildMessageMetadata(opts.message)],
    ],
  });
}

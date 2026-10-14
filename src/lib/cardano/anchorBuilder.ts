// Builds a metadata-only treasury transaction: script inputs, no outputs,
// change back to the treasury, one label-190002 record. It moves nothing
// and costs the fee (about 0.19 ADA). The dedicated anchor route (phase 3)
// and the groundwork test (phase 0) both build through here.
import type { IFetcher } from "@meshsdk/common";

import type { Network } from "@/lib/config";
import { ANCHOR_METADATA_LABEL } from "./anchorMetadata";
import { assertMetadataFits, buildMessageMetadata, CIP20_LABEL } from "./metadata";
import { completeTreasuryTx } from "./payoutBuilder";

export async function buildAnchorTx(opts: {
  treasuryAddress: string;
  scriptCbor: string;
  network: Network;
  provider: IFetcher;
  record: object;
  message: string;
  /** The lock slot when the path needs the validity interval to start there. */
  validFromSlot?: number | null;
}): Promise<{ unsignedTxHex: string; txHash: string }> {
  assertMetadataFits(opts.record, "Anchor record too large");
  return completeTreasuryTx({
    treasuryAddress: opts.treasuryAddress,
    scriptCbor: opts.scriptCbor,
    network: opts.network,
    provider: opts.provider,
    validFromSlot: opts.validFromSlot,
    outputs: [],
    totalByUnit: new Map(),
    metadata: [
      [ANCHOR_METADATA_LABEL, opts.record],
      [CIP20_LABEL, buildMessageMetadata(opts.message)],
    ],
  });
}

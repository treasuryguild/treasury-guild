// Builds on-chain governance votes as the treasury's script DRep.
import "server-only";

import { hashDrepAnchor, type IFetcher } from "@meshsdk/common";

import type { Network } from "@/lib/config";
import { pinataGateway } from "@/lib/env.server";
import { ipfsStore } from "@/lib/storage/ipfs";
import { completeCertTx } from "./certTxBuilder";

export type VoteKind = "Yes" | "No" | "Abstain";

export interface VoteTarget {
  txHash: string;
  certIndex: number;
  voteKind: VoteKind;
}

/** Same content → same pin result within this process (confirm retries). */
const votePinCache = new Map<string, { anchorUrl: string; anchorDataHash: string }>();

export async function pinVoteRationale(
  doc: Record<string, unknown>,
): Promise<{ anchorUrl: string; anchorDataHash: string }> {
  const body = JSON.stringify(doc);
  const cached = votePinCache.get(body);
  if (cached) return cached;
  const cid = await ipfsStore().put(new TextEncoder().encode(body), "vote-rationale.json", {
    kind: "vote-rationale",
  });
  const anchorUrl = `https://${pinataGateway()}/ipfs/${cid}`;
  const anchorDataHash = hashDrepAnchor(JSON.parse(body) as Record<string, unknown>);
  const result = { anchorUrl, anchorDataHash };
  votePinCache.set(body, result);
  return result;
}

export async function buildVoteTx(opts: {
  treasuryAddress: string;
  paymentScriptCbor: string;
  drepScriptCbor: string;
  dRepId: string;
  network: Network;
  provider: IFetcher;
  votes: VoteTarget[];
  rationale?: { anchorUrl: string; anchorDataHash: string } | null;
}): Promise<{ unsignedTxHex: string; txHash: string }> {
  const { dRepId, drepScriptCbor, votes, rationale } = opts;
  if (votes.length === 0) throw new Error("At least one vote is required");

  return completeCertTx({
    treasuryAddress: opts.treasuryAddress,
    paymentScriptCbor: opts.paymentScriptCbor,
    network: opts.network,
    provider: opts.provider,
    apply: (txBuilder) => {
      for (const v of votes) {
        txBuilder.vote(
          { type: "DRep", drepId: dRepId },
          { txHash: v.txHash, txIndex: v.certIndex },
          {
            voteKind: v.voteKind,
            ...(rationale ? { anchor: rationale } : {}),
          },
        );
      }
      txBuilder.voteScript(drepScriptCbor);
    },
  });
}

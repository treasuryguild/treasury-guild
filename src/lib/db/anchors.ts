// Service-role access to proposal anchors (migration 0060): the rows that
// say which transaction carries which step, read with the transaction's
// state for the due rules, written only by the record_proposal_anchors RPC
// from the build routes.
import "server-only";

import type { AnchorStep } from "@/lib/constants";
import { BadRequestError } from "@/lib/errors";
import { PgCode, TxState } from "@/lib/constants";
import { check, rows, rpc, serviceClient } from "./client";
import {
  PROPOSAL_ANCHOR_WITH_TX_COLUMNS, type ProposalAnchorWithTx, type ProposalDocumentCopyRow, type ProposalRow,
  type ProposalTallyDocumentRow,
} from "./types";

/** What the due rules read of an anchored proposal, with its anchor rows embedded. */
export type AnchorCandidateRow = Pick<
  ProposalRow, "id" | "number" | "state" | "content_hash" | "rules_hash" | "electorate_hash" | "voting_opened_at" | "anchored" | "tally"
> & { proposal_anchors: ProposalAnchorWithTx[] };

const CANDIDATE_COLUMNS =
  `id, number, state, content_hash, rules_hash, electorate_hash, voting_opened_at, anchored, tally, proposal_anchors(${PROPOSAL_ANCHOR_WITH_TX_COLUMNS})`;

/** Every anchored proposal of a community with its anchor rows, oldest first. */
export async function loadAnchorCandidates(communityId: string): Promise<AnchorCandidateRow[]> {
  return rows<AnchorCandidateRow>(
    await serviceClient().from("proposals").select(CANDIDATE_COLUMNS)
      .eq("community_id", communityId).eq("anchored", true).order("number"),
    "load anchor candidates",
  );
}

export type FrozenDocumentRow = Pick<ProposalTallyDocumentRow, "proposal_id" | "hash" | "frozen_at"> & {
  proposal_document_copies: Pick<ProposalDocumentCopyRow, "store" | "locator">[];
};

/** The frozen documents of these proposals with their copies, by proposal id. */
export async function loadFrozenDocuments(proposalIds: readonly string[]): Promise<Map<string, FrozenDocumentRow>> {
  if (proposalIds.length === 0) return new Map();
  return new Map(rows<FrozenDocumentRow>(
    await serviceClient().from("proposal_tally_documents")
      .select("proposal_id, hash, frozen_at, proposal_document_copies(store, locator)").in("proposal_id", proposalIds),
    "load frozen documents",
  ).map((d) => [d.proposal_id, d]));
}

/** Link the steps a pending transaction carries (record_proposal_anchors); the count of new links. */
export async function recordProposalAnchors(
  transactionId: string, anchors: readonly { proposalId: string; step: AnchorStep }[],
): Promise<number> {
  if (anchors.length === 0) return 0;
  return rpc<number>(await serviceClient().rpc("record_proposal_anchors", {
    p_transaction_id: transactionId, p_anchors: anchors,
  }), { [PgCode.CheckViolation]: BadRequestError });
}

/** The proposal's anchor rows with their transactions (the transaction page, the sweep). */
export async function loadProposalAnchors(proposalId: string): Promise<ProposalAnchorWithTx[]> {
  return rows<ProposalAnchorWithTx>(
    await serviceClient().from("proposal_anchors").select(PROPOSAL_ANCHOR_WITH_TX_COLUMNS).eq("proposal_id", proposalId),
    "load proposal anchors",
  );
}

/** Confirmed anchor transaction hashes per proposal and step (the agent API). */
export async function loadConfirmedAnchorHashes(
  proposalIds: readonly string[],
): Promise<Map<string, Partial<Record<AnchorStep, string>>>> {
  const out = new Map<string, Partial<Record<AnchorStep, string>>>();
  if (proposalIds.length === 0) return out;
  const anchors = rows<{ proposal_id: string; step: AnchorStep; transactions: { tx_hash: string | null; block_time: string | null } | { tx_hash: string | null; block_time: string | null }[] }>(
    await serviceClient().from("proposal_anchors")
      .select("proposal_id, step, transactions!inner(tx_hash, block_time, state)")
      .in("proposal_id", proposalIds).eq("transactions.state", TxState.Confirmed),
    "load confirmed anchors",
  );
  for (const row of anchors) {
    const tx = Array.isArray(row.transactions) ? row.transactions[0] : row.transactions;
    if (!tx?.tx_hash) continue;
    const steps = out.get(row.proposal_id) ?? {};
    if (!steps[row.step]) steps[row.step] = tx.tx_hash;
    out.set(row.proposal_id, steps);
  }
  return out;
}

/** The frozen tally hash of each proposal that has one (the agent API). */
export async function loadTallyHashes(proposalIds: readonly string[]): Promise<Map<string, string>> {
  if (proposalIds.length === 0) return new Map();
  return new Map(rows<{ proposal_id: string; hash: string }>(
    await serviceClient().from("proposal_tally_documents").select("proposal_id, hash").in("proposal_id", proposalIds),
    "load tally hashes",
  ).map((d) => [d.proposal_id, d.hash]));
}

/** The confirm poller's stamp: the block time of a transaction the chain included. */
export async function setTransactionBlockTime(transactionId: string, blockTime: string | null): Promise<void> {
  check(
    await serviceClient().from("transactions").update({ block_time: blockTime }).eq("id", transactionId),
    "set block time",
  );
}

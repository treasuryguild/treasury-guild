// The signed tally of a proposal as one self-contained JSON document, and a
// checker anyone can run on it without trusting Guild Vault. In the style of
// CIP-100 governance metadata: a `body` and its blake2b-256 `hash` over the
// canonical JSON, so the document can be anchored (hash) on-chain.
//
// The body holds nothing that changes after the close: what a passed
// proposal did when applied is not part of it, so the document a proposal
// is frozen with (proposal_tally_documents, migration 0059) is the one its
// live download shows and the one a later anchor names.
//
// The checker recomputes the proposal's content and rules fingerprints and
// the electorate hash, rebuilds every ballot's text and verifies its wallet
// signature, and counts the ballots again with the frozen rules.
//
// Client-safe by construction (no Buffer, no node modules): the proposal
// page's Verify button loads this module in the browser and runs the check
// there, so a member need not trust the server's answer.
import { blake2b } from "@meshsdk/core-cst";
import { verifyWalletSignature } from "@/lib/auth/walletSignature";
import { bytesToHex, utf8ToHex } from "@/lib/cardano/cip25";
import type { ProposalRow, ProposalVoteRow, ProposalVoterRow } from "@/lib/db/types";
import { ballotText } from "./ballot";
import { electorateHash } from "./electorateHash";
import { canonicalJson, type ProposalRules } from "./rules";
import { tallyProposal, type ProposalTally } from "./tally";

export const TALLY_DOCUMENT_TYPE = "guild-vault/proposal-tally";

export interface TallyDocumentBody {
  type: typeof TALLY_DOCUMENT_TYPE;
  version: 1;
  /** The app's host, as every ballot text names it. */
  app: string;
  community: string;
  proposal: {
    id: string;
    number: number;
    kind: string;
    title: string;
    body: string;
    discussionUrl: string | null;
    payload: unknown;
    contentHash: string;
    rules: ProposalRules;
    rulesHash: string;
    /** sha256 of the electorate list, as every ballot signed it (0060); null for a proposal opened before it existed. */
    electorateHash: string | null;
    proposer: string;
    createdAt: string;
    votingOpenedAt: string | null;
    closesAt: string | null;
    closedAt: string | null;
    state: string;
    tally: ProposalTally | null;
  };
  electorate: { wallet: string; recused: boolean }[];
  ballots: {
    voter: string;
    choice: string;
    reason: string | null;
    signedAt: string;
    signedText: string;
    key: string;
    signature: string;
  }[];
}

export interface TallyDocument {
  hashAlgorithm: "blake2b-256";
  body: TallyDocumentBody;
  hash: string;
}

function hashBody(body: TallyDocumentBody): string {
  return blake2b.hash(utf8ToHex(canonicalJson(body)), 32);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export function buildTallyDocument(input: {
  app: string;
  community: string;
  proposal: ProposalRow;
  voters: readonly Pick<ProposalVoterRow, "wallet_address" | "recused">[];
  votes: readonly Pick<ProposalVoteRow, "voter" | "choice" | "reason" | "signed_at" | "signed_text" | "cose_key" | "cose_signature">[];
}): TallyDocument {
  const p = input.proposal;
  const body: TallyDocumentBody = {
    type: TALLY_DOCUMENT_TYPE,
    version: 1,
    app: input.app,
    community: input.community,
    proposal: {
      id: p.id,
      number: p.number,
      kind: p.kind,
      title: p.title,
      body: p.body,
      discussionUrl: p.discussion_url,
      payload: p.payload,
      contentHash: p.content_hash,
      rules: p.rules,
      rulesHash: p.rules_hash,
      electorateHash: p.electorate_hash,
      proposer: p.proposer,
      createdAt: p.created_at,
      votingOpenedAt: p.voting_opened_at,
      closesAt: p.closes_at,
      closedAt: p.closed_at,
      state: p.state,
      tally: p.tally,
    },
    electorate: [...input.voters]
      .sort((a, b) => a.wallet_address.localeCompare(b.wallet_address))
      .map((v) => ({ wallet: v.wallet_address, recused: v.recused })),
    ballots: [...input.votes]
      .sort((a, b) => a.voter.localeCompare(b.voter))
      .map((v) => ({
        voter: v.voter, choice: v.choice, reason: v.reason,
        // The exact instant the voter signed, as the ballot text states it.
        signedAt: new Date(v.signed_at).toISOString(),
        signedText: v.signed_text, key: v.cose_key, signature: v.cose_signature,
      })),
  };
  return { hashAlgorithm: "blake2b-256", body, hash: hashBody(body) };
}

/** The document's exact bytes as stored and published: canonical JSON of the whole document. */
export function tallyDocumentText(doc: TallyDocument): string {
  return canonicalJson(doc);
}

/** A stored or downloaded document, or null when the text is not one. */
export function parseTallyDocument(text: string): TallyDocument | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const doc = value as Partial<TallyDocument>;
    if (doc.hashAlgorithm !== "blake2b-256" || typeof doc.hash !== "string" || typeof doc.body !== "object" || doc.body === null) {
      return null;
    }
    if (doc.body.type !== TALLY_DOCUMENT_TYPE) return null;
    return doc as TallyDocument;
  } catch {
    return null;
  }
}

/** Every problem found; an empty list means the document checks out. */
export async function checkTallyDocument(doc: TallyDocument): Promise<string[]> {
  const problems: string[] = [];
  const { body } = doc;
  const p = body.proposal;
  if (doc.hash !== hashBody(body)) problems.push("The document hash does not match its body");
  const contentHash = await sha256Hex(canonicalJson({
    kind: p.kind, title: p.title, body: p.body, discussionUrl: p.discussionUrl, payload: p.payload,
  }));
  if (contentHash !== p.contentHash) problems.push("The proposal's content does not match its fingerprint");
  if ((await sha256Hex(canonicalJson(p.rules))) !== p.rulesHash) problems.push("The rules do not match their fingerprint");
  // Documents frozen before 0060 have no electorateHash field: null, and the shorter ballot text.
  const electorate = p.electorateHash ?? null;
  if (electorate && (await electorateHash(body.electorate)) !== electorate) {
    problems.push("The voter list does not match the electorate fingerprint every ballot signed");
  }

  const seats = new Map(body.electorate.map((v) => [v.wallet, v.recused]));
  for (const ballot of body.ballots) {
    const who = `Ballot of ${ballot.voter}`;
    if (seats.get(ballot.voter) !== false) problems.push(`${who}: not an eligible voter`);
    const expected = ballotText({
      host: body.app, community: body.community, proposalNumber: p.number, proposalId: p.id,
      contentHash: p.contentHash, rulesHash: p.rulesHash, electorateHash: electorate, choice: ballot.choice,
      reason: ballot.reason, voter: ballot.voter, signedAt: ballot.signedAt,
    });
    if (expected !== ballot.signedText) problems.push(`${who}: the signed text does not match the ballot`);
    else if (!(await verifyWalletSignature(ballot.signedText, { key: ballot.key, signature: ballot.signature }, ballot.voter))) {
      problems.push(`${who}: the signature is not valid`);
    }
  }

  if (p.tally) {
    const voters = body.electorate.filter((v) => !v.recused).length;
    const recount = tallyProposal(p.rules, voters, body.ballots.map((b) => b.choice));
    if (recount.state !== p.tally.state || canonicalJson(recount.counts) !== canonicalJson(p.tally.counts)) {
      problems.push(`Counting the ballots again gives ${recount.state}, not the recorded ${p.tally.state}`);
    }
  }
  return problems;
}

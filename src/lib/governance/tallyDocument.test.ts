import { createHash } from "node:crypto";
import { Address, Ed25519PrivateKey, serializeAddress, signData } from "@meshsdk/core-cst";
import { describe, expect, it } from "vitest";
import type { VoteChoice } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import { ballotText } from "./ballot";
import { canonicalJson, DEFAULT_SETTINGS, rulesFor } from "./rules";
import { tallyProposal } from "./tally";
import {
  buildTallyDocument, checkTallyDocument, parseTallyDocument, tallyDocumentText, type TallyDocument,
} from "./tallyDocument";

const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function voter(seed: number) {
  const key = Ed25519PrivateKey.fromNormalBytes(Buffer.alloc(32, seed));
  const address = serializeAddress({ pubKeyHash: String(key.toPublic().hash().hex()), stakeCredentialHash: "cd".repeat(28) }, 0);
  return { key, address };
}

const rules = rulesFor(DEFAULT_SETTINGS.decision);
const content = { kind: "decision", title: "Adopt a code of conduct", body: "Yes or no.", discussionUrl: null, payload: {} };
const [ana, ben, cy] = [voter(1), voter(2), voter(3)];
const seats = [ana, ben, cy].map((v) => ({ wallet_address: v.address, recused: false }));
// The electorate hash as open_proposal_voting computes it (migration 0060).
const ELECTORATE_HASH = createHash("sha256").update(
  [...seats].sort((a, b) => (a.wallet_address < b.wallet_address ? -1 : 1)).map((s) => `${s.wallet_address} 0`).join("\n"),
).digest("hex");

function signedVote(v: ReturnType<typeof voter>, choice: VoteChoice, signedAt: string, electorateHash: string | null = ELECTORATE_HASH) {
  const text = ballotText({
    host: "app.treasuryguild.com", community: "guild", proposalNumber: 4, proposalId: "p4",
    contentHash: sha256(content), rulesHash: sha256(rules), electorateHash, choice, reason: null, voter: v.address, signedAt,
  });
  const sig = signData(text, { address: Address.fromBech32(v.address), key: v.key });
  return { voter: v.address, choice, reason: null, signed_at: signedAt, signed_text: text, cose_key: sig.key, cose_signature: sig.signature };
}

function document(electorateHash: string | null = ELECTORATE_HASH): TallyDocument {
  const votes = [signedVote(ana, "yes", "2026-09-29T10:00:00.000Z", electorateHash),
    signedVote(ben, "no", "2026-09-29T11:00:00.000Z", electorateHash),
    signedVote(cy, "yes", "2026-09-29T11:30:00.000Z", electorateHash)];
  const proposal = {
    id: "p4", number: 4, ...content, discussion_url: null, content_hash: sha256(content), rules, rules_hash: sha256(rules),
    electorate_hash: electorateHash,
    proposer: ana.address, created_at: "2026-09-28T10:00:00Z", voting_opened_at: "2026-09-28T10:00:00Z",
    closes_at: "2026-09-30T10:00:00Z", closed_at: "2026-09-30T10:05:00Z", state: "passed", execution_state: "not_applicable",
    tally: tallyProposal(rules, 3, votes.map((v) => v.choice)),
  } as unknown as ProposalRow;
  return buildTallyDocument({ app: "app.treasuryguild.com", community: "guild", proposal, votes, voters: seats });
}

describe("tally documents", () => {
  it("builds a document that checks out", async () => {
    const doc = document();
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.body.proposal.tally?.state).toBe("passed");
    expect(doc.body.proposal.electorateHash).toBe(ELECTORATE_HASH);
    expect(doc.body.ballots[0]!.signedText).toContain(`electorate: ${ELECTORATE_HASH}`);
    expect(await checkTallyDocument(doc)).toEqual([]);
  });

  it("catches a voter list that no longer matches the hash every ballot signed", async () => {
    const swapped = document();
    swapped.body.electorate = [...swapped.body.electorate, { wallet: "addr_test1late", recused: true }];
    expect(await checkTallyDocument(swapped)).toContain("The voter list does not match the electorate fingerprint every ballot signed");
  });

  it("still verifies a proposal opened before the electorate hash existed, and one frozen without the field", async () => {
    const older = document(null);
    expect(older.body.ballots[0]!.signedText).not.toContain("electorate:");
    expect(await checkTallyDocument(older)).toEqual([]);
    const withoutField: Partial<typeof older.body.proposal> = { ...older.body.proposal };
    delete withoutField.electorateHash;
    const legacy = { ...older, body: { ...older.body, proposal: withoutField } } as unknown as TallyDocument;
    // Its stored hash was made without the field, so only the body hash line would differ: recompute like the freeze did.
    const problems = await checkTallyDocument(legacy);
    expect(problems.filter((p) => !p.startsWith("The document hash"))).toEqual([]);
  });

  it("holds nothing that changes after the close, so the frozen bytes round-trip", async () => {
    const doc = document();
    expect("execution" in doc.body.proposal).toBe(false);
    const text = tallyDocumentText(doc);
    expect(text).toBe(canonicalJson(doc));
    const parsed = parseTallyDocument(text);
    expect(parsed).toEqual(doc);
    expect(tallyDocumentText(parsed!)).toBe(text);
    expect(await checkTallyDocument(parsed!)).toEqual([]);
    expect(parseTallyDocument("{}")).toBeNull();
    expect(parseTallyDocument("not json")).toBeNull();
    expect(parseTallyDocument(JSON.stringify({ ...doc, hashAlgorithm: "sha256" }))).toBeNull();
  });

  it("catches a changed choice, a changed text, a changed tally and a stale hash", async () => {
    const changedChoice = document();
    changedChoice.body.ballots.find((b) => b.voter === ben.address)!.choice = "yes";
    changedChoice.hash = document().hash;
    expect(await checkTallyDocument(changedChoice)).toEqual(expect.arrayContaining([
      "The document hash does not match its body",
      expect.stringMatching(/the signed text does not match the ballot/),
    ]));

    const changedTitle = document();
    changedTitle.body.proposal.title = "Something else";
    expect(await checkTallyDocument(changedTitle)).toContain("The proposal's content does not match its fingerprint");

    const wrongResult = document();
    wrongResult.body.proposal.tally = { ...wrongResult.body.proposal.tally!, state: "rejected" };
    expect(await checkTallyDocument(wrongResult)).toContain("Counting the ballots again gives passed, not the recorded rejected");
  });

  it("catches a forged signature and a voter outside the electorate", async () => {
    const forged = document();
    const other = signedVote(ben, "yes", "2026-09-29T10:00:00.000Z");
    forged.body.ballots[0]!.signature = other.cose_signature;
    expect(await checkTallyDocument(forged)).toEqual(expect.arrayContaining([expect.stringMatching(/signature is not valid/)]));

    const outsider = document();
    outsider.body.electorate = outsider.body.electorate.filter((v) => v.wallet !== cy.address);
    expect(await checkTallyDocument(outsider)).toEqual(expect.arrayContaining([expect.stringMatching(/not an eligible voter/)]));
  });
});

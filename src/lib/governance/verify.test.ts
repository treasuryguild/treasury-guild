import { describe, expect, it } from "vitest";
import { buildAnchorMetadata } from "@/lib/cardano/anchorMetadata";
import type { TallyDocument } from "./tallyDocument";
import { compareAnchors, type VerifiedAnchor } from "./verify";

const H = (c: string) => c.repeat(64);
const doc = {
  hashAlgorithm: "blake2b-256", hash: H("d"),
  body: {
    type: "guild-vault/proposal-tally", version: 1, app: "guildvault.app", community: "guild",
    proposal: {
      id: "p4", number: 4, kind: "decision", title: "t", body: "b", discussionUrl: null, payload: {}, contentHash: H("a"),
      rules: {}, rulesHash: H("b"), electorateHash: H("c"), proposer: "addr", createdAt: "2026-09-28T10:00:00Z",
      votingOpenedAt: "2026-09-29T10:00:00Z", closesAt: null, closedAt: "2026-10-01T10:00:00Z", state: "passed",
      tally: { counts: { yes: 2, no: 1 }, ballots: 3, electorate: 5, quorumMet: true, state: "passed", reason: "passed" },
    },
    electorate: [], ballots: [],
  },
} as unknown as TallyDocument;

const anchor = (step: VerifiedAnchor["step"], blockTime: string | null, entries = buildAnchorMetadata("guild", [
  [4, "proposed", H("a"), H("b")], [4, "opened", H("c")], [4, "closed", "passed", H("d"), [5, 3, [["no", 1], ["yes", 2]]], ["ipfs", "bafy"]],
])): VerifiedAnchor => ({ step, txHash: `tx-${step}`, blockTime, record: entries });

describe("compareAnchors", () => {
  it("finds nothing wrong when every anchor matches, and says the first two landed before voting", () => {
    const result = compareAnchors(doc, [
      anchor("proposed", "2026-09-28T12:00:00Z"), anchor("opened", "2026-09-29T09:00:00Z"), anchor("closed", "2026-10-01T12:00:00Z"),
    ], H("c"));
    expect(result).toEqual({ problems: [], anchoredBeforeVoting: true, found: ["proposed", "opened", "closed"] });
  });

  it("reports each fingerprint, state, hash, count and community mismatch", () => {
    const wrong = buildAnchorMetadata("other", [
      [4, "proposed", H("x"), H("y")], [4, "opened", H("z")], [4, "closed", "rejected", H("e"), [4, 2, [["yes", 2]]]],
    ]);
    const { problems } = compareAnchors(doc, [
      anchor("proposed", null, wrong), anchor("opened", null, wrong), anchor("closed", null, wrong),
    ], H("c"));
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/names the community "other"/),
      "The proposed anchor's content fingerprint differs from the document's",
      "The proposed anchor's rules fingerprint differs from the document's",
      "The opened anchor's voter-list fingerprint differs from the document's voter list",
      "The closed anchor says rejected, the document passed",
      "The closed anchor's record hash differs from the document's hash",
      "The closed anchor's counts differ from the document's tally",
    ]));
  });

  it("reports an anchor that carries no entry for the proposal, and a closed anchor without a hash", () => {
    const other = buildAnchorMetadata("guild", [[9, "proposed", H("a"), H("b")]]);
    const { problems, found } = compareAnchors(doc, [
      anchor("proposed", null, other), { step: "closed", txHash: "t", blockTime: null, record: buildAnchorMetadata("guild", [[4, "closed", "passed"]]) },
    ], H("c"));
    expect(problems).toEqual([
      "The proposed anchor (tx-proposed) carries no entry for proposal #4",
      "The closed anchor carries no record hash, but the proposal reached a vote",
    ]);
    expect(found).toEqual(["closed"]);
  });

  it("cannot tell the timing without both early anchors or their block times", () => {
    expect(compareAnchors(doc, [anchor("proposed", "2026-09-28T12:00:00Z")], H("c")).anchoredBeforeVoting).toBeNull();
    expect(compareAnchors(doc, [anchor("proposed", null), anchor("opened", null)], H("c")).anchoredBeforeVoting).toBeNull();
    expect(compareAnchors(doc, [anchor("proposed", "2026-09-28T12:00:00Z"), anchor("opened", "2026-09-30T00:00:00Z")], H("c")).anchoredBeforeVoting).toBe(false);
    expect(compareAnchors(doc, [], H("c"))).toEqual({ problems: [], anchoredBeforeVoting: null, found: [] });
  });
});

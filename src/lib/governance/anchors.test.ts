import { describe, expect, it } from "vitest";
import type { ProposalAnchorWithTx } from "@/lib/db/types";
import {
  anchoredLate, anchorEntryFor, anchorStatus, CLOSED_ANCHOR_COPY_GRACE_MS, dueAnchorSteps, type AnchorProposal,
} from "./anchors";

const H = (c: string) => c.repeat(64);
const now = Date.parse("2026-10-01T12:00:00Z");

function proposal(patch: Partial<AnchorProposal> = {}): AnchorProposal {
  return {
    id: "p1", number: 7, state: "discussion", content_hash: H("a"), rules_hash: H("b"), electorate_hash: null,
    voting_opened_at: null, anchored: true, tally: null, ...patch,
  };
}

function row(step: ProposalAnchorWithTx["step"], state: number, patch: Partial<{ id: string; tx_hash: string | null; block_time: string | null }> = {}): ProposalAnchorWithTx {
  return {
    proposal_id: "p1", step, transaction_id: patch.id ?? `t-${step}-${state}`, created_at: "2026-09-30T00:00:00Z",
    transactions: { id: patch.id ?? `t-${step}-${state}`, state, tx_hash: patch.tx_hash ?? null, block_time: patch.block_time ?? null },
  };
}

const tally = { counts: { yes: 2, no: 1 }, ballots: 3, electorate: 5, quorumMet: true, state: "passed" as const, reason: "passed" as const };
const frozen = { hash: H("d"), frozenAt: "2026-10-01T00:00:00Z", copies: [] };
const withCopy = { ...frozen, copies: [{ store: "ipfs" as const, locator: "bafy1" }] };
const publishing = { documentStore: "ipfs" as const, documentStoreSince: "2026-09-01T00:00:00Z" };

describe("anchorStatus", () => {
  it("reads confirmed as anchored, pending or submitted as in progress, rejected as nothing", () => {
    const status = anchorStatus([
      row("proposed", 3), row("proposed", 2, { id: "c1", tx_hash: "h1", block_time: "2026-09-30T10:00:00Z" }),
      row("opened", 1, { id: "s1", tx_hash: "h2" }), row("closed", 3),
    ]);
    expect(status.proposed).toEqual({ status: "anchored", txId: "c1", txHash: "h1", blockTime: "2026-09-30T10:00:00Z" });
    expect(status.opened).toEqual({ status: "in_progress", txId: "s1", txHash: "h2", blockTime: null });
    expect(status.closed.status).toBe("none");
    expect(anchorStatus([]).proposed.status).toBe("none");
  });

  it("prefers the earliest confirmed transaction and tolerates an array embed", () => {
    const later = row("proposed", 2, { id: "l", block_time: "2026-09-30T12:00:00Z" });
    const earlier = { ...row("proposed", 2, { id: "e", block_time: "2026-09-30T09:00:00Z" }) };
    earlier.transactions = [earlier.transactions as never];
    expect(anchorStatus([later, earlier, row("proposed", 0)]).proposed.txId).toBe("e");
  });
});

describe("dueAnchorSteps", () => {
  const none = anchorStatus([]);

  it("is nothing for a proposal that is not anchored", () => {
    expect(dueAnchorSteps(proposal({ anchored: false, state: "voting", voting_opened_at: "2026-09-30T00:00:00Z", electorate_hash: H("c") }), none, null, null, now)).toEqual([]);
  });

  it("owes the proposed step from creation, the opened step once voting opened", () => {
    expect(dueAnchorSteps(proposal(), none, null, null, now)).toEqual(["proposed"]);
    const voting = proposal({ state: "voting", voting_opened_at: "2026-09-30T00:00:00Z", electorate_hash: H("c") });
    expect(dueAnchorSteps(voting, none, null, null, now)).toEqual(["proposed", "opened"]);
    expect(dueAnchorSteps(voting, anchorStatus([row("proposed", 0)]), null, null, now)).toEqual(["opened"]);
    expect(dueAnchorSteps(voting, anchorStatus([row("proposed", 2), row("opened", 1)]), null, null, now)).toEqual([]);
    // Rejected transactions make the step due again.
    expect(dueAnchorSteps(voting, anchorStatus([row("proposed", 3), row("opened", 3)]), null, null, now)).toEqual(["proposed", "opened"]);
  });

  it("owes the closed step of a voted proposal once frozen, and after the copy or a day when publishing", () => {
    const passed = proposal({ state: "passed", voting_opened_at: "2026-09-28T00:00:00Z", electorate_hash: H("c"), tally });
    const done = anchorStatus([row("proposed", 2), row("opened", 2)]);
    expect(dueAnchorSteps(passed, done, null, null, now)).toEqual([]);
    expect(dueAnchorSteps(passed, done, frozen, null, now)).toEqual(["closed"]);
    expect(dueAnchorSteps(passed, done, frozen, publishing, now)).toEqual([]);
    expect(dueAnchorSteps(passed, done, withCopy, publishing, now)).toEqual(["closed"]);
    expect(dueAnchorSteps(passed, done, frozen, publishing, Date.parse(frozen.frozenAt) + CLOSED_ANCHOR_COPY_GRACE_MS + 1)).toEqual(["closed"]);
    // A store chosen after the freeze does not cover this document.
    expect(dueAnchorSteps(passed, done, frozen, { documentStore: "ipfs", documentStoreSince: "2026-10-01T06:00:00Z" }, now)).toEqual(["closed"]);
    // Every missing step is owed at once: a single transaction may carry all three.
    expect(dueAnchorSteps(passed, none, frozen, null, now)).toEqual(["proposed", "opened", "closed"]);
  });

  it("owes a closed step to a proposal closed without a vote only when its proposed anchor exists", () => {
    const withdrawn = proposal({ state: "withdrawn" });
    expect(dueAnchorSteps(withdrawn, none, null, null, now)).toEqual([]);
    expect(dueAnchorSteps(withdrawn, anchorStatus([row("proposed", 0)]), null, null, now)).toEqual(["closed"]);
    expect(dueAnchorSteps(withdrawn, anchorStatus([row("proposed", 2), row("closed", 1)]), null, null, now)).toEqual([]);
    // Cancelled for want of voters at creation: never anchored either.
    expect(dueAnchorSteps(proposal({ state: "cancelled" }), none, null, null, now)).toEqual([]);
  });
});

describe("anchorEntryFor", () => {
  it("builds each step's entry from the proposal, the frozen document and the copy in the chosen store", () => {
    const passed = proposal({ state: "passed", voting_opened_at: "2026-09-28T00:00:00Z", electorate_hash: H("c"), tally });
    expect(anchorEntryFor("proposed", passed, null, null)).toEqual([7, "proposed", H("a"), H("b")]);
    expect(anchorEntryFor("opened", passed, null, null)).toEqual([7, "opened", H("c")]);
    expect(anchorEntryFor("opened", proposal(), null, null)).toBeNull();
    expect(anchorEntryFor("closed", proposal({ state: "voting" }), frozen, null)).toBeNull();
    expect(anchorEntryFor("closed", passed, null, null)).toBeNull();
    expect(anchorEntryFor("closed", passed, frozen, null)).toEqual([7, "closed", "passed", H("d"), [5, 3, [["no", 1], ["yes", 2]]]]);
    expect(anchorEntryFor("closed", passed, withCopy, publishing)).toEqual([7, "closed", "passed", H("d"), [5, 3, [["no", 1], ["yes", 2]]], ["ipfs", "bafy1"]]);
    // A copy in a store the community no longer uses is not the anchor's hint.
    expect(anchorEntryFor("closed", passed, withCopy, null)).toHaveLength(5);
    expect(anchorEntryFor("closed", proposal({ state: "withdrawn" }), null, null)).toEqual([7, "closed", "withdrawn"]);
  });
});

describe("anchoredLate", () => {
  it("flags an anchor that landed after voting opened", () => {
    const at = (blockTime: string | null) => ({ status: "anchored" as const, txId: "t", txHash: "h", blockTime });
    expect(anchoredLate(at("2026-09-29T00:00:00Z"), "2026-09-28T00:00:00Z")).toBe(true);
    expect(anchoredLate(at("2026-09-27T00:00:00Z"), "2026-09-28T00:00:00Z")).toBe(false);
    expect(anchoredLate(at(null), "2026-09-28T00:00:00Z")).toBe(false);
    expect(anchoredLate({ ...at("2026-09-29T00:00:00Z"), status: "in_progress" }, "2026-09-28T00:00:00Z")).toBe(false);
    expect(anchoredLate(at("2026-09-29T00:00:00Z"), null)).toBe(false);
  });
});

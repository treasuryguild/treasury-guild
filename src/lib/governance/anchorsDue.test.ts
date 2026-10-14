// The loader's composition: candidates joined with their frozen documents,
// copies, anchor links and the community's publication setting become due
// rows in proposal-number then lifecycle-step order. The due rules and the
// entries themselves are pinned in anchors.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorCandidateRow, FrozenDocumentRow } from "@/lib/db/anchors";
import type { ProposalAnchorWithTx } from "@/lib/db/types";
import type { GovernanceCommunitySettings } from "@/lib/governance/rules";
import { CLOSED_ANCHOR_COPY_GRACE_MS } from "./anchors";

const mocks = vi.hoisted(() => ({
  loadAnchorCandidates: vi.fn(),
  loadFrozenDocuments: vi.fn(),
  loadGovernanceCommunitySettings: vi.fn(),
}));
vi.mock("@/lib/db/anchors", () => ({
  loadAnchorCandidates: mocks.loadAnchorCandidates,
  loadFrozenDocuments: mocks.loadFrozenDocuments,
}));
vi.mock("@/lib/db/governance", () => ({ loadGovernanceCommunitySettings: mocks.loadGovernanceCommunitySettings }));

import { loadDueAnchors, loadDueAnchorsBestEffort } from "./anchorsDue";

const H = (c: string) => c.repeat(64);
const COMMUNITY = "c-1";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const FROZEN_AT = "2026-10-01T00:00:00Z";
const OFF: GovernanceCommunitySettings = { documentStore: null, documentStoreSince: null, spendCheck: "warn" };
const PUBLISHING: GovernanceCommunitySettings = { documentStore: "ipfs", documentStoreSince: "2026-09-01T00:00:00Z", spendCheck: "warn" };
const TALLY = { counts: { yes: 2, no: 1 }, ballots: 3, electorate: 5, quorumMet: true, state: "passed" as const, reason: "passed" as const };

function link(proposalId: string, step: ProposalAnchorWithTx["step"], state: number, patch: Partial<{ id: string; block_time: string | null }> = {}): ProposalAnchorWithTx {
  const id = patch.id ?? `${proposalId}-${step}-${state}`;
  return {
    proposal_id: proposalId, step, transaction_id: id, created_at: "2026-09-30T00:00:00Z",
    transactions: { id, state, tx_hash: `hash-${id}`, block_time: patch.block_time ?? null },
  };
}

function candidate(id: string, number: number, patch: Partial<AnchorCandidateRow> = {}): AnchorCandidateRow {
  return {
    id, number, state: "discussion", content_hash: H("a"), rules_hash: H("b"), electorate_hash: null,
    voting_opened_at: null, anchored: true, tally: null, proposal_anchors: [], ...patch,
  };
}

/** A proposal that passed its vote, with every hash the entries read. */
function passed(id: string, number: number, anchors: ProposalAnchorWithTx[] = []): AnchorCandidateRow {
  return candidate(id, number, {
    state: "passed", voting_opened_at: "2026-09-28T00:00:00Z", electorate_hash: H("c"), tally: TALLY, proposal_anchors: anchors,
  });
}

function frozen(proposalId: string, copies: FrozenDocumentRow["proposal_document_copies"] = []): FrozenDocumentRow {
  return { proposal_id: proposalId, hash: H("d"), frozen_at: FROZEN_AT, proposal_document_copies: copies };
}

function arrange(candidates: AnchorCandidateRow[], documents: FrozenDocumentRow[] = [], settings: GovernanceCommunitySettings = OFF) {
  mocks.loadAnchorCandidates.mockResolvedValue(candidates);
  mocks.loadFrozenDocuments.mockResolvedValue(new Map(documents.map((d) => [d.proposal_id, d])));
  mocks.loadGovernanceCommunitySettings.mockResolvedValue(settings);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  arrange([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("loadDueAnchors", () => {
  it("is nothing for a community without anchored proposals, and loads nothing else", async () => {
    expect(await loadDueAnchors(COMMUNITY, NOW)).toEqual([]);
    expect(mocks.loadAnchorCandidates).toHaveBeenCalledExactlyOnceWith(COMMUNITY);
    expect(mocks.loadFrozenDocuments).not.toHaveBeenCalled();
    expect(mocks.loadGovernanceCommunitySettings).not.toHaveBeenCalled();
  });

  it("loads the documents of every candidate and the community's settings", async () => {
    arrange([candidate("p-9", 9), candidate("p-3", 3)]);
    await loadDueAnchors(COMMUNITY, NOW);
    expect(mocks.loadFrozenDocuments).toHaveBeenCalledExactlyOnceWith(["p-9", "p-3"]);
    expect(mocks.loadGovernanceCommunitySettings).toHaveBeenCalledExactlyOnceWith(COMMUNITY);
  });

  it("joins candidates, documents, copies and links into due rows in number then step order", async () => {
    arrange(
      [
        // A fresh proposal: only the proposed step, from creation.
        candidate("p-9", 9),
        // Passed: proposed confirmed, opened rejected (due again), closed never linked; a copy in the chosen store.
        passed("p-3", 3, [
          link("p-3", "proposed", 2, { block_time: "2026-09-27T00:00:00Z" }),
          link("p-3", "opened", 3),
        ]),
        // Voting, proposed submitted (in progress) and opened confirmed: nothing due.
        candidate("p-7", 7, {
          state: "voting", voting_opened_at: "2026-09-30T00:00:00Z", electorate_hash: H("e"),
          proposal_anchors: [link("p-7", "proposed", 1), link("p-7", "opened", 2)],
        }),
        // Withdrawn without a vote, its proposed anchor confirmed: the closed step carries the state only.
        candidate("p-5", 5, { state: "withdrawn", proposal_anchors: [link("p-5", "proposed", 2)] }),
      ],
      [frozen("p-3", [{ store: "ipfs", locator: "bafy-3" }])],
      PUBLISHING,
    );
    expect(await loadDueAnchors(COMMUNITY, NOW)).toEqual([
      { proposalId: "p-3", number: 3, step: "opened", entry: [3, "opened", H("c")] },
      {
        proposalId: "p-3", number: 3, step: "closed",
        entry: [3, "closed", "passed", H("d"), [5, 3, [["no", 1], ["yes", 2]]], ["ipfs", "bafy-3"]],
      },
      { proposalId: "p-5", number: 5, step: "closed", entry: [5, "closed", "withdrawn"] },
      { proposalId: "p-9", number: 9, step: "proposed", entry: [9, "proposed", H("a"), H("b")] },
    ]);
  });

  it("owes every step of a passed proposal nothing links, the closed one without a copy when not publishing", async () => {
    arrange([passed("p-3", 3)], [frozen("p-3")], OFF);
    expect(await loadDueAnchors(COMMUNITY, NOW)).toEqual([
      { proposalId: "p-3", number: 3, step: "proposed", entry: [3, "proposed", H("a"), H("b")] },
      { proposalId: "p-3", number: 3, step: "opened", entry: [3, "opened", H("c")] },
      { proposalId: "p-3", number: 3, step: "closed", entry: [3, "closed", "passed", H("d"), [5, 3, [["no", 1], ["yes", 2]]]] },
    ]);
  });

  it("leaves out a step a confirmed link anchors and one a pending or submitted link carries", async () => {
    arrange([
      passed("p-3", 3, [link("p-3", "proposed", 2), link("p-3", "opened", 0), link("p-3", "closed", 1)]),
    ], [frozen("p-3")], OFF);
    expect(await loadDueAnchors(COMMUNITY, NOW)).toEqual([]);
  });

  it("owes a step again once its links are all rejected", async () => {
    arrange([
      passed("p-3", 3, [link("p-3", "proposed", 3, { id: "a" }), link("p-3", "proposed", 3, { id: "b" }), link("p-3", "opened", 2), link("p-3", "closed", 3)]),
    ], [frozen("p-3")], OFF);
    expect((await loadDueAnchors(COMMUNITY, NOW)).map((d) => d.step)).toEqual(["proposed", "closed"]);
  });

  it("reads a deleted transaction (null embed) as no link at all", async () => {
    const orphan: ProposalAnchorWithTx = { ...link("p-3", "proposed", 2), transactions: null };
    arrange([passed("p-3", 3, [orphan, link("p-3", "opened", 2), link("p-3", "closed", 2)])]);
    expect((await loadDueAnchors(COMMUNITY, NOW)).map((d) => d.step)).toEqual(["proposed"]);
  });

  it("waits for the closed step of a proposal not yet frozen", async () => {
    arrange([passed("p-3", 3, [link("p-3", "proposed", 2), link("p-3", "opened", 2)])], [], OFF);
    expect(await loadDueAnchors(COMMUNITY, NOW)).toEqual([]);
  });

  it("holds the closed step for the copy while publishing, until a day has passed since the freeze", async () => {
    const done = [link("p-3", "proposed", 2), link("p-3", "opened", 2)];
    arrange([passed("p-3", 3, done)], [frozen("p-3")], PUBLISHING);
    expect(await loadDueAnchors(COMMUNITY, NOW)).toEqual([]);
    expect(await loadDueAnchors(COMMUNITY, Date.parse(FROZEN_AT) + CLOSED_ANCHOR_COPY_GRACE_MS)).toEqual([]);
    // A day later the anchor goes without the locator.
    const late = await loadDueAnchors(COMMUNITY, Date.parse(FROZEN_AT) + CLOSED_ANCHOR_COPY_GRACE_MS + 1);
    expect(late).toEqual([
      { proposalId: "p-3", number: 3, step: "closed", entry: [3, "closed", "passed", H("d"), [5, 3, [["no", 1], ["yes", 2]]]] },
    ]);
  });

  it("names only the copy in the chosen store, and no store at all once publishing is off", async () => {
    const done = [link("p-3", "proposed", 2), link("p-3", "opened", 2)];
    arrange([passed("p-3", 3, done)], [frozen("p-3", [{ store: "ipfs", locator: "bafy-3" }])], PUBLISHING);
    expect((await loadDueAnchors(COMMUNITY, NOW))[0]?.entry).toEqual(
      [3, "closed", "passed", H("d"), [5, 3, [["no", 1], ["yes", 2]]], ["ipfs", "bafy-3"]],
    );
    arrange([passed("p-3", 3, done)], [frozen("p-3", [{ store: "ipfs", locator: "bafy-3" }])], OFF);
    expect((await loadDueAnchors(COMMUNITY, NOW))[0]?.entry).toHaveLength(5);
  });

  it("gives a proposal closed without a vote no closed anchor until its proposed one exists", async () => {
    arrange([candidate("p-5", 5, { state: "withdrawn" })]);
    expect(await loadDueAnchors(COMMUNITY, NOW)).toEqual([]);
    arrange([candidate("p-5", 5, { state: "withdrawn", proposal_anchors: [link("p-5", "proposed", 0)] })]);
    expect((await loadDueAnchors(COMMUNITY, NOW)).map((d) => d.step)).toEqual(["closed"]);
  });

  it("skips a proposal that is not anchored, whatever it owes", async () => {
    arrange([passed("p-3", 3), candidate("p-4", 4, { anchored: false, state: "voting", voting_opened_at: "2026-09-30T00:00:00Z", electorate_hash: H("e") })], [frozen("p-3")]);
    expect((await loadDueAnchors(COMMUNITY, NOW)).map((d) => d.proposalId)).toEqual(["p-3", "p-3", "p-3"]);
  });

  it("takes the clock as now when none is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const done = [link("p-3", "proposed", 2), link("p-3", "opened", 2)];
    arrange([passed("p-3", 3, done)], [frozen("p-3")], PUBLISHING);
    vi.setSystemTime(Date.parse(FROZEN_AT) + CLOSED_ANCHOR_COPY_GRACE_MS);
    expect(await loadDueAnchors(COMMUNITY)).toEqual([]);
    vi.setSystemTime(Date.parse(FROZEN_AT) + CLOSED_ANCHOR_COPY_GRACE_MS + 1);
    expect((await loadDueAnchors(COMMUNITY)).map((d) => d.step)).toEqual(["closed"]);
  });

  it("lets a loader failure through", async () => {
    mocks.loadAnchorCandidates.mockRejectedValue(new Error("load anchor candidates: timeout"));
    await expect(loadDueAnchors(COMMUNITY, NOW)).rejects.toThrow("load anchor candidates: timeout");
  });
});

describe("loadDueAnchorsBestEffort", () => {
  it("passes the due anchors through", async () => {
    arrange([candidate("p-9", 9)]);
    expect(await loadDueAnchorsBestEffort(COMMUNITY)).toEqual([
      { proposalId: "p-9", number: 9, step: "proposed", entry: [9, "proposed", H("a"), H("b")] },
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("answers none and logs when a loader throws", async () => {
    const err = new Error("load frozen documents: connection refused");
    arrange([candidate("p-9", 9)]);
    mocks.loadFrozenDocuments.mockRejectedValue(err);
    expect(await loadDueAnchorsBestEffort(COMMUNITY)).toEqual([]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`load due anchors of community ${COMMUNITY} failed`, err);
  });
});

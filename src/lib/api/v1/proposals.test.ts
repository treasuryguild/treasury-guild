import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import type { ProposalListing } from "@/lib/db/governance";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import type { ProposalRow } from "@/lib/db/types";
import type { ProposalRules } from "@/lib/governance/rules";

const mocks = vi.hoisted(() => ({ community: vi.fn(), role: vi.fn(), listing: vi.fn() }));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/governance", () => ({ loadProposalListing: mocks.listing }));

import { callEndpoint } from "./endpoint";
import { describeProposal, listProposals, PROPOSAL_LIST_MAX } from "./proposals";

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
});

const now = Date.parse("2026-09-29T12:00:00Z");
const rules = {
  method: "consent", electorate: "members", activityMonths: 12, minMemberDays: 0, quorumPct: 25, thresholdPct: 50,
  lazyObjections: 1, discussionHours: 0, votingHours: 72, hideResults: true, recuseBeneficiaries: false,
} as ProposalRules;
const proposal = {
  id: "p1", number: 3, kind: "task", state: "voting", title: "Redesign onboarding", body: "Three screens.",
  discussion_url: null, discord_thread_id: null, discord_discussion_url: null,
  proposer: "addr_ben", rules, electorate_size: 5, ballots_cast: 2,
  content_hash: "a".repeat(64), rules_hash: "b".repeat(64), electorate_hash: "c".repeat(64),
  created_at: "2026-09-28T12:00:00Z", voting_starts_at: "2026-09-28T12:00:00Z", closes_at: "2026-10-01T12:00:00Z",
  closed_at: null, tally: null, outcome_reason: null, execution_state: null, execution_error: null, end_reason: null,
  payload: { task: { workgroupId: "w1", amounts: { ADA: "120" }, bountyLovelace: "120000000", assignSelf: true } },
} as unknown as ProposalRow;
const listing = (patch: Partial<ProposalListing> = {}): ProposalListing => ({
  proposals: [proposal], total: 1, myVotes: new Map(), mySeats: new Map([["p1", false]]),
  handles: new Map([["addr_ben", "ben"]]), ownerNames: new Map([["w1", "Design"]]),
  tallyHashes: new Map(), anchors: new Map(), ...patch,
});

describe("describeProposal", () => {
  it("says what passing changes and whether the caller can vote, without hidden ballots", () => {
    const shaped = describeProposal("guild", proposal, listing(), now);
    expect(shaped).toMatchObject({
      number: 3, proposer: "ben", canVote: true, result: null, myVote: null, voters: 5, ballotsCast: 2,
      changes: ["Adds the task to Design, paying 120 ADA per assignee, assigned to ben"],
      decidedBy: "Consent, quorum 25%",
      url: "http://localhost:3000/c/guild/proposals/p1",
    });
  });

  it("carries the fingerprints, the frozen tally hash and the confirmed anchors, null where none", () => {
    const bare = describeProposal("guild", proposal, listing(), now);
    expect(bare).toMatchObject({
      contentHash: "a".repeat(64), rulesHash: "b".repeat(64), electorateHash: "c".repeat(64), tallyHash: null,
      anchors: { proposed: null, opened: null, closed: null },
    });
    const anchored = describeProposal("guild", proposal, listing({
      tallyHashes: new Map([["p1", "d".repeat(64)]]),
      anchors: new Map([["p1", { proposed: "tx1", opened: "tx2" }]]),
    }), now);
    expect(anchored).toMatchObject({ tallyHash: "d".repeat(64), anchors: { proposed: "tx1", opened: "tx2", closed: null } });
  });

  it("shows the caller's own vote, and no vote for a recused or absent voter", () => {
    const voted = listing({ myVotes: new Map([["p1", { choice: "agree", reason: null, signed_at: "2026-09-29T10:00:00Z" }]]) });
    expect(describeProposal("guild", proposal, voted, now).myVote).toEqual({ choice: "agree", reason: null, signedAt: "2026-09-29T10:00:00Z" });
    expect(describeProposal("guild", proposal, listing({ mySeats: new Map([["p1", true]]) }), now).canVote).toBe(false);
    expect(describeProposal("guild", proposal, listing({ mySeats: new Map() }), now).canVote).toBe(false);
  });

  it("gives the recorded result once closed", () => {
    const closed = { ...proposal, state: "passed", closed_at: "2026-10-01T12:00:00Z", execution_state: "applied",
      tally: { counts: { agree: 2 }, ballots: 2, electorate: 5, quorumMet: true, state: "passed", reason: "passed" } } as ProposalRow;
    expect(describeProposal("guild", closed, listing(), now)).toMatchObject({
      canVote: false, result: { outcome: "Passed", counts: { agree: 2 } }, carriedOut: { state: "applied", error: null },
    });
  });
});

describe("proposal_list", () => {
  const caller: ApiCaller = { wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" };
  const closed = {
    ...proposal, id: "p2", number: 2, state: "rejected", closed_at: "2026-09-20T12:00:00Z", closes_at: "2026-09-20T12:00:00Z",
    execution_state: "not_applicable", outcome_reason: "blocked",
    tally: { counts: { agree: 3, block: 1 }, ballots: 4, electorate: 5, quorumMet: true, state: "rejected", reason: "blocked" },
  } as unknown as ProposalRow;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.community.mockResolvedValue({ id: "c-1", slug: "guild", name: "Guild", network: 0, visibility: "private" });
    mocks.role.mockResolvedValue("member");
    mocks.listing.mockResolvedValue(listing());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the caller's own ballots and seats only, newest 20 of every state by default", async () => {
    const res = await callEndpoint(listProposals, caller, { community: "guild" });
    expect(mocks.listing).toHaveBeenCalledExactlyOnceWith("c-1", "addr_w", { open: null, limit: 20 });
    expect(res).toMatchObject({ community: { slug: "guild", name: "Guild" }, total: 1 });
    expect(res.proposals).toEqual([describeProposal("guild", proposal, listing(), now)]);
  });

  it("maps the state filter to open / closed / all", async () => {
    await callEndpoint(listProposals, caller, { community: "guild", state: "open" });
    await callEndpoint(listProposals, caller, { community: "guild", state: "closed" });
    await callEndpoint(listProposals, caller, { community: "guild", state: "all" });
    expect(mocks.listing.mock.calls.map((call) => call[2].open)).toEqual([true, false, null]);
    await expect(callEndpoint(listProposals, caller, { community: "guild", state: "voting" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("gives no result while voting is open, whatever ballots were cast, and the recorded tally once closed", async () => {
    mocks.listing.mockResolvedValue(listing({ proposals: [proposal, closed], total: 2 }));
    const res = await callEndpoint(listProposals, caller, { community: "guild" });
    const [open, done] = res.proposals;
    expect(open).toMatchObject({ number: 3, state: "voting", ballotsCast: 2, result: null, myVote: null });
    expect(done).toMatchObject({
      number: 2, state: "rejected", result: { outcome: "A member blocked it", counts: { agree: 3, block: 1 } }, carriedOut: null, canVote: false,
    });
    // The result is the recorded tally: outcome and counts, nothing per voter.
    expect(Object.keys(done!.result!)).toEqual(["outcome", "counts"]);
  });

  it("shows the caller's own ballot on the proposal it was cast on, and no one else's", async () => {
    mocks.listing.mockResolvedValue(listing({
      proposals: [proposal, closed], total: 2,
      myVotes: new Map([["p1", { choice: "disagree", reason: "Too early", signed_at: "2026-09-29T10:00:00Z" }]]),
    }));
    const res = await callEndpoint(listProposals, caller, { community: "guild" });
    expect(res.proposals[0]?.myVote).toEqual({ choice: "disagree", reason: "Too early", signedAt: "2026-09-29T10:00:00Z" });
    expect(res.proposals[1]?.myVote).toBeNull();
    // The listing is read for the caller's wallet, and the answer has no field that could carry another voter's ballot.
    expect(mocks.listing.mock.calls[0]![1]).toBe("addr_w");
    for (const shaped of res.proposals) {
      expect(shaped).not.toHaveProperty("votes");
      expect(shaped).not.toHaveProperty("ballots");
    }
    expect(JSON.stringify(res)).not.toContain("signed_text");
  });

  it("caps the page at PROPOSAL_LIST_MAX", async () => {
    expect(PROPOSAL_LIST_MAX).toBe(100);
    await callEndpoint(listProposals, caller, { community: "guild", limit: String(PROPOSAL_LIST_MAX) });
    expect(mocks.listing.mock.calls[0]![2].limit).toBe(PROPOSAL_LIST_MAX);
    mocks.listing.mockClear();
    await expect(callEndpoint(listProposals, caller, { community: "guild", limit: PROPOSAL_LIST_MAX + 1 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(callEndpoint(listProposals, caller, { community: "guild", limit: 0 })).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.listing).not.toHaveBeenCalled();
  });

  it("reports the total matching the filter, not the page size", async () => {
    mocks.listing.mockResolvedValue(listing({ total: 42 }));
    expect((await callEndpoint(listProposals, caller, { community: "guild", limit: 1 })).total).toBe(42);
  });

  it("reads nothing for a non-member or a caller without the scope", async () => {
    mocks.role.mockResolvedValue(null);
    await expect(callEndpoint(listProposals, caller, { community: "guild" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(callEndpoint(listProposals, { ...caller, scopes: [] }, { community: "guild" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.listing).not.toHaveBeenCalled();
  });
});

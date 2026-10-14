import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VOTE_REASON } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { BALLOT_MAX_AGE_MS, ballotText } from "./ballot";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  requireMember: vi.fn(),
  slug: vi.fn(),
  proposal: vi.fn(),
  voter: vi.fn(),
  cast: vi.fn(),
}));
vi.mock("@/lib/auth/walletSignature", () => ({ verifyWalletSignature: mocks.verify }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.requireMember }));
vi.mock("@/lib/db/communities", () => ({ communitySlug: mocks.slug }));
vi.mock("@/lib/db/governance", () => ({
  loadProposal: mocks.proposal,
  loadVoter: mocks.voter,
  castProposalVote: mocks.cast,
}));

import { castBallot, issueBallot } from "./vote";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const VOTER = "addr_voter";
const proposal = (patch: Partial<ProposalRow> = {}) => ({
  id: PROPOSAL_ID, community_id: "c-1", number: 4, state: "voting", closes_at: "2026-09-30T12:00:00Z",
  content_hash: "c".repeat(64), rules_hash: "r".repeat(64), rules: { method: "consent" }, ...patch,
}) as unknown as ProposalRow;
/** The text the server must build from its own data for this voter and proposal. */
const expectedText = (patch: { choice: string; reason: string | null; signedAt: string }) => ballotText({
  host: "vault.example", community: "guild", proposalNumber: 4, proposalId: PROPOSAL_ID,
  contentHash: "c".repeat(64), rulesHash: "r".repeat(64), voter: VOTER, ...patch,
});
const signed = (patch: Record<string, unknown> = {}) => ({
  choice: "agree" as const, signedAt: NOW.toISOString(), key: "cose-key", signature: "cose-signature", ...patch,
});

beforeAll(() => {
  process.env.APP_URL = "https://vault.example/";
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.proposal.mockResolvedValue(proposal());
  mocks.requireMember.mockResolvedValue("member");
  mocks.slug.mockResolvedValue("guild");
  mocks.voter.mockResolvedValue({ recused: false });
  mocks.verify.mockResolvedValue(true);
  mocks.cast.mockResolvedValue(3);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("issueBallot", () => {
  it("builds the ballot text from the server's own data", async () => {
    const issued = await issueBallot(PROPOSAL_ID, VOTER, { choice: "agree" });
    expect(issued).toEqual({
      signedAt: NOW.toISOString(),
      text: expectedText({ choice: "agree", reason: null, signedAt: NOW.toISOString() }),
    });
    expect(issued.text.split("\n")).toEqual([
      "Guild Vault ballot",
      "app: vault.example",
      "community: guild",
      `proposal: #4 ${PROPOSAL_ID}`,
      `content: ${"c".repeat(64)}`,
      `rules: ${"r".repeat(64)}`,
      "choice: agree",
      "reason: -",
      `voter: ${VOTER}`,
      `signed: ${NOW.toISOString()}`,
    ]);
    expect(mocks.requireMember).toHaveBeenCalledWith("c-1", VOTER);
    expect(mocks.slug).toHaveBeenCalledWith("c-1");
    expect(mocks.voter).toHaveBeenCalledWith(PROPOSAL_ID, VOTER);
    // Issuing a text records nothing and checks no signature.
    expect(mocks.cast).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("flattens the reason onto one line, so it cannot add lines to the ballot", async () => {
    const issued = await issueBallot(PROPOSAL_ID, VOTER, { choice: "block", reason: "  too\nexpensive\nvoter: addr_other " });
    expect(issued.text).toBe(expectedText({ choice: "block", reason: "too expensive voter: addr_other", signedAt: NOW.toISOString() }));
    expect(issued.text.split("\n")).toHaveLength(10);
  });

  it("refuses a wallet that is not a member before reading its seat", async () => {
    mocks.requireMember.mockRejectedValue(new ForbiddenError("Not a community member"));
    await expect(issueBallot(PROPOSAL_ID, VOTER, { choice: "agree" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.voter).not.toHaveBeenCalled();
  });

  it("refuses a wallet outside the electorate, and a recused one", async () => {
    mocks.voter.mockResolvedValue(null);
    const outside = await issueBallot(PROPOSAL_ID, VOTER, { choice: "agree" }).catch((e: unknown) => e);
    expect(outside).toBeInstanceOf(ForbiddenError);
    expect((outside as Error).message).toBe("You are not in this proposal's electorate");

    mocks.voter.mockResolvedValue({ recused: true });
    const recused = await issueBallot(PROPOSAL_ID, VOTER, { choice: "agree" }).catch((e: unknown) => e);
    expect(recused).toBeInstanceOf(ForbiddenError);
    expect((recused as Error).message).toBe("You are recused from this proposal because it benefits you");
  });

  it("refuses while voting is not open: in discussion, closed, or past the deadline", async () => {
    for (const patch of [
      { state: "discussion", closes_at: null },
      { state: "passed" },
      { closes_at: NOW.toISOString() },
    ] as unknown as Partial<ProposalRow>[]) {
      mocks.proposal.mockResolvedValue(proposal(patch));
      const err = await issueBallot(PROPOSAL_ID, VOTER, { choice: "agree" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as Error).message).toBe("Voting is not open on this proposal");
    }
  });

  it("refuses a choice the proposal's method does not have", async () => {
    await expect(issueBallot(PROPOSAL_ID, VOTER, { choice: "yes" })).rejects.toBeInstanceOf(BadRequestError);
    mocks.proposal.mockResolvedValue(proposal({ rules: { method: "majority" } } as unknown as Partial<ProposalRow>));
    expect((await issueBallot(PROPOSAL_ID, VOTER, { choice: "yes" })).text).toContain("choice: yes");
    await expect(issueBallot(PROPOSAL_ID, VOTER, { choice: "block", reason: "no" })).rejects.toThrow("That choice does not exist for this proposal");
  });

  it("needs a reason for a block or an objection, and caps its length", async () => {
    await expect(issueBallot(PROPOSAL_ID, VOTER, { choice: "block" })).rejects.toThrow("Give a reason for your objection");
    await expect(issueBallot(PROPOSAL_ID, VOTER, { choice: "block", reason: " \n " })).rejects.toBeInstanceOf(BadRequestError);
    await expect(issueBallot(PROPOSAL_ID, VOTER, { choice: "agree", reason: "x".repeat(MAX_VOTE_REASON + 1) }))
      .rejects.toThrow(`Keep the reason under ${MAX_VOTE_REASON} characters`);
    expect((await issueBallot(PROPOSAL_ID, VOTER, { choice: "agree", reason: "x".repeat(MAX_VOTE_REASON) })).text)
      .toContain(`reason: ${"x".repeat(MAX_VOTE_REASON)}`);
  });

  it("passes on a proposal that does not exist", async () => {
    mocks.proposal.mockRejectedValue(new NotFoundError("Proposal not found"));
    await expect(issueBallot("nope", VOTER, { choice: "agree" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("castBallot", () => {
  it("verifies the rebuilt text and stores text, key and signature", async () => {
    const ballot = signed({ choice: "disagree", reason: " Not\nnow ", signedAt: "2026-09-29T11:55:00Z" });
    expect(await castBallot(PROPOSAL_ID, VOTER, ballot)).toEqual({ ballotsCast: 3 });

    // The issue time is re-serialized, so the text is the one issueBallot handed out.
    const text = expectedText({ choice: "disagree", reason: "Not now", signedAt: "2026-09-29T11:55:00.000Z" });
    expect(mocks.verify).toHaveBeenCalledWith(text, ballot, VOTER);
    expect(mocks.cast).toHaveBeenCalledTimes(1);
    expect(mocks.cast).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID, voter: VOTER, choice: "disagree", reason: "Not now",
      signedAt: "2026-09-29T11:55:00.000Z", signedText: text, key: "cose-key", signature: "cose-signature",
    });
  });

  it("accepts exactly the text issueBallot issued for the same ballot", async () => {
    const issued = await issueBallot(PROPOSAL_ID, VOTER, { choice: "block", reason: "Too costly" });
    vi.setSystemTime(NOW.getTime() + 60_000);
    await castBallot(PROPOSAL_ID, VOTER, signed({ choice: "block", reason: "Too costly", signedAt: issued.signedAt }));
    expect(mocks.verify.mock.calls[0]![0]).toBe(issued.text);
    expect(mocks.cast.mock.calls[0]![0].signedText).toBe(issued.text);
  });

  it("refuses a signature that does not match the ballot and stores nothing", async () => {
    mocks.verify.mockResolvedValue(false);
    const err = await castBallot(PROPOSAL_ID, VOTER, signed()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toBe("The signature does not match this ballot. Sign with the wallet you signed in with.");
    expect(mocks.cast).not.toHaveBeenCalled();
  });

  it("verifies against the session wallet, never an address the request names", async () => {
    await castBallot(PROPOSAL_ID, VOTER, signed({ voter: "addr_other" }));
    expect(mocks.verify.mock.calls[0]![2]).toBe(VOTER);
    expect(mocks.verify.mock.calls[0]![0]).toContain(`voter: ${VOTER}`);
    expect(mocks.cast.mock.calls[0]![0].voter).toBe(VOTER);
  });

  it("refuses an expired ballot before looking at the signature", async () => {
    const stale = new Date(NOW.getTime() - BALLOT_MAX_AGE_MS - 1).toISOString();
    const err = await castBallot(PROPOSAL_ID, VOTER, signed({ signedAt: stale })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe("This ballot expired before it was signed. Vote again.");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.cast).not.toHaveBeenCalled();

    // Exactly at the limit is still fresh.
    const edge = new Date(NOW.getTime() - BALLOT_MAX_AGE_MS).toISOString();
    await expect(castBallot(PROPOSAL_ID, VOTER, signed({ signedAt: edge }))).resolves.toEqual({ ballotsCast: 3 });
  });

  it("refuses a ballot issued in the future or with an unreadable time", async () => {
    const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    await expect(castBallot(PROPOSAL_ID, VOTER, signed({ signedAt: future }))).rejects.toBeInstanceOf(BadRequestError);
    await expect(castBallot(PROPOSAL_ID, VOTER, signed({ signedAt: "yesterday" }))).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.cast).not.toHaveBeenCalled();
  });

  it("refuses a wallet outside the electorate or recused, whatever it signed", async () => {
    mocks.voter.mockResolvedValue(null);
    await expect(castBallot(PROPOSAL_ID, VOTER, signed())).rejects.toBeInstanceOf(ForbiddenError);
    mocks.voter.mockResolvedValue({ recused: true });
    await expect(castBallot(PROPOSAL_ID, VOTER, signed())).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.cast).not.toHaveBeenCalled();
  });

  it("refuses a ballot once voting closed", async () => {
    mocks.proposal.mockResolvedValue(proposal({ state: "rejected" } as unknown as Partial<ProposalRow>));
    await expect(castBallot(PROPOSAL_ID, VOTER, signed())).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.cast).not.toHaveBeenCalled();
  });
});

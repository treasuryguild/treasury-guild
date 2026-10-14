import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { BadRequestError, ConflictError, ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  byNumber: vi.fn(),
  load: vi.fn(),
  end: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/governance", () => ({
  loadProposalByNumber: mocks.byNumber,
  loadProposal: mocks.load,
  endProposal: mocks.end,
}));

import { confirmDraft } from "./drafts";
import { callEndpoint } from "./endpoint";
import { previewProposalWithdraw } from "./proposalWithdraw";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["proposals:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1 };
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };
const proposal = (patch: Record<string, unknown> = {}) => ({
  id: "p-7", community_id: "c1", number: 7, title: "Adopt the handbook", kind: "decision", state: "discussion",
  proposer: "addr_w", content_hash: "a".repeat(64), ended_by: null, ...patch,
});

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.CRON_SECRET = "cron-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("member");
  mocks.byNumber.mockResolvedValue(proposal());
  mocks.load.mockResolvedValue(proposal());
  mocks.end.mockResolvedValue("withdrawn");
});

const preview = (input: Record<string, unknown> = { community: "signius", proposal: 7 }) =>
  callEndpoint(previewProposalWithdraw, caller, input);
const confirm = (draftToken: string, who: ApiCaller = caller) => callEndpoint(confirmDraft, who, { draftToken });

describe("proposal_withdraw_preview", () => {
  it("previews withdrawing the caller's own proposal in discussion, writing nothing", async () => {
    const res = await preview();
    expect(mocks.byNumber).toHaveBeenCalledWith("c1", 7);
    expect(mocks.end).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      action: "proposal_withdraw",
      summary: "Withdraw proposal #7: Adopt the handbook",
      details: { number: 7, state: "discussion", url: "http://localhost:3000/c/signius/proposals/p-7" },
    });
    expect(res.next).toContain("draft_confirm");
  });

  it("refuses someone else's proposal, and one past discussion", async () => {
    mocks.byNumber.mockResolvedValue(proposal({ proposer: "addr_x" }));
    await expect(preview()).rejects.toThrow("Only the member who made a proposal can withdraw it");
    mocks.byNumber.mockResolvedValue(proposal({ state: "voting" }));
    await expect(preview()).rejects.toThrow("Proposal #7 is voting");
  });

  it("needs proposals:write", async () => {
    await expect(callEndpoint(previewProposalWithdraw, { ...caller, scopes: ["communities:read"] }, { community: "signius", proposal: 7 }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("draft_confirm on a withdraw", () => {
  it("withdraws it through end_proposal", async () => {
    const { draftToken } = await preview();
    const res = await confirm(draftToken);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith("p-7", "addr_w", "withdrawn", null);
    expect(res).toEqual({
      action: "proposal_withdraw",
      community: { slug: "signius", name: "Signius" },
      created: true, number: 7, title: "Adopt the handbook", state: "withdrawn",
      url: "http://localhost:3000/c/signius/proposals/p-7",
    });
  });

  it("answers a repeat with the withdrawal already made", async () => {
    const { draftToken } = await preview();
    mocks.load.mockResolvedValue(proposal({ state: "withdrawn", ended_by: "addr_w" }));
    expect(await confirm(draftToken)).toMatchObject({ created: false, state: "withdrawn" });
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("refuses when the proposal moved on since the preview", async () => {
    const { draftToken } = await preview();
    mocks.load.mockResolvedValue(proposal({ state: "voting" }));
    await expect(confirm(draftToken)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("checks the action's own scope, the connection and the community", async () => {
    const { draftToken } = await preview();
    // A connection holding only another write scope may call draft_confirm, but not for this action.
    await expect(confirm(draftToken, { ...caller, scopes: ["tasks:write"] })).rejects.toThrow("proposals:write");
    await expect(confirm(draftToken, { ...caller, clientId: "c2" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(callEndpoint(confirmDraft, caller, { draftToken, community: "lab" })).rejects.toThrow("previewed for signius, not lab");
    await expect(confirm("nope")).rejects.toBeInstanceOf(BadRequestError);
    // No write scope at all: draft_confirm is not offered.
    await expect(confirm(draftToken, { ...caller, scopes: ["communities:read"] })).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.end).not.toHaveBeenCalled();
  });
});

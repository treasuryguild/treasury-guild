import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { BadRequestError, ConflictError, ForbiddenError, TooManyRequestsError } from "@/lib/errors";
import { DEFAULT_SETTINGS, rulesFor } from "@/lib/governance/rules";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  prepare: vi.fn(),
  createDraft: vi.fn(),
  findByDraft: vi.fn(),
  loadProposal: vi.fn(),
  revisions: vi.fn(),
  labels: vi.fn(),
  rateLimit: vi.fn(),
  workgroups: vi.fn(),
  treasuries: vi.fn(),
  members: vi.fn(),
  registry: vi.fn(),
  hints: vi.fn(),
  workgroupOwner: vi.fn(),
  treasuryOwner: vi.fn(),
  resolveAmounts: vi.fn(),
  setupInForce: vi.fn(),
  walletAssets: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/governance/propose", () => ({ prepareProposal: mocks.prepare }));
vi.mock("@/lib/db/governance", () => ({
  createDraftProposal: mocks.createDraft,
  findProposalByDraft: mocks.findByDraft,
  loadProposal: mocks.loadProposal,
  loadBudgetRevisions: mocks.revisions,
}));
vi.mock("@/lib/db/payments", () => ({ loadMemberLabels: mocks.labels }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/workgroups", () => ({ listCommunityWorkgroups: mocks.workgroups }));
vi.mock("@/lib/db/treasuries", () => ({ listCommunityTreasuries: mocks.treasuries }));
vi.mock("@/lib/db/membership", () => ({ listCommunityMembers: mocks.members }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry, loadMintAssetHints: mocks.hints }));
vi.mock("@/lib/db/budgetSave", () => ({
  loadWorkgroupBudgetOwner: mocks.workgroupOwner,
  loadTreasuryBudgetOwner: mocks.treasuryOwner,
  resolveBudgetAmounts: mocks.resolveAmounts,
}));
vi.mock("@/lib/db/budgetSetups", () => ({ loadSetupInForce: mocks.setupInForce }));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.walletAssets }));

import { callEndpoint } from "./endpoint";
import { createProposalFromDraft, draftFingerprint, previewProposal } from "./proposalWrite";

const caller: ApiCaller = {
  wallet: "addr_w", scopes: ["communities:read", "proposals:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1_790_000_000_000,
};
const CID = "11111111-1111-4111-8111-111111111111";
const WGID = "22222222-2222-4222-8222-222222222222";
const TID = "33333333-3333-4333-8333-333333333333";
const HOSKY = "a".repeat(56) + "484f534b59";
const GOLD = "b".repeat(56) + "474f4c44";
const COMMUNITY = { id: CID, slug: "signius", name: "Signius", network: 0, visibility: "private" };
const RULES = rulesFor({ ...DEFAULT_SETTINGS.decision, enabled: true, discussionHours: 48, votingHours: 72 });
const prepared = (patch: Record<string, unknown> = {}) => ({
  communityId: CID, kind: "decision", title: "Adopt the handbook", body: "Why.", discussionUrl: null, payload: {},
  contentHash: "a".repeat(64), rules: RULES, rulesHash: "b".repeat(64), workgroupIds: [], beneficiaries: [],
  proposer: "addr_w", budgetOwners: [], ...patch,
});
const DECISION = { community: "signius", kind: "decision", title: "Adopt the handbook", body: "Why." };
const WORKGROUP_CONTEXT = {
  communityId: CID, name: "Design", workgroupId: WGID, treasuryId: null,
  wallet: { address: "addr_test1_main", network: 0 }, notHeldMessage: "not held",
};
/** A prepared budget proposal; `stamp` stands for the resolve time stored in each amount. */
const budgetPrepared = (stamp: string) => prepared({
  kind: "budget",
  workgroupIds: [WGID],
  budgetOwners: [{ workgroupId: WGID, treasuryId: null, baseRevision: 3 }],
  contentHash: `${stamp}`.padEnd(64, "0"),
  payload: {
    steps: [{
      workgroupId: WGID, treasuryId: null, mode: "recurring", cadence: "monthly", startsOn: "2026-11-01",
      amounts: [{
        unit: "lovelace", amount: "5000000000", asset_label: "ADA", decimals: 6,
        workgroup_id: WGID, cadence: "monthly", created_by: "addr_w", updated_at: stamp,
      }],
      confirm: false, reason: "",
    }],
  },
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
  mocks.prepare.mockResolvedValue(prepared());
  mocks.labels.mockResolvedValue(new Map([["addr_w", "Ann"], ["addr_l", "Lee"]]));
  mocks.workgroups.mockResolvedValue([{ id: WGID, name: "Design", kind: "native", archived_at: null, treasury_id: TID }]);
  mocks.treasuries.mockResolvedValue([{ id: TID, name: "Main" }]);
  mocks.members.mockResolvedValue([
    { wallet_address: "addr_l", role: "member", contributors: { handle: "Lee", github_username: "lee" } },
    { wallet_address: "addr_m", role: "member", contributors: { handle: "Max", github_username: "maxi" } },
    { wallet_address: "addr_n", role: "admin", contributors: { handle: "max", github_username: null } },
  ]);
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.findByDraft.mockResolvedValue(null);
  mocks.createDraft.mockResolvedValue({ id: "p-1", number: 7, state: "discussion", created: true });
  mocks.loadProposal.mockResolvedValue({
    id: "p-1", number: 7, state: "discussion", title: "Adopt the handbook",
    voting_starts_at: "2026-10-03T12:00:00Z", closes_at: "2026-10-06T12:00:00Z",
  });
  mocks.registry.mockResolvedValue([{ fieldName: "HOSKY", unit: HOSKY, decimals: 0 }]);
  mocks.hints.mockResolvedValue(new Map());
  mocks.workgroupOwner.mockResolvedValue(WORKGROUP_CONTEXT);
  mocks.treasuryOwner.mockResolvedValue({ ...WORKGROUP_CONTEXT, name: "Main", workgroupId: null, treasuryId: TID });
  mocks.revisions.mockResolvedValue(new Map([[`w:${WGID}`, 3]]));
  mocks.setupInForce.mockResolvedValue({ mode: "recurring", cadence: "monthly" });
  // The resolver the proposal itself uses: HOSKY has 2 decimals by its mint hint.
  mocks.resolveAmounts.mockImplementation(async (_owner: unknown, budgets: { unit: string }[]) =>
    budgets.map((b) => ({ unit: b.unit, decimals: b.unit === HOSKY ? 2 : b.unit === "lovelace" ? 6 : 0 })));
});

async function preview(input: Record<string, unknown> = DECISION) {
  return callEndpoint(previewProposal, caller, input);
}

describe("proposal_preview", () => {
  it("runs the app's checks, writes nothing and answers with the proposal and a draft token", async () => {
    const res = await preview();
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(
      { communityId: CID, kind: "decision", title: "Adopt the handbook", body: "Why." },
      "addr_w",
    );
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(res.proposal).toMatchObject({
      kind: "decision", title: "Adopt the handbook", text: "Why.", changes: [], discussionHours: 48, votingHours: 72,
    });
    expect(Date.parse(res.proposal.votingClosesAround) - Date.parse(res.proposal.votingOpensAround)).toBe(72 * 3600_000);
    expect(res.effects.join(" ")).toContain("Cardano chain");
    expect(res.next).toContain("only if they say yes");
    expect(res.draftToken).toMatch(/^ey/);
  });

  it("puts a task on the board it names, with the reward as the board stores it", async () => {
    mocks.prepare.mockResolvedValue(prepared({
      kind: "task", payload: { task: { workgroupId: WGID, amounts: { ADA: "250" }, bountyLovelace: 250_000_000, assignSelf: true } },
    }));
    const res = await preview({ ...DECISION, kind: "task", task: { workgroup: "design", reward: { ADA: "250" }, assignSelf: true } });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "task", task: { workgroupId: WGID, amounts: { ADA: "250" }, assignSelf: true } }),
      "addr_w",
    );
    expect(res.proposal.changes).toEqual(["Adds the task to Design, paying 250 ADA per assignee, assigned to Ann"]);
  });

  it("refuses a task without its board or with a bad reward, before any check runs", async () => {
    await expect(preview({ ...DECISION, kind: "task" })).rejects.toThrow("needs task");
    await expect(preview({ ...DECISION, kind: "task", task: { workgroup: "Ops", reward: { ADA: "1" } } }))
      .rejects.toThrow('No workgroup "Ops" in this community. Workgroups: Design');
    await expect(preview({ ...DECISION, kind: "task", task: { workgroup: "Design", reward: { ADA: "lots" } } }))
      .rejects.toBeInstanceOf(BadRequestError);
    await expect(preview({ ...DECISION, kind: "poll" })).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("passes on the app's refusal, such as a kind the community has off", async () => {
    mocks.prepare.mockRejectedValue(new ConflictError("Proposals of this kind are off in this community."));
    await expect(preview()).rejects.toThrow("off in this community");
  });

  it("needs the proposals:write permission", async () => {
    await expect(callEndpoint(previewProposal, { ...caller, scopes: ["communities:read"] }, DECISION))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.community).not.toHaveBeenCalled();
  });
});

describe("proposal_preview: workgroup leads by name", () => {
  const workgroup = (leads: string[]) => preview({ ...DECISION, kind: "workgroup", workgroup: { name: "Research", leads } });

  it("resolves a handle, an @login and a wallet to wallets", async () => {
    mocks.prepare.mockResolvedValue(prepared({
      kind: "workgroup", payload: { workgroup: { name: "Research", description: "", leads: ["addr_l", "addr_m"] }, columns: [] },
    }));
    const res = await workgroup(["lee", "@maxi"]);
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "workgroup", workgroup: { name: "Research", description: "", leads: ["addr_l", "addr_m"] } }),
      "addr_w",
    );
    expect(res.proposal.changes[0]).toContain("led by Lee");
    await workgroup(["addr_n"]);
    expect(mocks.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ workgroup: expect.objectContaining({ leads: ["addr_n"] }) }), "addr_w");
  });

  it("refuses a name nobody has, and one that names several members", async () => {
    await expect(workgroup(["Zed"])).rejects.toThrow('No member "Zed" in this community');
    await expect(workgroup(["Max"])).rejects.toThrow('"Max" matches 2 members');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe("proposal_preview: budget changes", () => {
  const budget = (change: Record<string, unknown>) => preview({
    ...DECISION, kind: "budget", title: "Design budget",
    budget: { changes: [{ owner: "design", plan: "recurring", cadence: "monthly", startsOn: "2026-11", amounts: { ADA: "5000" }, ...change }] },
  });

  it("builds the Budgets page's save: owner, mode, base revision, base units with the stored decimals", async () => {
    mocks.prepare.mockResolvedValue(budgetPrepared("t1"));
    const res = await budget({ amounts: { ADA: "5000", hosky: "1.5" } });
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "budget",
      saves: [expect.objectContaining({
        workgroupId: WGID, budgetMonth: null, budgetCadence: "monthly", mode: "recurring", startsOn: "2026-11",
        expectedRevision: 3, confirmTransition: false, reason: "",
        budgets: [
          { cadence: "monthly", unit: "lovelace", amount: "5000000000" },
          { cadence: "monthly", unit: HOSKY, amount: "150" },
        ],
      })],
    }), "addr_w");
    expect(mocks.setupInForce).toHaveBeenCalledWith(`w:${WGID}`, "2026-11-01");
    // A registry token needs no chain read.
    expect(mocks.walletAssets).not.toHaveBeenCalled();
    expect(res.proposal.changes[0]).toContain("Design: Recurring monthly budget from 2026-11");
  });

  it("marks a change of setup, and takes a treasury's one quarter", async () => {
    mocks.setupInForce.mockResolvedValue(null);
    mocks.revisions.mockResolvedValue(new Map());
    await budget({ owner: "main", ownerType: "treasury", plan: "period", cadence: "quarterly", startsOn: "2027-01", reason: "Q1 events" });
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      saves: [expect.objectContaining({
        treasuryId: TID, budgetMonth: "2027-01", budgetCadence: "quarterly", mode: "quarterly",
        expectedRevision: 0, confirmTransition: true, reason: "Q1 events",
      })],
    }), "addr_w");
  });

  it("finds a token the owner's treasury holds, reading the chain under its rate limit", async () => {
    mocks.walletAssets.mockResolvedValue({
      lovelace: 0n, utxoCount: 1,
      tokens: [{ unit: GOLD, quantity: 10n, ticker: "GOLD", name: "Gold", decimals: 0, source: "registry" }],
    });
    await budget({ amounts: { GOLD: "40" } });
    expect(mocks.rateLimit).toHaveBeenCalledWith("chainProxy", "addr_w");
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      saves: [expect.objectContaining({ budgets: [{ cadence: "monthly", unit: GOLD, amount: "40" }] })],
    }), "addr_w");
  });

  it("refuses an unknown token, owner or amount, naming what there is", async () => {
    mocks.walletAssets.mockResolvedValue({ lovelace: 0n, utxoCount: 1, tokens: [] });
    await expect(budget({ amounts: { NOPE: "1" } })).rejects.toThrow('No token "NOPE" for Design. Known tokens: ADA, HOSKY');
    await expect(budget({ owner: "Ops" })).rejects.toThrow('No workgroup "Ops"');
    await expect(budget({ owner: "Ops", ownerType: "treasury" })).rejects.toThrow('No treasury "Ops" in this community. Treasuries: Main');
    await expect(budget({ amounts: { ADA: "1.1234567" } })).rejects.toThrow("more than 6 decimal places");
    await expect(budget({ amounts: { ADA: "0" } })).rejects.toThrow("greater than zero");
    await expect(budget({ amounts: {} })).rejects.toThrow("at least one amount");
    await expect(preview({ ...DECISION, kind: "budget" })).rejects.toThrow("needs budget");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe("draftFingerprint", () => {
  it("ignores when and by whom a budget amount was resolved, and nothing else", () => {
    const a = budgetPrepared("2026-10-01T10:00:00Z") as never;
    expect(draftFingerprint(a)).toBe(draftFingerprint(budgetPrepared("2026-10-01T10:05:00Z") as never));
    const changed = budgetPrepared("x") as unknown as { payload: { steps: { amounts: { amount: string }[] }[] } };
    changed.payload.steps[0]!.amounts[0]!.amount = "6000000000";
    expect(draftFingerprint(changed as never)).not.toBe(draftFingerprint(a));
    expect(draftFingerprint(prepared({ title: "Other" }) as never)).not.toBe(draftFingerprint(prepared() as never));
  });
});

describe("proposal_create", () => {
  it("creates exactly the previewed proposal, keyed by the draft, rate limited, and links to it", async () => {
    const { draftToken } = await preview();
    mocks.prepare.mockClear();
    const res = await callEndpoint(createProposalFromDraft, caller, { draftToken });
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(
      { communityId: CID, kind: "decision", title: "Adopt the handbook", body: "Why." },
      "addr_w",
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith("proposalCreate", "addr_w");
    expect(mocks.createDraft).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[0-9a-f]{32}$/), prepared());
    expect(mocks.findByDraft).toHaveBeenCalledWith(mocks.createDraft.mock.calls[0]![0]);
    expect(res).toEqual({
      community: { slug: "signius", name: "Signius" }, created: true, number: 7, state: "discussion",
      title: "Adopt the handbook", votingOpensAt: "2026-10-03T12:00:00Z", votingClosesAt: "2026-10-06T12:00:00Z",
      url: "http://localhost:3000/c/signius/proposals/p-1",
    });
  });

  it("confirms a budget proposal although its amounts were resolved again", async () => {
    mocks.prepare.mockResolvedValue(budgetPrepared("2026-10-01T10:00:00Z"));
    const { draftToken } = await preview({
      ...DECISION, kind: "budget",
      budget: { changes: [{ owner: "Design", plan: "recurring", cadence: "monthly", startsOn: "2026-11", amounts: { ADA: "5000" } }] },
    });
    mocks.prepare.mockResolvedValue(budgetPrepared("2026-10-01T10:05:00Z"));
    const res = await callEndpoint(createProposalFromDraft, caller, { draftToken });
    expect(res.created).toBe(true);
    expect(mocks.createDraft).toHaveBeenCalledOnce();
  });

  it("answers a repeated confirmation with the proposal already made, without re-checking", async () => {
    const { draftToken } = await preview();
    mocks.prepare.mockClear();
    mocks.findByDraft.mockResolvedValue({ id: "p-1" });
    const res = await callEndpoint(createProposalFromDraft, caller, { draftToken });
    expect(res).toMatchObject({ created: false, number: 7 });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("passes on the database's answer for a confirmation that lost a race", async () => {
    const { draftToken } = await preview();
    mocks.createDraft.mockResolvedValue({ id: "p-1", number: 7, state: "discussion", created: false });
    expect((await callEndpoint(createProposalFromDraft, caller, { draftToken })).created).toBe(false);
  });

  it("refuses when the rules or the content changed since the preview", async () => {
    const { draftToken } = await preview();
    mocks.prepare.mockResolvedValue(prepared({ rulesHash: "c".repeat(64) }));
    await expect(callEndpoint(createProposalFromDraft, caller, { draftToken })).rejects.toBeInstanceOf(ConflictError);
    mocks.prepare.mockResolvedValue(prepared({ body: "Something else." }));
    await expect(callEndpoint(createProposalFromDraft, caller, { draftToken })).rejects.toThrow("changed since the preview");
    mocks.prepare.mockRejectedValue(new ConflictError("Budgets changed since you opened this page."));
    await expect(callEndpoint(createProposalFromDraft, caller, { draftToken }))
      .rejects.toThrow("Budgets changed since you opened this page. Preview the proposal again.");
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("refuses another connection's draft, a draft for another community, and a non-member", async () => {
    const { draftToken } = await preview();
    await expect(callEndpoint(createProposalFromDraft, { ...caller, clientId: "c2" }, { draftToken }))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(callEndpoint(createProposalFromDraft, caller, { draftToken, community: "lab" }))
      .rejects.toThrow("previewed for signius, not lab");
    mocks.role.mockResolvedValue(null);
    await expect(callEndpoint(createProposalFromDraft, caller, { draftToken })).rejects.toThrow("Community not found");
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("creates nothing past the rate limit", async () => {
    const { draftToken } = await preview();
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    await expect(callEndpoint(createProposalFromDraft, caller, { draftToken })).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("refuses a made-up token and a caller without the permission", async () => {
    await expect(callEndpoint(createProposalFromDraft, caller, { draftToken: "nope" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(callEndpoint(createProposalFromDraft, { ...caller, scopes: ["communities:read"] }, { draftToken: "nope" }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import type * as Treasuries from "@/lib/db/treasuries";
import { BadRequestError, ConflictError, ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  treasuries: vi.fn(),
  planStake: vi.fn(),
  planDrep: vi.fn(),
  planVote: vi.fn(),
  persist: vi.fn(),
  findByDraft: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/treasuries", async (importOriginal) => ({
  ...(await importOriginal<typeof Treasuries>()),
  listCommunityTreasuries: mocks.treasuries,
}));
vi.mock("@/lib/cardano/governanceBuild", () => ({
  planStake: mocks.planStake,
  planDrep: mocks.planDrep,
  planVote: mocks.planVote,
  persistGovernanceTx: mocks.persist,
}));
vi.mock("@/lib/db/transactions", () => ({ findTransactionByDraft: mocks.findByDraft }));

import { confirmDraft } from "./drafts";
import { callEndpoint } from "./endpoint";
import { previewDrep, previewStake, previewVote } from "./governanceWrite";

const caller: ApiCaller = {
  wallet: "addr_w",
  scopes: ["governance:write"],
  clientId: "c1",
  via: "oauth",
  grantCreatedAt: 1,
};
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };
const MAIN = {
  id: "t-main",
  name: "Main",
  address: "addr_main",
  network: 0,
  required: 2,
  script_type: "atLeast",
  template: "plain",
  lock_until: null,
  recovery_script_type: null,
  recovery_required: null,
  cosigner_kind: null,
  archived_at: null,
  treasury_signers: [
    { wallet_address: "addr_a", display_name: "Ann", signer_group: "base" },
    { wallet_address: "addr_b", display_name: null, signer_group: "base" },
  ],
};

const stakePlan = () => ({
  kind: "stake" as const,
  treasuryId: "t-main",
  ctx: { treasury: MAIN, signers: MAIN.treasury_signers },
  path: "base" as const,
  action: "register_and_delegate",
  rewardAddress: "stake_test1reward",
  poolId: "pool1abc",
  dRepId: null,
  rewards: null,
  description: "Stake: register and delegate to pool1abc",
  governanceAction: { kind: "stake", action: "register_and_delegate", poolId: "pool1abc" },
  built: { unsignedTxHex: "84a0", txHash: "h".repeat(64) },
  fingerprint: "fp-stake",
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
  mocks.treasuries.mockResolvedValue([MAIN]);
  mocks.planStake.mockResolvedValue(stakePlan());
  mocks.planDrep.mockResolvedValue({
    ...stakePlan(),
    kind: "drep",
    action: "register",
    dRepId: "drep1xyz",
    anchorUrl: "https://ipfs.io/ipfs/Qm",
    anchorContentHash: "ah",
    description: "DRep: register drep1xyz",
    fingerprint: "fp-drep",
  });
  mocks.planVote.mockResolvedValue({
    ...stakePlan(),
    kind: "vote",
    dRepId: "drep1xyz",
    votes: [{ txHash: "a".repeat(64), certIndex: 0, voteKind: "Yes" }],
    rationaleContentHash: null,
    description: "Vote: 1 proposal as drep1xyz",
    fingerprint: "fp-vote",
  });
  mocks.persist.mockResolvedValue({ id: "tx-1", tx_hash: "h".repeat(64), spending_path: "base" });
  mocks.findByDraft.mockResolvedValue(null);
});

describe("stake_preview", () => {
  it("plans a stake action without persisting", async () => {
    const res = await callEndpoint(previewStake, caller, {
      community: "signius",
      treasury: "Main",
      action: "register_and_delegate",
      poolId: "pool1abc",
    });
    expect(mocks.planStake).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        treasuryId: "t-main",
        action: "register_and_delegate",
        poolId: "pool1abc",
      }),
      "addr_w",
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      action: "stake_create",
      summary: "Stake: register and delegate to pool1abc",
      details: { treasury: "Main", action: "register_and_delegate", poolId: "pool1abc", requiredSignatures: 2 },
    });
    expect(res.draftToken).toBeTruthy();
  });

  it("refuses a missing pool for register_and_delegate", async () => {
    await expect(
      callEndpoint(previewStake, caller, {
        community: "signius",
        treasury: "Main",
        action: "register_and_delegate",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.planStake).not.toHaveBeenCalled();
  });

  it("surfaces an SDK gate refusal from the planner", async () => {
    mocks.planStake.mockRejectedValue(
      new BadRequestError("Only a plain SDK treasury (with stake keys for every base signer) can stake. Create a new plain SDK wallet to enable staking."),
    );
    await expect(
      callEndpoint(previewStake, caller, {
        community: "signius",
        treasury: "Main",
        action: "register",
      }),
    ).rejects.toThrow(/plain SDK treasury/);
  });
});

describe("draft_confirm stake_create", () => {
  it("persists when the fingerprint still matches", async () => {
    const preview = await callEndpoint(previewStake, caller, {
      community: "signius",
      treasury: "Main",
      action: "register_and_delegate",
      poolId: "pool1abc",
    });
    const res = await callEndpoint(confirmDraft, caller, { draftToken: preview.draftToken });
    expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fingerprint: "fp-stake" }),
      "addr_w",
      expect.objectContaining({ agentDraftId: expect.any(String) }),
    );
    expect(res).toMatchObject({
      action: "stake_create",
      created: true,
      txId: "tx-1",
      treasury: "Main",
      requiredSignatures: 2,
    });
  });

  it("refuses when the fingerprint changed", async () => {
    const preview = await callEndpoint(previewStake, caller, {
      community: "signius",
      treasury: "Main",
      action: "register_and_delegate",
      poolId: "pool1abc",
    });
    mocks.planStake.mockResolvedValue({ ...stakePlan(), fingerprint: "changed" });
    await expect(callEndpoint(confirmDraft, caller, { draftToken: preview.draftToken })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("answers from the existing row on a repeated confirm", async () => {
    const preview = await callEndpoint(previewStake, caller, {
      community: "signius",
      treasury: "Main",
      action: "register_and_delegate",
      poolId: "pool1abc",
    });
    mocks.findByDraft.mockResolvedValue({
      id: "tx-existing",
      tx_hash: "e".repeat(64),
      treasury_id: "t-main",
      spending_path: "base",
    });
    const res = await callEndpoint(confirmDraft, caller, { draftToken: preview.draftToken });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(res).toMatchObject({ action: "stake_create", created: false, txId: "tx-existing" });
  });
});

describe("drep_preview and vote_preview", () => {
  it("previews a DRep register without publishing", async () => {
    const res = await callEndpoint(previewDrep, caller, {
      community: "signius",
      treasury: "Main",
      action: "register",
      givenName: "Signius DRep",
    });
    expect(res).toMatchObject({
      action: "drep_create",
      details: { dRepId: "drep1xyz" },
      effects: expect.arrayContaining([
        expect.stringMatching(/publishes the DRep metadata to public IPFS/),
      ]),
    });
    expect(mocks.planDrep).toHaveBeenCalledWith(
      expect.objectContaining({ action: "register", givenName: "Signius DRep" }),
      caller.wallet,
      { publish: false },
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("previews an on-chain vote without publishing", async () => {
    const res = await callEndpoint(previewVote, caller, {
      community: "signius",
      treasury: "Main",
      votes: [{ txHash: "a".repeat(64), certIndex: 0, voteKind: "Yes" }],
    });
    expect(res).toMatchObject({ action: "vote_create", details: { votes: [{ voteKind: "Yes" }] } });
    expect(mocks.planVote).toHaveBeenCalledWith(
      expect.objectContaining({ votes: [{ txHash: "a".repeat(64), certIndex: 0, voteKind: "Yes" }] }),
      caller.wallet,
      { publish: false },
    );
  });

  it("refuses governance:write without the scope", async () => {
    const noScope: ApiCaller = { ...caller, scopes: ["communities:read"] };
    await expect(
      callEndpoint(previewStake, noScope, {
        community: "signius",
        treasury: "Main",
        action: "register",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Treasuries from "@/lib/db/treasuries";
import { ConflictError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireAdmin: vi.fn(), insert: vi.fn(), single: vi.fn(), rpc: vi.fn(),
  workgroupCommunity: vi.fn(), requireActive: vi.fn(), setWorkgroupTreasury: vi.fn(),
  findByAddress: vi.fn(), loadDraft: vi.fn(), deleteDraft: vi.fn(), staking: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin, requireMember: vi.fn() }));
vi.mock("@/lib/cardano/multisigSDK", () => ({
  MultisigWallet: class {
    getScript() { return { address: "addr_test1script", scriptCbor: "8200" }; }
    stakingEnabled() { return mocks.staking(); }
    getStakeCredentialHash() { return mocks.staking() ? "cred" : undefined; }
  },
  addressToNetwork: (address: string) => (address.includes("test") ? 0 : 1),
  checkValidAddress: () => true,
  checkValidStakeKey: () => true,
  paymentKeyHash: (address: string) => `hash-${address}`,
  stakeKeyHash: (address: string) => `stake-${address}`,
}));
vi.mock("@/lib/treasury", () => ({ describeTreasury: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  check: vi.fn(),
  serviceClient: () => ({
    from: () => ({ insert: mocks.insert }),
    rpc: mocks.rpc,
  }),
}));
vi.mock("@/lib/db/communities", () => ({
  requireCommunity: async () => ({
    id: "10000000-0000-4000-8000-000000000001", network: 0, primary_treasury_id: "existing",
  }),
  setPrimaryTreasury: vi.fn(),
}));
vi.mock("@/lib/db/membership", () => ({ addMember: vi.fn(), promoteMembersToAdmin: vi.fn() }));
vi.mock("@/lib/db/treasuries", async (importOriginal) => ({
  ...(await importOriginal<typeof Treasuries>()),
  countCommunityTreasuries: async () => 1, loadTreasuryWithSigners: vi.fn(),
  findTreasuryByAddress: mocks.findByAddress,
}));
vi.mock("@/lib/db/workgroups", () => ({
  workgroupCommunityId: mocks.workgroupCommunity, requireActiveWorkgroup: mocks.requireActive,
}));
vi.mock("@/lib/db/workgroupRouting", () => ({ setWorkgroupTreasury: mocks.setWorkgroupTreasury }));
vi.mock("@/lib/db/signerDrafts", () => ({
  loadOpenSignerDraft: mocks.loadDraft,
  deleteSignerDraft: mocks.deleteDraft,
}));
import { POST } from "./route";

const workgroupId = "20000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const request = (extra: object = {}) => new Request("http://localhost/api/treasury", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ communityId: "10000000-0000-4000-8000-000000000001", name: "Dev wallet", required: 1, signers: [{ address: "addr_test1a" }], ...extra }),
});
const linkCall = (effective: "current" | "next") => ({
  workgroupId, treasuryId: "treasury-1", effective, actor: "admin", reason: "Linked when the treasury was created",
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.insert.mockReturnValue({ select: () => ({ single: mocks.single }) });
  mocks.single.mockResolvedValue({ data: { id: "treasury-1", name: "Dev wallet" }, error: null });
  mocks.rpc.mockResolvedValue({ data: 0, error: null });
  mocks.workgroupCommunity.mockResolvedValue("10000000-0000-4000-8000-000000000001");
  mocks.setWorkgroupTreasury.mockResolvedValue("2026-09-01");
  mocks.findByAddress.mockResolvedValue(null);
  mocks.loadDraft.mockResolvedValue(null);
  mocks.deleteDraft.mockResolvedValue(undefined);
  mocks.staking.mockReturnValue(false);
});

describe("create treasury API", () => {
  it("creates a community treasury without touching the routing", async () => {
    const result = await POST(request(), context);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ treasury: { id: "treasury-1" }, link: null, linkError: null });
    expect(mocks.setWorkgroupTreasury).not.toHaveBeenCalled();
    expect(mocks.workgroupCommunity).not.toHaveBeenCalled();
  });

  it("links the workgroup from this period as the signed-in admin", async () => {
    const result = await POST(request({ workgroupId }), context);
    expect(await result.json()).toMatchObject({
      link: { workgroupId, startsOn: "2026-09-01", effective: "current" }, linkError: null,
    });
    expect(mocks.setWorkgroupTreasury).toHaveBeenCalledTimes(1);
    expect(mocks.setWorkgroupTreasury).toHaveBeenCalledWith(linkCall("current"));
  });

  it("schedules the link for next period when this one was paid from another wallet", async () => {
    mocks.setWorkgroupTreasury
      .mockRejectedValueOnce(new ConflictError("This period already has payouts from another wallet."))
      .mockResolvedValueOnce("2026-10-01");
    const result = await POST(request({ workgroupId }), context);
    expect(await result.json()).toMatchObject({
      link: { workgroupId, startsOn: "2026-10-01", effective: "next" }, linkError: null,
    });
    expect(mocks.setWorkgroupTreasury).toHaveBeenLastCalledWith(linkCall("next"));
  });

  it("keeps the treasury and reports why when the link is refused", async () => {
    mocks.setWorkgroupTreasury.mockRejectedValue(new ConflictError("A later wallet change is already scheduled"));
    const result = await POST(request({ workgroupId }), context);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      treasury: { id: "treasury-1" }, link: null, linkError: "A later wallet change is already scheduled",
    });
    expect(mocks.setWorkgroupTreasury).toHaveBeenCalledTimes(2);
  });

  it("offers to restore an archived treasury with the same address", async () => {
    mocks.single.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key" } });
    mocks.findByAddress.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000009",
      community_id: "10000000-0000-4000-8000-000000000001",
      archived_at: "2026-10-01T00:00:00Z",
    });
    const result = await POST(request(), context);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      restoreTreasuryId: "40000000-0000-4000-8000-000000000009",
    });
  });

  it("refuses a workgroup of another community or an archived one before creating anything", async () => {
    mocks.workgroupCommunity.mockResolvedValue("other");
    expect((await POST(request({ workgroupId }), context)).status).toBe(400);
    mocks.workgroupCommunity.mockResolvedValue("10000000-0000-4000-8000-000000000001");
    mocks.requireActive.mockRejectedValue(new ConflictError("Restore this workgroup before making changes"));
    expect((await POST(request({ workgroupId }), context)).status).toBe(409);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.setWorkgroupTreasury).not.toHaveBeenCalled();
  });

  it("refuses pasted stake keys without a signer invite", async () => {
    const result = await POST(request({
      signers: [{ address: "addr_test1a", stakeAddress: "stake_test1pasted" }],
    }), context);
    expect(result.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
  });

  it("builds an SDK treasury from the invite and ignores pasted keys", async () => {
    const draftId = "30000000-0000-4000-8000-000000000001";
    mocks.staking.mockReturnValue(true);
    mocks.loadDraft.mockResolvedValue({
      id: draftId,
      signers: [{
        address: "addr_test1a",
        name: "Ada",
        stakeAddress: "stake_test1fromdraft",
        drepKeyHash: "ab".repeat(28),
      }],
    });
    const result = await POST(request({
      signerDraftId: draftId,
      signers: [{
        address: "addr_test1a",
        name: "Ada",
        stakeAddress: "stake_test1pasted",
        drepKeyHash: "cd".repeat(28),
      }],
    }), context);
    expect(result.status).toBe(200);
    const signerRows = mocks.insert.mock.calls.map((call) => call[0]).find(Array.isArray);
    expect(signerRows).toEqual([
      expect.objectContaining({
        wallet_address: "addr_test1a",
        stake_key_hash: "stake-stake_test1fromdraft",
        drep_key_hash: "ab".repeat(28),
        treasury_id: "treasury-1",
      }),
    ]);
    expect(mocks.deleteDraft).toHaveBeenCalledWith(draftId);
  });

  it("refuses to create while a signer has not connected", async () => {
    const draftId = "30000000-0000-4000-8000-000000000001";
    mocks.loadDraft.mockResolvedValue({
      id: draftId,
      signers: [{ address: "addr_test1a", name: null, stakeAddress: null, drepKeyHash: null }],
    });
    const result = await POST(request({ signerDraftId: draftId }), context);
    expect(result.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
  });
});

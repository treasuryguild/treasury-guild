import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  requirePool: vi.fn(),
  community: vi.fn(),
  fetch: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  archive: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/stakePools", () => ({
  requireCommunityStakePool: mocks.requirePool,
  refreshCommunityStakePool: mocks.refresh,
  replaceStakePoolWallets: mocks.replace,
  archiveCommunityStakePool: mocks.archive,
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/cardano/koios", () => ({ fetchPoolInfo: mocks.fetch }));

import { PATCH } from "./route";

const WALLET = "addr_test1admin";
const POOL_ID = "60000000-0000-4000-8000-000000000001";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const pool = {
  id: POOL_ID,
  community_id: COMMUNITY,
  pool_id: "pool1abc",
};

const patch = (body: object) =>
  PATCH(new Request(`http://localhost/api/stake-pools/${POOL_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: POOL_ID }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.requirePool.mockResolvedValue(pool);
  mocks.community.mockResolvedValue({ id: COMMUNITY, network: 0 });
  mocks.fetch.mockResolvedValue({
    poolId: "pool1abc",
    ticker: "ABC",
    margin: 0.03,
    fixedCost: "340000000",
    activeStake: "1",
    status: "registered",
    pledge: null,
    rewardAddress: "stake1",
    owners: [],
  });
  mocks.refresh.mockResolvedValue(pool);
  mocks.replace.mockResolvedValue([]);
  mocks.archive.mockResolvedValue(undefined);
});

describe("PATCH /api/stake-pools/[id]", () => {
  it("refreshes cached params from chain", async () => {
    const res = await patch({ refresh: true });
    expect(res.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(0, "pool1abc");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("replaces wallet role mappings", async () => {
    const res = await patch({
      wallets: [
        { role: "reward_account", address: "stake1reward" },
        { role: "community_treasury", treasuryId: "40000000-0000-4000-8000-000000000001" },
      ],
    });
    expect(res.status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledWith(POOL_ID, [
      { role: "reward_account", address: "stake1reward", floatWalletId: undefined, treasuryId: undefined },
      {
        role: "community_treasury",
        address: undefined,
        floatWalletId: undefined,
        treasuryId: "40000000-0000-4000-8000-000000000001",
      },
    ]);
  });

  it("archives a pool", async () => {
    const res = await patch({ archive: true });
    expect(res.status).toBe(200);
    expect(mocks.archive).toHaveBeenCalledWith(POOL_ID, WALLET);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("requires a session and admin", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await patch({ refresh: true })).status).toBe(401);

    mocks.session.mockResolvedValue({ wallet: WALLET });
    mocks.admin.mockRejectedValue(new ForbiddenError("Not an admin"));
    expect((await patch({ refresh: true })).status).toBe(403);
  });

  it("refuses an empty patch", async () => {
    expect((await patch({})).status).toBe(400);
  });
});

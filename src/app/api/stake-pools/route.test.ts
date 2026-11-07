import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  limit: vi.fn(),
  admin: vi.fn(),
  community: vi.fn(),
  fetch: vi.fn(),
  create: vi.fn(),
  loadTreasury: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/cardano/koios", () => ({ fetchPoolInfo: mocks.fetch }));
vi.mock("@/lib/db/stakePools", () => ({ createCommunityStakePool: mocks.create }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasuryWithSigners: mocks.loadTreasury }));

import { POST } from "./route";

const WALLET = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const detail = {
  poolId: "pool1abc",
  ticker: "ABC",
  margin: 0.02,
  fixedCost: "340000000",
  activeStake: "1",
  status: "registered",
  pledge: "500000000000",
  rewardAddress: "stake_test1reward",
  owners: ["stake_test1owner"],
};

const post = (body: object) =>
  POST(new Request("http://localhost/api/stake-pools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.limit.mockResolvedValue(undefined);
  mocks.admin.mockResolvedValue("admin");
  mocks.community.mockResolvedValue({ id: COMMUNITY, network: 0 });
  mocks.fetch.mockResolvedValue(detail);
  mocks.create.mockResolvedValue({
    id: "pool-row",
    funding_source_id: "fs-1",
  });
});

describe("POST /api/stake-pools", () => {
  it("links a pool for an admin", async () => {
    const res = await post({ communityId: COMMUNITY, poolId: "pool1abc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "pool-row", fundingSourceId: "fs-1" });
    expect(mocks.limit).toHaveBeenCalledWith("stakePoolCreate", WALLET);
    expect(mocks.fetch).toHaveBeenCalledWith(0, "pool1abc");
    expect(mocks.create).toHaveBeenCalledWith({
      community_id: COMMUNITY,
      detail,
      created_by: WALLET,
    });
  });

  it("requires a session and admin", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post({ communityId: COMMUNITY, poolId: "pool1abc" })).status).toBe(401);

    mocks.session.mockResolvedValue({ wallet: WALLET });
    mocks.admin.mockRejectedValue(new ForbiddenError("Not an admin"));
    expect((await post({ communityId: COMMUNITY, poolId: "pool1abc" })).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown pool", async () => {
    mocks.fetch.mockResolvedValue(null);
    expect((await post({ communityId: COMMUNITY, poolId: "pool1missing" })).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("surfaces the active-pool cap", async () => {
    mocks.create.mockRejectedValue(new ConflictError("A community can link at most 3 stake pools"));
    expect((await post({ communityId: COMMUNITY, poolId: "pool1abc" })).status).toBe(409);
  });
});

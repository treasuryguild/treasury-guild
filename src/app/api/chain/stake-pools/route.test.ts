import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ForbiddenError,
  TooManyRequestsError,
  UnauthorizedError,
  UpstreamError,
} from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  limit: vi.fn(),
  load: vi.fn(),
  member: vi.fn(),
  search: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasuryWithSigners: mocks.load }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/cardano/koios", () => ({
  searchStakePools: mocks.search,
  lookupStakePool: mocks.lookup,
}));

import { GET } from "./route";

const WALLET = "addr_test1member";
const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
const treasury = {
  id: TREASURY_ID,
  community_id: "community",
  network: 0,
  template: "plain",
};
const get = (query: string) =>
  GET(new Request(`http://localhost/api/chain/stake-pools${query}`), {
    params: Promise.resolve({}),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.limit.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue({ treasury, signers: [] });
  mocks.member.mockResolvedValue("member");
  mocks.search.mockResolvedValue([
    {
      poolId: "pool1abc",
      ticker: "ABC",
      margin: 0.02,
      fixedCost: "340000000",
      activeStake: "1000000000",
      status: "registered",
    },
  ]);
  mocks.lookup.mockResolvedValue({
    poolId: "pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222",
    ticker: "NUTS",
    margin: null,
    fixedCost: null,
    activeStake: null,
    status: "registered",
  });
});

describe("GET /api/chain/stake-pools", () => {
  it("returns registered pools for a community member", async () => {
    const res = await get(`?treasuryId=${TREASURY_ID}&q=ABC`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pools: [
        {
          poolId: "pool1abc",
          ticker: "ABC",
          margin: 0.02,
          fixedCost: "340000000",
          activeStake: "1000000000",
          status: "registered",
        },
      ],
    });
    expect(mocks.limit).toHaveBeenCalledWith("chainProxy", WALLET);
    expect(mocks.member).toHaveBeenCalledWith("community", WALLET);
    expect(mocks.search).toHaveBeenCalledWith(0, { q: "ABC", limit: undefined });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("looks up an exact pool id for title labeling", async () => {
    const poolId = "pool1wn6a6f23ctq06udwhw27ravdpd6zcr7jlut3yez0wzdackz3222";
    const res = await get(`?treasuryId=${TREASURY_ID}&poolId=${poolId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pools: [
        {
          poolId,
          ticker: "NUTS",
          margin: null,
          fixedCost: null,
          activeStake: null,
          status: "registered",
        },
      ],
    });
    expect(mocks.lookup).toHaveBeenCalledWith(0, poolId);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("passes an optional limit through", async () => {
    expect((await get(`?treasuryId=${TREASURY_ID}&limit=10`)).status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith(0, { q: undefined, limit: 10 });
  });

  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get(`?treasuryId=${TREASURY_ID}`)).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("refuses a missing or malformed treasuryId without charging the limit", async () => {
    for (const query of ["", "?treasuryId=", "?treasuryId=not-a-uuid"]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("charges the chain-proxy rate limit before loading the treasury", async () => {
    mocks.limit.mockRejectedValue(new TooManyRequestsError());
    expect((await get(`?treasuryId=${TREASURY_ID}`)).status).toBe(429);
    expect(mocks.limit).toHaveBeenCalledWith("chainProxy", WALLET);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("refuses a non-member", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await get(`?treasuryId=${TREASURY_ID}`)).status).toBe(403);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("answers 502 when Koios fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.search.mockRejectedValue(new UpstreamError("Koios 503"));
    const res = await get(`?treasuryId=${TREASURY_ID}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Koios 503" });
  });
});

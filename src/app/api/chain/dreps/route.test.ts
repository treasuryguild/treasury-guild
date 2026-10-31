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
  searchDreps: mocks.search,
  lookupDrep: mocks.lookup,
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
  GET(new Request(`http://localhost/api/chain/dreps${query}`), {
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
      dRepId: "drep1abc",
      givenName: "Team Drep",
      votingPower: "1000",
      registered: true,
      hasScript: false,
    },
  ]);
  mocks.lookup.mockResolvedValue({
    dRepId: "drep1lookup",
    givenName: "Looked Up",
    votingPower: "500",
    registered: true,
    hasScript: true,
  });
});

describe("GET /api/chain/dreps", () => {
  it("returns registered DReps for a community member", async () => {
    const res = await get(`?treasuryId=${TREASURY_ID}&q=Team`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dreps: [
        {
          dRepId: "drep1abc",
          givenName: "Team Drep",
          votingPower: "1000",
          registered: true,
          hasScript: false,
        },
      ],
    });
    expect(mocks.limit).toHaveBeenCalledWith("chainProxy", WALLET);
    expect(mocks.member).toHaveBeenCalledWith("community", WALLET);
    expect(mocks.search).toHaveBeenCalledWith(0, { q: "Team", limit: undefined });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("looks up an exact DRep id for title labeling", async () => {
    const dRepId = "drep1lookup";
    const res = await get(`?treasuryId=${TREASURY_ID}&dRepId=${dRepId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dreps: [
        {
          dRepId,
          givenName: "Looked Up",
          votingPower: "500",
          registered: true,
          hasScript: true,
        },
      ],
    });
    expect(mocks.lookup).toHaveBeenCalledWith(0, dRepId);
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

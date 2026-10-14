import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import type * as Treasuries from "@/lib/api/v1/treasuries";
import { UnauthorizedError } from "@/lib/errors";

// Wiring only: the endpoint is tested in src/lib/api/v1/endpoints.test.ts,
// the wrapper in src/lib/api/v1Route.test.ts. The real scope and input schema stay.
const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/api/v1/treasuries", async (importOriginal) => {
  const real = await importOriginal<typeof Treasuries>();
  return { ...real, treasuryOverview: { ...real.treasuryOverview, run: mocks.run } };
});
import { GET } from "./route";

const ctx = { params: Promise.resolve({ community: "signius" }) };
const get = (query = "") => GET(new Request(`http://localhost/api/v1/communities/signius/treasuries${query}`), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ treasuries: [] });
});

describe("GET /api/v1/communities/[community]/treasuries", () => {
  it("runs treasuryOverview for the path's community, reading balances unless told not to", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ treasuries: [] });
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(expect.anything(), { community: "signius", balances: true });
    await get("?balances=false");
    expect(mocks.run).toHaveBeenLastCalledWith(expect.anything(), { community: "signius", balances: false });
  });

  it("refuses a bad flag, a missing scope and a missing caller before running", async () => {
    expect((await get("?balances=maybe")).status).toBe(400);
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: [], clientId: "c1", via: "oauth" });
    expect((await get()).status).toBe(403);
    mocks.caller.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

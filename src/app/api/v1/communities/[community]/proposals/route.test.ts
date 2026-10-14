import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import type * as Proposals from "@/lib/api/v1/proposals";
import { UnauthorizedError } from "@/lib/errors";

// Wiring only: the endpoint is tested in src/lib/api/v1/proposals.test.ts,
// the wrapper in src/lib/api/v1Route.test.ts. The real scope and input schema stay.
const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/api/v1/proposals", async (importOriginal) => {
  const real = await importOriginal<typeof Proposals>();
  return { ...real, listProposals: { ...real.listProposals, run: mocks.run } };
});
import { GET } from "./route";

const ctx = { params: Promise.resolve({ community: "signius" }) };
const get = (query = "") => GET(new Request(`http://localhost/api/v1/communities/signius/proposals${query}`), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: null, via: "session" });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ proposals: [] });
});

describe("GET /api/v1/communities/[community]/proposals", () => {
  it("runs listProposals for the path's community, defaults filled", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proposals: [] });
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ via: "session" }), { community: "signius", state: "all", limit: 20 });
    await get("?state=open&limit=5");
    expect(mocks.run).toHaveBeenLastCalledWith(expect.anything(), { community: "signius", state: "open", limit: 5 });
  });

  it("refuses bad filters, a missing scope and a missing caller before running", async () => {
    expect((await get("?state=pending")).status).toBe(400);
    expect((await get("?limit=0")).status).toBe(400);
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: [], clientId: "c1", via: "oauth" });
    expect((await get()).status).toBe(403);
    mocks.caller.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

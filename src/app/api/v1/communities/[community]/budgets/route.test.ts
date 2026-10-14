import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import type * as Budgets from "@/lib/api/v1/budgets";
import { UnauthorizedError } from "@/lib/errors";

// Wiring only: the endpoint is tested in src/lib/api/v1/endpoints.test.ts,
// the wrapper in src/lib/api/v1Route.test.ts. The real scope and input schema stay.
const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/api/v1/budgets", async (importOriginal) => {
  const real = await importOriginal<typeof Budgets>();
  return { ...real, budgetSummary: { ...real.budgetSummary, run: mocks.run } };
});
import { GET } from "./route";

const ctx = { params: Promise.resolve({ community: "signius" }) };
const get = (query = "") => GET(new Request(`http://localhost/api/v1/communities/signius/budgets${query}`), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ budgets: [] });
});

describe("GET /api/v1/communities/[community]/budgets", () => {
  it("runs budgetSummary for the path's community with the month and view", async () => {
    const response = await get("?month=2026-09&view=quarter");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ budgets: [] });
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(expect.anything(), { community: "signius", month: "2026-09", view: "quarter" });
    await get();
    expect(mocks.run).toHaveBeenLastCalledWith(expect.anything(), { community: "signius", view: "month" });
  });

  it("refuses a bad month or view, a missing scope and a missing caller before running", async () => {
    expect((await get("?month=2026-9")).status).toBe(400);
    expect((await get("?view=year")).status).toBe(400);
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: [], clientId: "c1", via: "oauth" });
    expect((await get()).status).toBe(403);
    mocks.caller.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

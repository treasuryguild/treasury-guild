import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import type * as Tasks from "@/lib/api/v1/tasks";
import { UnauthorizedError } from "@/lib/errors";

// Wiring only: the endpoint's checks and loading are in src/lib/api/v1/endpoints.test.ts,
// the wrapper's in src/lib/api/v1Route.test.ts. The real scope and input schema stay.
const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/api/v1/tasks", async (importOriginal) => {
  const real = await importOriginal<typeof Tasks>();
  return { ...real, listTasks: { ...real.listTasks, run: mocks.run } };
});
import { GET } from "./route";

const ctx = { params: Promise.resolve({ community: "signius" }) };
const get = (query = "") => GET(new Request(`http://localhost/api/v1/communities/signius/tasks${query}`), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ tasks: [], total: 0 });
});

describe("GET /api/v1/communities/[community]/tasks", () => {
  it("runs listTasks for the path's community with the parsed filters", async () => {
    const response = await get("?workgroup=Development&payState=payable&includeArchived=true&limit=10");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: [], total: 0 });
    expect(mocks.caller).toHaveBeenCalledWith(expect.any(Request), { allowSession: true });
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ wallet: "addr_w" }),
      { community: "signius", workgroup: "Development", payState: "payable", includeArchived: true, limit: 10 },
    );
  });

  it("fills the defaults", async () => {
    await get();
    expect(mocks.run).toHaveBeenCalledWith(expect.anything(), { community: "signius", includeArchived: false, limit: 50 });
  });

  it("refuses bad filters before running", async () => {
    expect((await get("?payState=spent")).status).toBe(400);
    expect((await get("?limit=201")).status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("refuses a connection without the scope, and a request without a caller", async () => {
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: [], clientId: "c1", via: "oauth" });
    expect((await get()).status).toBe(403);
    mocks.caller.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

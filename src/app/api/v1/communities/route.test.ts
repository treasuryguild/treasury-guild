import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import { UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn(), memberships: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/membership", () => ({ communitiesForWallet: mocks.memberships }));
import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const get = () => GET(new Request("http://localhost/api/v1/communities"), ctx);

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.memberships.mockResolvedValue([]);
});

describe("GET /api/v1/communities", () => {
  it("lists the caller's own communities, charged to the agent API budget", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ communities: [] });
    expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith("addr_w");
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
  });

  it("refuses a connection without the scope, and a request without a caller", async () => {
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: [], clientId: "c1", via: "oauth" });
    expect((await get()).status).toBe(403);
    mocks.caller.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import { UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
import { GET } from "./route";

const ctx = { params: Promise.resolve({}) };
const get = () => GET(new Request("http://localhost/api/v1/me"), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue(undefined);
});

describe("GET /api/v1/me", () => {
  it("names the wallet, the connection and its scopes; a session caller has no client", async () => {
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" });
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ wallet: "addr_w", client: "c1", scopes: ["communities:read"] });
    expect(mocks.caller).toHaveBeenCalledWith(expect.any(Request), { allowSession: true });
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: null, via: "session" });
    expect(await (await get()).json()).toEqual({ wallet: "addr_w", client: null, scopes: ["communities:read"] });
  });

  it("refuses a connection without the scope, and a request without a caller", async () => {
    mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: [], clientId: "c1", via: "oauth" });
    expect((await get()).status).toBe(403);
    mocks.caller.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
  });
});

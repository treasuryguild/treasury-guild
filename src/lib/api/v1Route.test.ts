import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as Caller from "@/lib/api/caller";
import { TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => null, requireSession: async () => null }));

import { v1Route } from "./route";
import { defineEndpoint } from "./v1/endpoint";

const endpoint = defineEndpoint({
  scope: "communities:read",
  input: z.object({ community: z.string(), limit: z.coerce.number().default(5), archived: z.boolean().default(false) }),
  run: async (_caller, input) => mocks.run(input) as Promise<object>,
});
const GET = v1Route<{ community: string }>(endpoint);
const ctx = { params: Promise.resolve({ community: "signius" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue({ wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ ok: true });
});

describe("v1Route", () => {
  it("charges the agent API budget shared with /api/mcp, then runs the endpoint", async () => {
    const res = await GET(new Request("http://localhost/api/v1/communities/signius/tasks?limit=3&archived=true"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    expect(mocks.run).toHaveBeenCalledWith({ community: "signius", limit: 3, archived: true });
  });

  it("answers 429 over budget without running the endpoint", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    expect((await GET(new Request("http://localhost/api/v1/x"), ctx)).status).toBe(429);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("answers 401 without a caller, before charging anything", async () => {
    mocks.caller.mockRejectedValue(new UnauthorizedError());
    expect((await GET(new Request("http://localhost/api/v1/x"), ctx)).status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("lets a path segment win over a query parameter of the same name", async () => {
    await GET(new Request("http://localhost/api/v1/x?community=other"), ctx);
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ community: "signius" }));
  });
});

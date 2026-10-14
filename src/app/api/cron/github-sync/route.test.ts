import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/github/sweep", () => ({ runGithubSyncSweep: mocks.run }));
import { POST } from "./route";

const SECRET = "cron-secret-for-tests";
const RESULT = { results: { "org/repo": "synced 3, deleted 0" } };
const context = { params: Promise.resolve({}) };
const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/cron/github-sync", { method: "POST", headers });

const savedSecret = process.env.CRON_SECRET;
beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.run.mockResolvedValue(RESULT);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe("POST /api/cron/github-sync", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { Authorization: "Bearer wrong-secret" }],
    ["the bare secret", { Authorization: SECRET }],
    ["another scheme", { Authorization: `Basic ${SECRET}` }],
    ["a secret with a suffix", { Authorization: `Bearer ${SECRET}x` }],
  ])("answers 401 to %s and does not run", async (_label, headers) => {
    const res = await POST(request(headers), context);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("never runs when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(request({ Authorization: "Bearer undefined" }), context);
    expect(res.status).toBe(500);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("runs the sweep once and returns its result", async () => {
    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith();
  });

  it("surfaces a sweep failure as a 500 with the message", async () => {
    mocks.run.mockRejectedValue(new Error("GitHub rate limit exceeded"));
    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }), context);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "GitHub rate limit exceeded" });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("surfaces an upstream failure as a 502", async () => {
    mocks.run.mockRejectedValue(new UpstreamError("GitHub answered 503"));
    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }), context);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "GitHub answered 503" });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/calls/capture", () => ({ runCallsSync: mocks.run }));
import { POST } from "./route";

const SECRET = "cron-secret-for-tests";
const RESULT = { discord: { calls: 2, snapshots: 2 }, zoom: { reports: 1 }, meet: { calls: 0 } };
const context = { params: Promise.resolve({}) };
const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/cron/calls-sync", { method: "POST", headers });

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

describe("POST /api/cron/calls-sync", () => {
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

  it("runs the sync once and returns its result", async () => {
    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith();
  });

  it("surfaces a sync failure as a 500 with the message", async () => {
    mocks.run.mockRejectedValue(new Error("Discord gateway closed"));
    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }), context);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Discord gateway closed" });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("surfaces an upstream failure as a 502", async () => {
    mocks.run.mockRejectedValue(new UpstreamError("Zoom answered 503"));
    const res = await POST(request({ Authorization: `Bearer ${SECRET}` }), context);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Zoom answered 503" });
  });
});

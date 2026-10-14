import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), reconcile: vi.fn(), sync: vi.fn(), calls: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/reconciliation/sweep", () => ({ runReconcileSweep: mocks.reconcile }));
vi.mock("@/lib/github/sweep", () => ({ runGithubSyncSweep: mocks.sync }));
vi.mock("@/lib/calls/capture", () => ({ runCallsSync: mocks.calls }));
import { CRON_JOB_IDS } from "@/lib/cron/jobs";
import { POST } from "./route";

const DEV = "addr_test1dev";
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/dev/cron", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

const CALLS_RESULT = {
  calls: 1,
  snapshots: 1,
  results: { "Weekly sync": 4 },
  zoomReports: { "Town hall": "no report yet" },
  meetCalls: {},
};

const savedEnv = process.env.DEV_WALLETS;
beforeEach(() => {
  vi.resetAllMocks();
  process.env.DEV_WALLETS = DEV;
  mocks.session.mockResolvedValue({ wallet: DEV });
  mocks.reconcile.mockResolvedValue({ results: { t1: { newIncoming: 0, confirmed: 1 } }, writtenBack: 0, discordPosted: 1 });
  mocks.sync.mockResolvedValue({ results: { "org/repo": "synced 3, deleted 0" } });
  mocks.calls.mockResolvedValue(CALLS_RESULT);
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.DEV_WALLETS;
  else process.env.DEV_WALLETS = savedEnv;
});

describe("POST /api/dev/cron", () => {
  it("refuses wallets that are not on the allowlist", async () => {
    mocks.session.mockResolvedValue({ wallet: "addr_test1stranger" });
    const res = await POST(request({ job: "reconcile" }), context);
    expect(res.status).toBe(403);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.calls).not.toHaveBeenCalled();
  });

  it("runs the reconcile sweep and returns its result", async () => {
    const res = await POST(request({ job: "reconcile" }), context);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toBe("reconcile");
    expect(typeof body.ms).toBe("number");
    expect(body.result).toEqual({ results: { t1: { newIncoming: 0, confirmed: 1 } }, writtenBack: 0, discordPosted: 1 });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.calls).not.toHaveBeenCalled();
  });

  it("runs the GitHub sync sweep", async () => {
    const res = await POST(request({ job: "github-sync" }), context);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ results: { "org/repo": "synced 3, deleted 0" } });
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.calls).not.toHaveBeenCalled();
  });

  it("runs the call capture", async () => {
    const res = await POST(request({ job: "calls-sync" }), context);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toBe("calls-sync");
    expect(typeof body.ms).toBe("number");
    expect(body.result).toEqual(CALLS_RESULT);
    expect(mocks.calls).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("has a runner for every registered job", async () => {
    for (const job of CRON_JOB_IDS) {
      const res = await POST(request({ job }), context);
      expect(res.status, job).toBe(200);
      expect((await res.json()).job).toBe(job);
    }
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.calls).toHaveBeenCalledTimes(1);
  });

  it.each([{ job: "nope" }, {}])("rejects invalid input %j", async (body) => {
    const res = await POST(request(body), context);
    expect(res.status).toBe(400);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.calls).not.toHaveBeenCalled();
  });

  it("surfaces a sweep failure as a 500 with the message", async () => {
    mocks.reconcile.mockRejectedValue(new Error("Koios unreachable"));
    const res = await POST(request({ job: "reconcile" }), context);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Koios unreachable" });
  });
});

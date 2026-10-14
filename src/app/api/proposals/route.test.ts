import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), rateLimit: vi.fn(), make: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/governance/propose", () => ({ makeProposal: mocks.make }));

import { POST } from "./route";

const WALLET = "addr_test1proposer";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WORKGROUP = "20000000-0000-4000-8000-000000000001";
const DECISION = { kind: "decision", communityId: COMMUNITY, title: "  Adopt the new charter  " };
const context = { params: Promise.resolve({}) };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/proposals", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
  }), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.make.mockResolvedValue({ id: "p1", number: 7 });
});

describe("POST /api/proposals", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post(DECISION)).status).toBe(401);
    expect(mocks.make).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post(DECISION, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post(DECISION, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.make).not.toHaveBeenCalled();
  });

  it("makes the proposal as the session wallet and returns what the lib answers", async () => {
    const res = await post({ ...DECISION, proposer: "addr_test1someoneelse" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "p1", number: 7 });
    expect(mocks.rateLimit).toHaveBeenCalledWith("proposalCreate", WALLET);
    expect(mocks.make).toHaveBeenCalledTimes(1);
    const [input, proposer] = mocks.make.mock.calls[0]!;
    expect(proposer).toBe(WALLET);
    expect(input).toMatchObject({ kind: "decision", communityId: COMMUNITY, title: "Adopt the new charter", body: "" });
    expect(input).not.toHaveProperty("proposer");
  });

  it("passes a workgroup proposal's payload through", async () => {
    await post({ kind: "workgroup", communityId: COMMUNITY, title: "Start a docs workgroup", workgroup: { name: "Docs" } });
    expect(mocks.make).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "workgroup", workgroup: { name: "Docs", description: "", leads: [] } }),
      WALLET,
    );
  });

  it("refuses an invalid body before charging the rate limit", async () => {
    const invalid = [
      "{not json",
      {},
      { ...DECISION, kind: "coup" },
      { ...DECISION, communityId: "not-a-uuid" },
      { ...DECISION, title: "   " },
      { kind: "budget", communityId: COMMUNITY, title: "Budget", saves: [] },
      { kind: "workgroup", communityId: COMMUNITY, title: "No payload" },
      { kind: "task", communityId: COMMUNITY, title: "Task", task: { workgroupId: WORKGROUP, amounts: "many" } },
    ];
    for (const body of invalid) expect((await post(body)).status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.make).not.toHaveBeenCalled();
  });

  it("stops at the rate limit", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    expect((await post(DECISION)).status).toBe(429);
    expect(mocks.make).not.toHaveBeenCalled();
  });

  it("maps the lib's refusal to its status", async () => {
    mocks.make.mockRejectedValue(new ConflictError("Proposals of this kind are off in this community. An admin can turn them on under Governance."));
    const res = await post(DECISION);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Proposals of this kind are off in this community. An admin can turn them on under Governance.", conflict: true });
  });
});

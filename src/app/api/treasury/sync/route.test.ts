import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), member: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/reconciliation/staleSync", () => ({ syncCommunityIfStale: mocks.sync }));
import { POST } from "./route";

const WALLET = "addr_test1member";
const RESULT = {
  polled: ["t1"],
  results: { t1: { newIncoming: 2, confirmed: 1 } },
  lastSyncedAt: "2026-09-16T10:00:00.000Z",
};
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/treasury/sync", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.sync.mockResolvedValue(RESULT);
});

describe("POST /api/treasury/sync", () => {
  it("refuses non-members without touching the chain", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    const res = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001" }), context);
    expect(res.status).toBe(403);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("syncs the member's community and returns the result", async () => {
    const res = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001" }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(mocks.member).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", WALLET);
    expect(mocks.sync).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001");
  });

  it.each([{}, { communityId: "" }])("rejects invalid input %j", async (body) => {
    const res = await POST(request(body), context);
    expect(res.status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("surfaces a sync failure as a 500 with the message", async () => {
    mocks.sync.mockRejectedValue(new Error("Koios unreachable"));
    const res = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001" }), context);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Koios unreachable" });
  });
});

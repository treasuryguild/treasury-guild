import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), admin: vi.fn(), addMember: vi.fn(), addLead: vi.fn(), removeLead: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupAdmin: mocks.admin }));
vi.mock("@/lib/db/membership", () => ({ addMember: mocks.addMember }));
vi.mock("@/lib/db/workgroups", () => ({ addWorkgroupLead: mocks.addLead, removeWorkgroupLead: mocks.removeLead }));
import { DELETE, POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WORKGROUP = "20000000-0000-4000-8000-000000000001";
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const context = { params: Promise.resolve({}) };
const send = (handler: typeof POST, method: string, body: object, headers: Record<string, string> = {}) =>
  handler(new Request("http://localhost/api/workgroup-leads", {
    method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue(COMMUNITY);
  mocks.addMember.mockResolvedValue(undefined);
  mocks.addLead.mockResolvedValue(undefined);
  mocks.removeLead.mockResolvedValue(undefined);
});

function nothingWritten() {
  expect(mocks.addMember).not.toHaveBeenCalled();
  expect(mocks.addLead).not.toHaveBeenCalled();
  expect(mocks.removeLead).not.toHaveBeenCalled();
}

describe("POST /api/workgroup-leads", () => {
  it("makes the wallet a member of the workgroup's community, then its lead", async () => {
    const res = await send(POST, "POST", { workgroupId: WORKGROUP, wallet: ALICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.admin).toHaveBeenCalledWith(WORKGROUP, ADMIN);
    expect(mocks.addMember).toHaveBeenCalledExactlyOnceWith(COMMUNITY, ALICE);
    expect(mocks.addLead).toHaveBeenCalledExactlyOnceWith(WORKGROUP, ALICE);
    expect(mocks.addMember.mock.invocationCallOrder[0]).toBeLessThan(mocks.addLead.mock.invocationCallOrder[0]!);
  });

  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await send(POST, "POST", { workgroupId: WORKGROUP, wallet: ALICE })).status).toBe(401);
    expect((await send(POST, "POST", { workgroupId: WORKGROUP, wallet: ALICE }, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("refuses a malformed workgroup id or lead address before checking the role", async () => {
    for (const body of [{}, { workgroupId: WORKGROUP }, { workgroupId: "nope", wallet: ALICE }, { workgroupId: WORKGROUP, wallet: "not-an-address" }]) {
      expect((await send(POST, "POST", body)).status).toBe(400);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("refuses everyone but an admin of the workgroup's community, and a workgroup that is gone", async () => {
    mocks.admin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await send(POST, "POST", { workgroupId: WORKGROUP, wallet: ALICE })).status).toBe(403);
    mocks.admin.mockRejectedValueOnce(new NotFoundError("Workgroup not found"));
    expect((await send(POST, "POST", { workgroupId: WORKGROUP, wallet: ALICE })).status).toBe(404);
    nothingWritten();
  });
});

describe("DELETE /api/workgroup-leads", () => {
  it("removes the lead and leaves the membership alone, whatever the stored wallet looks like", async () => {
    const res = await send(DELETE, "DELETE", { workgroupId: WORKGROUP, wallet: "legacy-wallet-value" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.admin).toHaveBeenCalledWith(WORKGROUP, ADMIN);
    expect(mocks.removeLead).toHaveBeenCalledExactlyOnceWith(WORKGROUP, "legacy-wallet-value");
    expect(mocks.addMember).not.toHaveBeenCalled();
    expect(mocks.addLead).not.toHaveBeenCalled();
  });

  it("requires a session, the same origin, a valid body and the admin role", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await send(DELETE, "DELETE", { workgroupId: WORKGROUP, wallet: ALICE })).status).toBe(401);
    expect((await send(DELETE, "DELETE", { workgroupId: WORKGROUP, wallet: ALICE }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await send(DELETE, "DELETE", { workgroupId: WORKGROUP })).status).toBe(400);
    expect((await send(DELETE, "DELETE", { workgroupId: "nope", wallet: ALICE })).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.admin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await send(DELETE, "DELETE", { workgroupId: WORKGROUP, wallet: ALICE })).status).toBe(403);
    mocks.admin.mockRejectedValueOnce(new NotFoundError("Workgroup not found"));
    expect((await send(DELETE, "DELETE", { workgroupId: WORKGROUP, wallet: ALICE })).status).toBe(404);
    nothingWritten();
  });
});

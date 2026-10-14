import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), admin: vi.fn(), load: vi.fn(), end: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/governance", () => ({ loadProposal: mocks.load, endProposal: mocks.end }));

import { POST } from "./route";

const WALLET = "addr_test1admin";
const ID = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const post = (body: unknown, headers: Record<string, string> = {}, id = ID) =>
  POST(new Request(`http://localhost/api/proposals/${id}/cancel`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
  }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.load.mockResolvedValue({ id: ID, community_id: COMMUNITY, state: "voting" });
  mocks.admin.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue("cancelled");
});

describe("POST /api/proposals/[id]/cancel", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post({})).status).toBe(401);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post({}, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("refuses an invalid reason before loading anything", async () => {
    expect((await post({ reason: 5 })).status).toBe(400);
    expect((await post({ reason: "x".repeat(501) })).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown proposal", async () => {
    mocks.load.mockRejectedValue(new NotFoundError("Proposal not found"));
    expect((await post({}, {}, "not-a-uuid")).status).toBe(404);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("requires an admin of the proposal's community", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await post({ reason: "Duplicate" })).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("cancels as the session wallet with the trimmed reason", async () => {
    const res = await post({ reason: "  Duplicate of #4  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "cancelled", executionState: "not_applicable" });
    expect(mocks.end).toHaveBeenCalledWith(ID, WALLET, "cancelled", "Duplicate of #4");
  });

  it("passes a null reason when none is given", async () => {
    await post({});
    expect(mocks.end).toHaveBeenCalledWith(ID, WALLET, "cancelled", null);
  });

  it("maps the RPC's refusal of a closed proposal", async () => {
    mocks.end.mockRejectedValue(new ConflictError("This proposal is already closed"));
    expect((await post({})).status).toBe(409);
  });
});

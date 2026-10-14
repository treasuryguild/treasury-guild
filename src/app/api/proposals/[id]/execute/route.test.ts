import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), admin: vi.fn(), load: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/governance", () => ({ loadProposal: mocks.load, executeProposal: mocks.execute }));

import { POST } from "./route";

const WALLET = "addr_test1admin";
const ID = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const post = (headers: Record<string, string> = {}, id = ID) =>
  POST(new Request(`http://localhost/api/proposals/${id}/execute`, { method: "POST", headers }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.load.mockResolvedValue({ id: ID, community_id: COMMUNITY, state: "passed", execution_state: "failed" });
  mocks.admin.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue("applied");
});

describe("POST /api/proposals/[id]/execute", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown proposal", async () => {
    mocks.load.mockRejectedValue(new NotFoundError("Proposal not found"));
    expect((await post({}, "not-a-uuid")).status).toBe(404);
    expect(mocks.load).toHaveBeenCalledWith("not-a-uuid");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("requires an admin of the proposal's community", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await post()).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("carries the proposal out as the session wallet and reports the new execution state", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "passed", executionState: "applied" });
    expect(mocks.execute).toHaveBeenCalledWith(ID, WALLET);
  });
});

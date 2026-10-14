import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), member: vi.fn(), load: vi.fn(), end: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/governance", () => ({ loadProposal: mocks.load, endProposal: mocks.end }));

import { POST } from "./route";

const WALLET = "addr_test1proposer";
const ID = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const post = (headers: Record<string, string> = {}, id = ID, body?: object) =>
  POST(new Request(`http://localhost/api/proposals/${id}/withdraw`, {
    method: "POST", headers, ...(body && { body: JSON.stringify(body) }),
  }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.load.mockResolvedValue({ id: ID, community_id: COMMUNITY, state: "discussion", proposer: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.end.mockResolvedValue("withdrawn");
});

describe("POST /api/proposals/[id]/withdraw", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown proposal", async () => {
    mocks.load.mockRejectedValue(new NotFoundError("Proposal not found"));
    expect((await post({}, "not-a-uuid")).status).toBe(404);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("requires a member of the proposal's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a member of this community"));
    expect((await post()).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("withdraws as the session wallet, with no reason, whatever the body says", async () => {
    const res = await post({ "content-type": "application/json" }, ID, { reason: "changed my mind", actor: "addr_test1other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "withdrawn", executionState: "not_applicable" });
    expect(mocks.end).toHaveBeenCalledWith(ID, WALLET, "withdrawn", null);
  });

  it("maps the RPC's refusal (not the proposer, or voting already open)", async () => {
    mocks.end.mockRejectedValue(new ForbiddenError("Only the proposer can withdraw"));
    expect((await post()).status).toBe(403);
  });
});

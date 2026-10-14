import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), member: vi.fn(), load: vi.fn(), advance: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/governance", () => ({ loadProposal: mocks.load }));
vi.mock("@/lib/governance/advance", () => ({ advanceProposal: mocks.advance }));

import { POST } from "./route";

const WALLET = "addr_test1member";
const ID = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const post = (headers: Record<string, string> = {}, id = ID) =>
  POST(new Request(`http://localhost/api/proposals/${id}/advance`, { method: "POST", headers }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.load.mockResolvedValue({ id: ID, community_id: COMMUNITY, state: "discussion", execution_state: "not_applicable" });
  mocks.member.mockResolvedValue("member");
  mocks.advance.mockResolvedValue({ id: ID, community_id: COMMUNITY, state: "voting", execution_state: "not_applicable" });
});

describe("POST /api/proposals/[id]/advance", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown proposal", async () => {
    mocks.load.mockRejectedValue(new NotFoundError("Proposal not found"));
    expect((await post({}, "not-a-uuid")).status).toBe(404);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("requires a member of the proposal's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a member of this community"));
    expect((await post()).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it("takes the due step and returns the state the proposal ended in", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "voting", executionState: "not_applicable" });
    expect(mocks.advance).toHaveBeenCalledWith(ID);
  });
});

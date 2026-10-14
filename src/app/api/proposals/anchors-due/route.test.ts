import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), member: vi.fn(), due: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/governance/anchorsDue", () => ({ loadDueAnchors: mocks.due }));

import { GET } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const P1 = "50000000-0000-4000-8000-000000000001";
const P2 = "50000000-0000-4000-8000-000000000002";
const get = (query = `?communityId=${COMMUNITY}`) =>
  GET(new Request(`http://localhost/api/proposals/anchors-due${query}`), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1member" });
  mocks.member.mockResolvedValue("member");
  mocks.due.mockResolvedValue([
    { proposalId: P1, number: 3, step: "proposed", entry: [3, "proposed", "a".repeat(64), "b".repeat(64)] },
    { proposalId: P1, number: 3, step: "opened", entry: [3, "opened", "c".repeat(64)] },
    { proposalId: P2, number: 5, step: "closed", entry: [5, "closed", "withdrawn"] },
  ]);
});

describe("GET /api/proposals/anchors-due", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.due).not.toHaveBeenCalled();
  });

  it("validates the community id", async () => {
    expect((await get("?communityId=nope")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("requires membership of that community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await get()).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, "addr_test1member");
    expect(mocks.due).not.toHaveBeenCalled();
  });

  it("groups the due steps per proposal, in the loader's order", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      due: [
        { proposalId: P1, number: 3, steps: ["proposed", "opened"] },
        { proposalId: P2, number: 5, steps: ["closed"] },
      ],
    });
    expect(mocks.due).toHaveBeenCalledWith(COMMUNITY);
  });

  it("answers an empty list when nothing is due", async () => {
    mocks.due.mockResolvedValue([]);
    expect(await (await get()).json()).toEqual({ due: [] });
  });
});

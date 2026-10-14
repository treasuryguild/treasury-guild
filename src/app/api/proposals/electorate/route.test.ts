import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), member: vi.fn(), settings: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/governance", () => ({ loadGovernanceSettings: mocks.settings, countElectorate: mocks.count }));

import { DEFAULT_SETTINGS, rulesFor } from "@/lib/governance/rules";
import { GET } from "./route";

const WALLET = "addr_test1member";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WG_A = "20000000-0000-4000-8000-000000000001";
const WG_B = "20000000-0000-4000-8000-000000000002";
const SETTINGS = { ...DEFAULT_SETTINGS.task, enabled: true, activityMonths: 6, minMemberDays: 30 };
const context = { params: Promise.resolve({}) };
const get = (query: Record<string, string>) =>
  GET(new Request(`http://localhost/api/proposals/electorate?${new URLSearchParams(query)}`), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.settings.mockResolvedValue(SETTINGS);
  mocks.count.mockResolvedValue(12);
});

describe("GET /api/proposals/electorate", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get({ communityId: COMMUNITY, kind: "task" })).status).toBe(401);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("refuses an invalid query before any lookup", async () => {
    expect((await get({})).status).toBe(400);
    expect((await get({ communityId: "nope", kind: "task" })).status).toBe(400);
    expect((await get({ communityId: COMMUNITY, kind: "coup" })).status).toBe(400);
    expect((await get({ communityId: COMMUNITY, kind: "task", workgroupIds: `${WG_A},not-a-uuid` })).status).toBe(400);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("refuses a wallet that is not a member of the community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a member of this community"));
    expect((await get({ communityId: COMMUNITY, kind: "task" })).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("counts the electorate under the kind's saved rules for the named workgroups", async () => {
    const res = await get({ communityId: COMMUNITY, kind: "task", workgroupIds: `${WG_A},${WG_B}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 12 });
    expect(mocks.settings).toHaveBeenCalledWith(COMMUNITY, "task");
    expect(mocks.count).toHaveBeenCalledWith(COMMUNITY, rulesFor(SETTINGS), [WG_A, WG_B]);
  });

  it("reads no workgroupIds as none", async () => {
    await get({ communityId: COMMUNITY, kind: "decision" });
    expect(mocks.settings).toHaveBeenCalledWith(COMMUNITY, "decision");
    expect(mocks.count).toHaveBeenCalledWith(COMMUNITY, expect.anything(), []);
  });
});

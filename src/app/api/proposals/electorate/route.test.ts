import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), member: vi.fn(), settings: vi.fn(), wallets: vi.fn(), leads: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/governance", () => ({
  loadGovernanceSettings: mocks.settings, electorateWallets: mocks.wallets, workgroupLeadWallets: mocks.leads,
}));

import { DEFAULT_SETTINGS, rulesFor } from "@/lib/governance/rules";
import { GET } from "./route";

const WALLET = "addr_test1member";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WG_A = "20000000-0000-4000-8000-000000000001";
const WG_B = "20000000-0000-4000-8000-000000000002";
const SETTINGS = { ...DEFAULT_SETTINGS.task, enabled: true, activityMonths: 6, minMemberDays: 30 };
const WALLETS = Array.from({ length: 12 }, (_, i) => `addr_${i}`);
const context = { params: Promise.resolve({}) };
const get = (query: Record<string, string>) =>
  GET(new Request(`http://localhost/api/proposals/electorate?${new URLSearchParams(query)}`), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.settings.mockResolvedValue(SETTINGS);
  mocks.wallets.mockResolvedValue(WALLETS);
  mocks.leads.mockResolvedValue([]);
});

describe("GET /api/proposals/electorate", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get({ communityId: COMMUNITY, kind: "task" })).status).toBe(401);
    expect(mocks.wallets).not.toHaveBeenCalled();
  });

  it("refuses an invalid query before any lookup", async () => {
    expect((await get({})).status).toBe(400);
    expect((await get({ communityId: "nope", kind: "task" })).status).toBe(400);
    expect((await get({ communityId: COMMUNITY, kind: "coup" })).status).toBe(400);
    expect((await get({ communityId: COMMUNITY, kind: "task", workgroupIds: `${WG_A},not-a-uuid` })).status).toBe(400);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.wallets).not.toHaveBeenCalled();
  });

  it("refuses a wallet that is not a member of the community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a member of this community"));
    expect((await get({ communityId: COMMUNITY, kind: "task" })).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.wallets).not.toHaveBeenCalled();
  });

  it("counts the electorate under the kind's saved rules for the named workgroups", async () => {
    const res = await get({ communityId: COMMUNITY, kind: "task", workgroupIds: `${WG_A},${WG_B}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 12, eligible: 12 });
    expect(mocks.settings).toHaveBeenCalledWith(COMMUNITY, "task");
    expect(mocks.wallets).toHaveBeenCalledWith(COMMUNITY, rulesFor(SETTINGS), [WG_A, WG_B]);
    expect(mocks.leads).not.toHaveBeenCalled();
  });

  it("reads no workgroupIds as none", async () => {
    await get({ communityId: COMMUNITY, kind: "decision" });
    expect(mocks.settings).toHaveBeenCalledWith(COMMUNITY, "decision");
    expect(mocks.wallets).toHaveBeenCalledWith(COMMUNITY, expect.anything(), []);
  });

  it("counts the electorate the form is editing instead of the saved one", async () => {
    const res = await get({
      communityId: COMMUNITY, kind: "task", electorate: "admins", activityMonths: "3", minMemberDays: "10",
    });
    expect(res.status).toBe(200);
    expect(mocks.wallets).toHaveBeenCalledWith(
      COMMUNITY,
      { ...rulesFor(SETTINGS), electorate: "admins", activityMonths: 3, minMemberDays: 10 },
      [],
    );
  });

  it("refuses an electorate outside the settings bounds", async () => {
    expect((await get({ communityId: COMMUNITY, kind: "task", activityMonths: "0" })).status).toBe(400);
    expect((await get({ communityId: COMMUNITY, kind: "task", minMemberDays: "366" })).status).toBe(400);
    expect((await get({ communityId: COMMUNITY, kind: "task", electorate: "everyone" })).status).toBe(400);
    expect(mocks.wallets).not.toHaveBeenCalled();
  });

  it("subtracts the beneficiaries a form names when recusal is on", async () => {
    const res = await get({
      communityId: COMMUNITY, kind: "task", recuseBeneficiaries: "true", beneficiaries: "addr_0,stranger",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 12, eligible: 11 });
    expect(mocks.wallets).toHaveBeenCalledWith(
      COMMUNITY, { ...rulesFor(SETTINGS), recuseBeneficiaries: true }, [],
    );
    expect(mocks.leads).not.toHaveBeenCalled();
  });

  it("keeps those beneficiaries when recusal is off, including over a saved recusal", async () => {
    mocks.settings.mockResolvedValue({ ...SETTINGS, recuseBeneficiaries: true });
    const res = await get({
      communityId: COMMUNITY, kind: "task", recuseBeneficiaries: "false", beneficiaries: "addr_0",
    });
    expect(await res.json()).toEqual({ count: 12, eligible: 12 });
    expect(mocks.wallets).toHaveBeenCalledWith(
      COMMUNITY, expect.objectContaining({ recuseBeneficiaries: false }), [],
    );
  });

  it("uses the saved recusal when the form does not name one", async () => {
    mocks.settings.mockResolvedValue({ ...SETTINGS, recuseBeneficiaries: true });
    const res = await get({ communityId: COMMUNITY, kind: "task", beneficiaries: "addr_0" });
    expect(await res.json()).toEqual({ count: 12, eligible: 11 });
  });

  it("recuses a budget's workgroup leads and ignores a beneficiary list", async () => {
    mocks.leads.mockResolvedValue(["addr_0", "addr_1"]);
    const res = await get({
      communityId: COMMUNITY, kind: "budget", workgroupIds: WG_A,
      recuseBeneficiaries: "true", beneficiaries: WALLETS.join(","),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 12, eligible: 10 });
    expect(mocks.leads).toHaveBeenCalledWith([WG_A]);
  });

  it("does not look up leads for a budget whose recusal is off", async () => {
    await get({ communityId: COMMUNITY, kind: "budget", workgroupIds: WG_A, recuseBeneficiaries: "false" });
    expect(mocks.leads).not.toHaveBeenCalled();
  });
});

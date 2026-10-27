import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  community: vi.fn(),
  setPrimary: vi.fn(),
  loadTreasury: vi.fn(),
  baseSigners: vi.fn(),
  addMember: vi.fn(),
  promote: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/communities", () => ({
  requireCommunity: mocks.community,
  setPrimaryTreasury: mocks.setPrimary,
}));
vi.mock("@/lib/db/treasuries", () => ({
  loadTreasury: mocks.loadTreasury,
  loadBaseSignerWallets: mocks.baseSigners,
}));
vi.mock("@/lib/db/membership", () => ({
  addMember: mocks.addMember,
  promoteMembersToAdmin: mocks.promote,
}));

import { POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const TREASURY = "20000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.community.mockResolvedValue({ id: COMMUNITY, primary_treasury_id: TREASURY });
  mocks.loadTreasury.mockResolvedValue({ id: OTHER, community_id: COMMUNITY });
  mocks.baseSigners.mockResolvedValue(["addr_a", "addr_b"]);
});

describe("POST /api/treasury/primary", () => {
  it("re-points primary and promotes the new base signers", async () => {
    const response = await POST(
      new Request("http://localhost/api/treasury/primary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ communityId: COMMUNITY, treasuryId: OTHER }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(200);
    expect(mocks.setPrimary).toHaveBeenCalledWith(COMMUNITY, OTHER);
    expect(mocks.addMember).toHaveBeenCalledTimes(2);
    expect(mocks.promote).toHaveBeenCalledWith(COMMUNITY, ["addr_a", "addr_b"]);
  });

  it("is a no-op when the treasury is already primary", async () => {
    mocks.loadTreasury.mockResolvedValue({ id: TREASURY, community_id: COMMUNITY });
    const response = await POST(
      new Request("http://localhost/api/treasury/primary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ communityId: COMMUNITY, treasuryId: TREASURY }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(200);
    expect(mocks.setPrimary).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("refuses a treasury of another community", async () => {
    mocks.loadTreasury.mockResolvedValue({ id: OTHER, community_id: "other" });
    const response = await POST(
      new Request("http://localhost/api/treasury/primary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ communityId: COMMUNITY, treasuryId: OTHER }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(400);
    expect(mocks.setPrimary).not.toHaveBeenCalled();
  });
});

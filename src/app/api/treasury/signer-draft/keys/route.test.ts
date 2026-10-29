import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  rate: vi.fn(),
  get: vi.fn(),
  contribute: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/db/signerDrafts", () => ({
  getSignerDraft: mocks.get,
  contributeSignerDraftById: mocks.contribute,
}));

import { POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const DRAFT = "30000000-0000-4000-8000-000000000001";
const WALLET = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const STAKE = "stake_test1uz42424242424242424242424242424242424242424242s7f0kdw";
const view = {
  id: DRAFT,
  communityId: COMMUNITY,
  name: "Main",
  required: 1,
  workgroupId: null,
  expiresAt: "2026-11-05T00:00:00.000Z",
  signers: [{ address: WALLET, name: null, stakeReceived: true, drepReceived: true }],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue({ ...view, signers: [{ ...view.signers[0], stakeReceived: false, drepReceived: false }] });
  mocks.contribute.mockResolvedValue(view);
});

describe("POST /api/treasury/signer-draft/keys", () => {
  it("writes the admin's own keys and returns the updated draft", async () => {
    const res = await POST(new Request("http://localhost/api/treasury/signer-draft/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId: DRAFT, stakeAddress: STAKE, drepKeyHash: "a".repeat(56) }),
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.contribute).toHaveBeenCalledWith(DRAFT, WALLET, STAKE, "a".repeat(56));
    expect(await res.json()).toEqual({ draft: view });
  });
});

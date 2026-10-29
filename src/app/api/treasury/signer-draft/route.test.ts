import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  rate: vi.fn(),
  community: vi.fn(),
  workgroupCommunity: vi.fn(),
  requireActive: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/workgroups", () => ({
  workgroupCommunityId: mocks.workgroupCommunity,
  requireActiveWorkgroup: mocks.requireActive,
}));
vi.mock("@/lib/db/signerDrafts", () => ({
  createSignerDraft: mocks.create,
  listOpenSignerDrafts: mocks.list,
  getSignerDraft: mocks.get,
  saveSignerDraft: mocks.save,
  deleteSignerDraft: mocks.remove,
}));
vi.mock("@/lib/env.server", () => ({ appUrl: () => "https://app.test" }));

import { DELETE, GET, PATCH, POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const DRAFT = "30000000-0000-4000-8000-000000000001";
const WALLET = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const OTHER = "addr_test1vzamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwc48zzn4";
const STAKE = "stake_test1uz42424242424242424242424242424242424242424242s7f0kdw";
const STAKE_OTHER = "stake_test1uzamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwc40u6yl";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const context = { params: Promise.resolve({}) };

const view = {
  id: DRAFT,
  communityId: COMMUNITY,
  name: "Main",
  required: 1,
  workgroupId: null,
  expiresAt: "2026-11-05T00:00:00.000Z",
  signers: [
    { address: WALLET, name: null, stakeReceived: true, drepReceived: false },
    { address: OTHER, name: "Bob", stakeReceived: false, drepReceived: false },
  ],
};

const post = (body: object) =>
  POST(new Request("http://localhost/api/treasury/signer-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  mocks.community.mockResolvedValue({ id: COMMUNITY, network: 0 });
  mocks.create.mockResolvedValue({ draft: view, token: TOKEN });
  mocks.list.mockResolvedValue([view]);
  mocks.get.mockResolvedValue(view);
  mocks.save.mockResolvedValue(view);
  mocks.remove.mockResolvedValue(undefined);
});

describe("SDK signer draft API", () => {
  it("keeps stake and DRep keys only for the signed-in signer", async () => {
    const res = await post({
      communityId: COMMUNITY,
      name: "Main",
      required: 1,
      signers: [
        { address: WALLET, stakeAddress: STAKE, drepKeyHash: "a".repeat(56) },
        { address: OTHER, name: "Bob", stakeAddress: STAKE_OTHER, drepKeyHash: "b".repeat(56) },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      draft: { id: DRAFT },
      url: `https://app.test/invite/signer/${TOKEN}`,
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: WALLET,
      network: 0,
      signers: [
        { address: WALLET, name: undefined, stakeAddress: STAKE, drepKeyHash: "a".repeat(56) },
        { address: OTHER, name: "Bob" },
      ],
    }));
    expect(mocks.rate).toHaveBeenCalledWith("signerDraftCreate", WALLET);
  });

  it("lists open drafts for an admin", async () => {
    const res = await GET(new Request(`http://localhost/api/treasury/signer-draft?communityId=${COMMUNITY}`), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drafts: [view] });
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
  });

  it("discards a draft only after the admin check", async () => {
    const res = await DELETE(new Request("http://localhost/api/treasury/signer-draft", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId: DRAFT }),
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.remove).toHaveBeenCalledWith(DRAFT);
  });

  it("updates the list and forwards only the admin's own keys", async () => {
    const res = await PATCH(new Request("http://localhost/api/treasury/signer-draft", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftId: DRAFT,
        communityId: COMMUNITY,
        name: "Main",
        required: 1,
        signers: [
          { address: WALLET, stakeAddress: STAKE },
          { address: OTHER, stakeAddress: STAKE_OTHER },
        ],
      }),
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      actor: WALLET,
      signers: [
        { address: WALLET, name: undefined, stakeAddress: STAKE, drepKeyHash: undefined },
        { address: OTHER, name: undefined },
      ],
    }));
  });
});

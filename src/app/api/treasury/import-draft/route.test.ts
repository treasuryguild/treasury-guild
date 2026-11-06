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
  decode: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/workgroups", () => ({
  workgroupCommunityId: mocks.workgroupCommunity,
  requireActiveWorkgroup: mocks.requireActive,
}));
vi.mock("@/lib/db/importDrafts", () => ({
  createImportDraft: mocks.create,
  listOpenImportDrafts: mocks.list,
  getImportDraft: mocks.get,
  saveImportDraft: mocks.save,
  deleteImportDraft: mocks.remove,
}));
vi.mock("@/lib/cardano/treasuryImport", () => ({ decodeTreasuryCbor: mocks.decode }));
vi.mock("@/lib/env.server", () => ({ appUrl: () => "https://app.test" }));

import { DELETE, GET, POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const DRAFT = "30000000-0000-4000-8000-000000000002";
const WALLET = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const HASH_A = "a".repeat(56);
const HASH_B = "b".repeat(56);
const context = { params: Promise.resolve({}) };

const view = {
  id: DRAFT,
  communityId: COMMUNITY,
  name: "Imported",
  workgroupId: null,
  expiresAt: "2026-11-13T00:00:00.000Z",
  scriptCbor: "820182",
  stakeCredentialHash: null,
  filled: 1,
  total: 2,
  signers: [
    { keyHash: HASH_A, group: "base" as const, address: WALLET, name: "Alice", claimed: true },
    { keyHash: HASH_B, group: "base" as const, address: null, name: null, claimed: false },
  ],
};

const post = (body: object) =>
  POST(new Request("http://localhost/api/treasury/import-draft", {
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
  mocks.decode.mockReturnValue({
    scriptCbor: "820182",
    shape: {
      template: "plain",
      base: { keyHashes: [HASH_A, HASH_B], scriptType: "all", required: 2 },
      recovery: null,
      cosignerKeyHash: null,
      lockSlot: null,
    },
  });
  mocks.create.mockResolvedValue({ draft: view, token: TOKEN });
  mocks.list.mockResolvedValue([view]);
  mocks.get.mockResolvedValue(view);
  mocks.remove.mockResolvedValue(undefined);
});

describe("import draft API", () => {
  it("creates a draft from CBOR and returns the invite URL", async () => {
    const res = await post({
      communityId: COMMUNITY,
      name: "Imported",
      source: { type: "cbor", cbor: "820182" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      draft: { id: DRAFT },
      url: `https://app.test/invite/import/${TOKEN}`,
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: WALLET,
      scriptCbor: "820182",
      signers: [
        { keyHash: HASH_A, group: "base", name: "" },
        { keyHash: HASH_B, group: "base", name: "" },
      ],
    }));
    expect(mocks.rate).toHaveBeenCalledWith("importDraftCreate", WALLET);
  });

  it("lists open drafts for an admin", async () => {
    const res = await GET(
      new Request(`http://localhost/api/treasury/import-draft?communityId=${COMMUNITY}`),
      context,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drafts: [view] });
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
  });

  it("discards a draft only after the admin check", async () => {
    const res = await DELETE(new Request("http://localhost/api/treasury/import-draft", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId: DRAFT }),
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.remove).toHaveBeenCalledWith(DRAFT);
  });
});

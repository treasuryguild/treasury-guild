import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  rate: vi.fn(),
  community: vi.fn(),
  match: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/importDrafts", () => ({ adminMatchImportSlots: mocks.match }));

import { POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const DRAFT = "30000000-0000-4000-8000-000000000002";
const WALLET = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const OTHER = "addr_test1qzother000000000000000000000000000000000000000000000000000000000000000000000000000000000000000s";
const context = { params: Promise.resolve({}) };

const draft = {
  id: DRAFT,
  communityId: COMMUNITY,
  name: "Imported",
  workgroupId: null,
  expiresAt: "2026-11-13T00:00:00.000Z",
  scriptCbor: "820182",
  stakeCredentialHash: null,
  filled: 2,
  total: 2,
  signers: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  mocks.community.mockResolvedValue({ id: COMMUNITY, network: 0 });
  mocks.match.mockResolvedValue(draft);
});

describe("import draft slot API", () => {
  it("matches pasted addresses without requiring key hashes", async () => {
    const res = await POST(
      new Request("http://localhost/api/treasury/import-draft/slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftId: DRAFT,
          communityId: COMMUNITY,
          addresses: [OTHER],
        }),
      }),
      context,
    );
    expect(res.status).toBe(200);
    expect(mocks.match).toHaveBeenCalledWith({
      draftId: DRAFT,
      communityId: COMMUNITY,
      addresses: [OTHER],
      network: 0,
    });
    expect(await res.json()).toEqual({ draft });
  });

  it("refuses an empty address list", async () => {
    const res = await POST(
      new Request("http://localhost/api/treasury/import-draft/slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftId: DRAFT,
          communityId: COMMUNITY,
          addresses: [],
        }),
      }),
      context,
    );
    expect(res.status).toBe(400);
    expect(mocks.match).not.toHaveBeenCalled();
  });
});

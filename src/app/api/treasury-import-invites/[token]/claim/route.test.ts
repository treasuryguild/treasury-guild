import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  rate: vi.fn(),
  claim: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/db/importDrafts", () => ({ claimImportDraft: mocks.claim }));

import { POST } from "./route";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const WALLET = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const context = { params: Promise.resolve({ token: TOKEN }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.rate.mockResolvedValue(undefined);
  mocks.claim.mockResolvedValue(undefined);
});

describe("POST /api/treasury-import-invites/[token]/claim", () => {
  it("claims with the session wallet", async () => {
    const res = await POST(new Request(`http://localhost/api/treasury-import-invites/${TOKEN}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.rate).toHaveBeenCalledWith("importDraftClaim", WALLET);
    expect(mocks.claim).toHaveBeenCalledWith(TOKEN, WALLET, null);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  rate: vi.fn(),
  contribute: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/db/signerDrafts", () => ({ contributeSignerDraft: mocks.contribute }));

import { POST } from "./route";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const WALLET = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const STAKE = "stake_test1uz42424242424242424242424242424242424242424242s7f0kdw";

const post = (body: object) =>
  POST(new Request(`http://localhost/api/treasury-signer-invites/${TOKEN}/contribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ token: TOKEN }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.rate.mockResolvedValue(undefined);
  mocks.contribute.mockResolvedValue(undefined);
});

describe("POST /api/treasury-signer-invites/[token]/contribute", () => {
  it("binds the keys to the session wallet", async () => {
    const res = await post({ stakeAddress: STAKE, drepKeyHash: "a".repeat(56) });
    expect(res.status).toBe(200);
    expect(mocks.contribute).toHaveBeenCalledWith(TOKEN, WALLET, STAKE, "a".repeat(56));
    expect(mocks.rate).toHaveBeenCalledWith("signerDraftContribute", WALLET);
  });

  it("tells a connected wallet when it is not on the list", async () => {
    mocks.contribute.mockRejectedValue(new BadRequestError("This wallet is not a listed signer"));
    const res = await post({ stakeAddress: STAKE });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "This wallet is not a listed signer" });
  });
});

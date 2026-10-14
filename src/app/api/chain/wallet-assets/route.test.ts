import { serializeAddress } from "@meshsdk/core-cst";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "@/lib/config";
import { TooManyRequestsError, UnauthorizedError, UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), limit: vi.fn(), wallet: vi.fn(), hints: vi.fn(), appNetwork: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.wallet }));
vi.mock("@/lib/db/assets", () => ({ loadMintAssetHints: mocks.hints }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  appNetwork: mocks.appNetwork,
}));
import { GET } from "./route";

const WALLET = "addr_test1member";
const PREPROD = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";
const MAINNET = serializeAddress({ pubKeyHash: "a".repeat(56) }, 1);
const unit = (policy: string, name: string) => `${policy.repeat(56)}${Buffer.from(name).toString("hex")}`;
const REGISTRY = unit("a", "GVTT");
const ASCII = unit("b", "Badge");
const BARE = unit("c", "Raw");
const MINTED = unit("d", "Own");
const get = (query: string) => GET(new Request(`http://localhost/api/chain/wallet-assets${query}`), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.limit.mockResolvedValue(undefined);
  mocks.wallet.mockResolvedValue({ lovelace: 12_345_678_901_234_567_890n, utxoCount: 3, tokens: [
    { unit: REGISTRY, quantity: 1_000_000n, ticker: "GVTT", name: "Test Token", decimals: 6, source: "registry" },
    { unit: ASCII, quantity: 2n, ticker: "Badge", name: "Badge", decimals: 0, source: "ascii" },
    { unit: BARE, quantity: 7n, ticker: null, name: null, decimals: 0, source: "none" },
    { unit: MINTED, quantity: 500n, ticker: "OWN", name: "Own", decimals: 2, source: "mint" },
  ] });
  mocks.hints.mockResolvedValue(new Map());
});

describe("GET /api/chain/wallet-assets", () => {
  it("returns the wallet's balances as exact strings, asking mint hints only for tokens Koios could not name", async () => {
    mocks.hints.mockResolvedValue(new Map([
      [ASCII, { ticker: "BDG", name: "Guild Badge", decimals: 0 }],
      [BARE, { ticker: null, name: null, decimals: 4 }],
    ]));
    const res = await get(`?address=${PREPROD}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lovelace: "12345678901234567890", utxoCount: 3,
      tokens: [
        { unit: REGISTRY, quantity: "1000000", ticker: "GVTT", name: "Test Token", decimals: 6, source: "registry" },
        { unit: ASCII, quantity: "2", ticker: "BDG", name: "Guild Badge", decimals: 0, source: "mint" },
        { unit: BARE, quantity: "7", ticker: null, name: null, decimals: 0, source: "none" },
        { unit: MINTED, quantity: "500", ticker: "OWN", name: "Own", decimals: 2, source: "mint" },
      ],
    });
    expect(mocks.wallet).toHaveBeenCalledExactlyOnceWith(0, PREPROD);
    expect(mocks.hints).toHaveBeenCalledExactlyOnceWith([ASCII, BARE]);
  });

  it("takes the network from the address prefix, never from the deployment default", async () => {
    mocks.appNetwork.mockReturnValue(0);
    expect((await get(`?address=${MAINNET}`)).status).toBe(200);
    expect(mocks.wallet).toHaveBeenLastCalledWith(1, MAINNET);
    mocks.appNetwork.mockReturnValue(1);
    expect((await get(`?address=${PREPROD}`)).status).toBe(200);
    expect(mocks.wallet).toHaveBeenLastCalledWith(0, PREPROD);
    expect(mocks.appNetwork).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get(`?address=${PREPROD}`)).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
  });

  it("refuses a missing or malformed address without charging the limit", async () => {
    for (const query of ["", "?address=", "?address=not-an-address", `?address=${PREPROD}x`]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
  });

  it("charges the chain-proxy rate limit per wallet before asking Koios", async () => {
    mocks.limit.mockRejectedValue(new TooManyRequestsError());
    expect((await get(`?address=${PREPROD}`)).status).toBe(429);
    expect(mocks.limit).toHaveBeenCalledWith("chainProxy", WALLET);
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.hints).not.toHaveBeenCalled();
  });

  it("answers 502 when Koios fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.wallet.mockRejectedValue(new UpstreamError("Koios 503"));
    const res = await get(`?address=${PREPROD}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Koios 503" });
    expect(mocks.hints).not.toHaveBeenCalled();
  });
});

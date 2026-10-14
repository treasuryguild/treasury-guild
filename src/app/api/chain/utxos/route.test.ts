import { serializeAddress } from "@meshsdk/core-cst";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "@/lib/config";
import { TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), limit: vi.fn(), provider: vi.fn(), utxos: vi.fn(), appNetwork: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  appNetwork: mocks.appNetwork,
}));
import { GET } from "./route";

const WALLET = "addr_test1member";
const PREPROD = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";
const MAINNET = serializeAddress({ pubKeyHash: "a".repeat(56) }, 1);
const UTXOS = [{
  input: { txHash: "f".repeat(64), outputIndex: 0 },
  output: { address: PREPROD, amount: [{ unit: "lovelace", quantity: "5000000" }] },
}];
const get = (query: string) => GET(new Request(`http://localhost/api/chain/utxos${query}`), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.limit.mockResolvedValue(undefined);
  mocks.provider.mockReturnValue({ fetchAddressUTxOs: mocks.utxos });
  mocks.utxos.mockResolvedValue(UTXOS);
});

describe("GET /api/chain/utxos", () => {
  it("returns the address's UTxOs from the provider of the address's own network", async () => {
    const res = await get(`?address=${PREPROD}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ utxos: UTXOS });
    expect(mocks.limit).toHaveBeenCalledWith("chainProxy", WALLET);
    expect(mocks.provider).toHaveBeenCalledExactlyOnceWith(0);
    expect(mocks.utxos).toHaveBeenCalledExactlyOnceWith(PREPROD);
  });

  it("takes the network from the address prefix, never from the deployment default", async () => {
    mocks.appNetwork.mockReturnValue(0);
    expect((await get(`?address=${MAINNET}`)).status).toBe(200);
    expect(mocks.provider).toHaveBeenLastCalledWith(1);
    expect(mocks.utxos).toHaveBeenLastCalledWith(MAINNET);
    expect(mocks.appNetwork).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get(`?address=${PREPROD}`)).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("refuses a missing or malformed address without charging the limit", async () => {
    for (const query of ["", "?address=", "?address=not-an-address", `?address=${PREPROD}x`]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("charges the chain-proxy rate limit per wallet before asking Koios", async () => {
    mocks.limit.mockRejectedValue(new TooManyRequestsError());
    expect((await get(`?address=${PREPROD}`)).status).toBe(429);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.utxos).not.toHaveBeenCalled();
  });
});

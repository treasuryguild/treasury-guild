import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), limit: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/cardano/koios", () => ({ txInfoBulk: mocks.info }));
import { GET } from "./route";

const WALLET = "addr_test1member";
const HASH = "a".repeat(64);
const get = (query = `?hash=${HASH}&network=0`) =>
  GET(new Request(`http://localhost/api/chain/tx-status${query}`), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.limit.mockResolvedValue(undefined);
  mocks.info.mockResolvedValue([{ tx_hash: HASH, block_height: 4_200_000 }]);
});

describe("GET /api/chain/tx-status", () => {
  it("reports a transaction Koios knows with its block height, on the network the caller names", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ onChain: true, blockHeight: 4_200_000 });
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith(0, [HASH]);
    await get(`?hash=${HASH}&network=1`);
    expect(mocks.info).toHaveBeenLastCalledWith(1, [HASH]);
  });

  it("answers not on-chain for a hash Koios has not seen, and a null height while it has none", async () => {
    mocks.info.mockResolvedValue([]);
    expect(await (await get()).json()).toEqual({ onChain: false, blockHeight: null });
    mocks.info.mockResolvedValue([{ tx_hash: HASH, block_height: null }]);
    expect(await (await get()).json()).toEqual({ onChain: true, blockHeight: null });
  });

  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("validates the hash and the network without charging the limit", async () => {
    for (const query of ["", "?hash=nope&network=0", `?hash=${HASH}`, `?hash=${HASH}&network=2`, `?hash=${HASH}&network=preprod`, `?hash=${HASH}0&network=0`]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("charges the chain-proxy rate limit per wallet before asking Koios", async () => {
    mocks.limit.mockRejectedValue(new TooManyRequestsError());
    expect((await get()).status).toBe(429);
    expect(mocks.limit).toHaveBeenCalledWith("chainProxy", WALLET);
    expect(mocks.info).not.toHaveBeenCalled();
  });
});

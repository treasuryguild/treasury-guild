import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), limit: vi.fn(), info: vi.fn(), cbor: vi.fn(), hash: vi.fn(), extract: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/cardano/koios", () => ({ txInfoBulk: mocks.info, txCborBulk: mocks.cbor }));
vi.mock("@meshsdk/core-cst", () => ({ resolveTxHash: mocks.hash }));
vi.mock("@/lib/cardano/cborMetadata", () => ({ extractAnchorMetadata: mocks.extract }));

import { GET } from "./route";

const HASH = "a".repeat(64);
const CBOR = "84a0";
const record = { v: 1, src: "treasury-guild", c: "signius", a: [[3, "proposed", "b".repeat(64), "c".repeat(64)]] };
const get = (query = `?hash=${HASH}&network=0`) =>
  GET(new Request(`http://localhost/api/chain/tx-metadata${query}`), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1member" });
  mocks.limit.mockResolvedValue(undefined);
  mocks.info.mockResolvedValue([{ tx_hash: HASH, block_height: 10, tx_timestamp: 1_800_000_000, inputs: [], outputs: [] }]);
  mocks.cbor.mockResolvedValue(new Map([[HASH, CBOR]]));
  mocks.hash.mockReturnValue(HASH);
  mocks.extract.mockReturnValue(record);
});

describe("GET /api/chain/tx-metadata", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("validates the hash and the network", async () => {
    expect((await get("?hash=nope&network=0")).status).toBe(400);
    expect((await get(`?hash=${HASH}&network=2`)).status).toBe(400);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("charges the chain-proxy rate limit per wallet before asking Koios", async () => {
    mocks.limit.mockRejectedValue(new TooManyRequestsError());
    expect((await get()).status).toBe(429);
    expect(mocks.limit).toHaveBeenCalledWith("chainProxy", "addr_test1member");
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("decodes the anchor record from the CBOR once its hash matches", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ onChain: true, blockTime: "2027-01-15T08:00:00.000Z", anchor: record });
    expect(mocks.info).toHaveBeenCalledWith(0, [HASH]);
    expect(mocks.cbor).toHaveBeenCalledWith(0, [HASH]);
    expect(mocks.hash).toHaveBeenCalledWith(CBOR);
    expect(mocks.extract).toHaveBeenCalledWith(CBOR);
  });

  it("answers no record when the CBOR does not hash to the id", async () => {
    mocks.hash.mockReturnValue("b".repeat(64));
    expect(await (await get()).json()).toEqual({ onChain: true, blockTime: "2027-01-15T08:00:00.000Z", anchor: null });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("answers not on-chain when Koios knows nothing yet", async () => {
    mocks.info.mockResolvedValue([]);
    mocks.cbor.mockResolvedValue(new Map());
    expect(await (await get()).json()).toEqual({ onChain: false, blockTime: null, anchor: null });
  });

  it("answers null for a transaction that carries no label 190002", async () => {
    mocks.extract.mockReturnValue(undefined);
    expect((await (await get()).json()).anchor).toBeNull();
  });
});

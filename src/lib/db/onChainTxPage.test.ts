import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TX_VIEW } from "@/lib/cardano/types";
import { StakeAction, TxKind } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  serverClient: vi.fn(),
  serviceFrom: vi.fn(),
  txCborBulk: vi.fn(),
  resolveTxHash: vi.fn(),
  decodeTxForDisplay: vi.fn(),
  lookupStakePool: vi.fn(),
  lookupDrep: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ serverClient: mocks.serverClient }));
vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({ from: mocks.serviceFrom }),
}));
vi.mock("@meshsdk/core-cst", () => ({ resolveTxHash: mocks.resolveTxHash }));
vi.mock("@/lib/cardano/koios", () => ({
  txCborBulk: mocks.txCborBulk,
  lookupStakePool: mocks.lookupStakePool,
  lookupDrep: mocks.lookupDrep,
}));
vi.mock("@/lib/cardano/cborMetadata", () => ({
  decodeTxForDisplay: mocks.decodeTxForDisplay,
}));

import { loadOnChainTxPageData } from "./onChainTxPage";

const HASH = "ab".repeat(32);
const SLUG = "signius";
const CBOR = "84a0";

const EXTERNAL_ROW = {
  tx_hash: HASH,
  treasury_id: "t-1",
  block_height: 10,
  block_time: "2026-10-31T08:00:00.000Z",
  fee_lovelace: "200000",
  amount_lovelace: "0",
  assets: null,
  to_addresses: [],
  payout_meta: null,
  activity: {
    kind: TxKind.Stake,
    action: StakeAction.VoteDelegation,
    dRepId: "drep1medusa",
  },
  tx_cbor: null as string | null,
  to_treasury_id: null,
  import_status: null,
  import_issues: [],
  governance_alerted_at: "2026-10-31T08:01:00.000Z",
  created_at: "2026-10-31T08:01:00.000Z",
};

const TREASURY_ROW = {
  id: "t-1",
  name: "Gov Treasury",
  address: "addr_test1_gov",
  network: 0,
  community_id: "c-1",
};

function single(result: { data: unknown; error: { message: string } | null }) {
  const api = {
    select: () => api,
    eq: () => api,
    in: () => api,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return api;
}

function list(result: { data: unknown; error: { message: string } | null }) {
  return {
    select: () => ({
      eq: () => ({
        in: () => Promise.resolve(result),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      }),
    }),
  };
}

function mockServiceUpdate() {
  const updates: Record<string, unknown>[] = [];
  mocks.serviceFrom.mockImplementation(() => {
    const chain = {
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return chain;
      },
      eq: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve, reject),
    };
    return chain;
  });
  return updates;
}

function mockTables(opts: {
  external?: { data: unknown; error: { message: string } | null };
  treasury?: { data: unknown; error: { message: string } | null };
  community?: { data: unknown; error: { message: string } | null };
}) {
  const from = vi.fn((table: string) => {
    if (table === "external_txs") {
      return single(
        opts.external ?? { data: { ...EXTERNAL_ROW }, error: null },
      );
    }
    if (table === "treasuries") {
      return single(opts.treasury ?? { data: TREASURY_ROW, error: null });
    }
    if (table === "communities") {
      return single(opts.community ?? { data: { slug: SLUG }, error: null });
    }
    if (table === "community_assets") {
      return list({ data: [], error: null });
    }
    if (table === "proposals") {
      return list({ data: [], error: null });
    }
    throw new Error(`unexpected table ${table}`);
  });
  mocks.serverClient.mockResolvedValue({ from });
  return from;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.lookupStakePool.mockResolvedValue(null);
  mocks.lookupDrep.mockResolvedValue({ givenName: "Medusa DRep" });
  mocks.txCborBulk.mockResolvedValue(new Map([[HASH, CBOR]]));
  mocks.resolveTxHash.mockReturnValue(HASH);
  mocks.decodeTxForDisplay.mockReturnValue({
    ...EMPTY_TX_VIEW,
    fee: "200000",
    outputs: [{ address: "addr_test1_gov", lovelace: "99800000", assets: [] }],
  });
  mockServiceUpdate();
});

describe("loadOnChainTxPageData", () => {
  it("returns null for a bad hash", async () => {
    expect(await loadOnChainTxPageData(SLUG, "nope", "addr")).toBeNull();
    expect(mocks.serverClient).not.toHaveBeenCalled();
  });

  it("returns null when the external row is missing", async () => {
    mockTables({ external: { data: null, error: null } });
    expect(await loadOnChainTxPageData(SLUG, HASH, "addr")).toBeNull();
  });

  it("returns null and logs when a select errors", async () => {
    mockTables({
      external: { data: null, error: { message: "column activity does not exist" } },
    });
    expect(await loadOnChainTxPageData(SLUG, HASH, "addr")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "on-chain tx page: load external_txs",
      "column activity does not exist",
    );
  });

  it("returns null when the community slug mismatches", async () => {
    mockTables({ community: { data: { slug: "other" }, error: null } });
    expect(await loadOnChainTxPageData(SLUG, HASH, "addr")).toBeNull();
  });

  it("fetches CBOR, enriches labels, and persists both via service role", async () => {
    const updates = mockServiceUpdate();
    const from = mockTables({});
    const data = await loadOnChainTxPageData(SLUG, HASH.toUpperCase(), "addr");
    expect(from.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["external_txs", "treasuries", "communities", "community_assets"]),
    );
    expect(data).toMatchObject({
      slug: SLUG,
      title: "Stake: vote delegation to Medusa DRep",
      cborTrusted: true,
      treasury: { name: "Gov Treasury", network: 0 },
      activity: {
        kind: TxKind.Stake,
        action: StakeAction.VoteDelegation,
        dRepName: "Medusa DRep",
      },
      governanceAction: {
        kind: "stake",
        action: StakeAction.VoteDelegation,
        dRepName: "Medusa DRep",
      },
    });
    expect(data?.decoded.fee).toBe("200000");
    expect(mocks.txCborBulk).toHaveBeenCalled();
    expect(updates).toEqual([
      { tx_cbor: CBOR, activity: expect.objectContaining({ dRepName: "Medusa DRep" }) },
    ]);
  });

  it("uses stored CBOR and skips Koios when the hash matches", async () => {
    const updates = mockServiceUpdate();
    mockTables({
      external: {
        data: {
          ...EXTERNAL_ROW,
          tx_cbor: CBOR,
          activity: {
            kind: TxKind.Stake,
            action: StakeAction.VoteDelegation,
            dRepId: "drep1medusa",
            dRepName: "Medusa DRep",
          },
        },
        error: null,
      },
    });
    mocks.lookupDrep.mockResolvedValue(null);
    const data = await loadOnChainTxPageData(SLUG, HASH, "addr");
    expect(data?.cborTrusted).toBe(true);
    expect(mocks.txCborBulk).not.toHaveBeenCalled();
    expect(mocks.decodeTxForDisplay).toHaveBeenCalledWith(CBOR);
    expect(updates).toEqual([]);
  });

  it("still returns the row when CBOR is missing", async () => {
    mocks.txCborBulk.mockResolvedValue(new Map());
    mockTables({});
    const data = await loadOnChainTxPageData(SLUG, HASH, null);
    expect(data?.cborTrusted).toBe(false);
    expect(data?.decoded).toEqual(EMPTY_TX_VIEW);
    expect(data?.title).toContain("Stake:");
  });
});

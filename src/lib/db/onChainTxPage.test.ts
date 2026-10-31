import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TX_VIEW } from "@/lib/cardano/types";
import { StakeAction, TxKind } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  serverClient: vi.fn(),
  txCborBulk: vi.fn(),
  resolveTxHash: vi.fn(),
  decodeTxForDisplay: vi.fn(),
  lookupStakePool: vi.fn(),
  lookupDrep: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ serverClient: mocks.serverClient }));
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

function externalSelectResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
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
      to_treasury_id: null,
      import_status: null,
      import_issues: [],
      governance_alerted_at: "2026-10-31T08:01:00.000Z",
      created_at: "2026-10-31T08:01:00.000Z",
      treasuries: {
        id: "t-1",
        name: "Gov Treasury",
        address: "addr_test1_gov",
        network: 0,
        community_id: "c-1",
        communities: { slug: SLUG },
      },
      ...overrides,
    },
    error: null,
  };
}

function chain(result: { data: unknown; error: null }) {
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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookupStakePool.mockResolvedValue(null);
  mocks.lookupDrep.mockResolvedValue({ givenName: "Medusa DRep" });
  mocks.txCborBulk.mockResolvedValue(new Map([[HASH, "84a0"]]));
  mocks.resolveTxHash.mockReturnValue(HASH);
  mocks.decodeTxForDisplay.mockReturnValue({
    ...EMPTY_TX_VIEW,
    fee: "200000",
    outputs: [{ address: "addr_test1_gov", lovelace: "99800000", assets: [] }],
  });
});

describe("loadOnChainTxPageData", () => {
  it("returns null for a bad hash", async () => {
    expect(await loadOnChainTxPageData(SLUG, "nope", "addr")).toBeNull();
    expect(mocks.serverClient).not.toHaveBeenCalled();
  });

  it("returns null when the row is missing or the slug mismatches", async () => {
    mocks.serverClient.mockResolvedValue({
      from: () => chain({ data: null, error: null }),
    });
    expect(await loadOnChainTxPageData(SLUG, HASH, "addr")).toBeNull();

    mocks.serverClient.mockResolvedValue({
      from: () =>
        chain(
          externalSelectResult({
            treasuries: {
              id: "t-1",
              name: "Gov",
              address: "addr",
              network: 0,
              community_id: "c-1",
              communities: { slug: "other" },
            },
          }),
        ),
    });
    expect(await loadOnChainTxPageData(SLUG, HASH, "addr")).toBeNull();
  });

  it("loads the row, enriches the stake title, and decodes trusted CBOR", async () => {
    const from = vi.fn((table: string) => {
      if (table === "external_txs") return chain(externalSelectResult());
      if (table === "community_assets") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      if (table === "proposals") {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    mocks.serverClient.mockResolvedValue({ from });

    const data = await loadOnChainTxPageData(SLUG, HASH.toUpperCase(), "addr");
    expect(data).toMatchObject({
      slug: SLUG,
      title: "Stake: vote delegation to Medusa DRep",
      cborTrusted: true,
      treasury: { name: "Gov Treasury", network: 0 },
      activity: { kind: TxKind.Stake, action: StakeAction.VoteDelegation },
      governanceAction: {
        kind: "stake",
        action: StakeAction.VoteDelegation,
        dRepName: "Medusa DRep",
      },
    });
    expect(data?.decoded.fee).toBe("200000");
    expect(mocks.txCborBulk).toHaveBeenCalled();
  });

  it("still returns the row when CBOR is missing", async () => {
    mocks.txCborBulk.mockResolvedValue(new Map());
    const from = vi.fn((table: string) => {
      if (table === "external_txs") return chain(externalSelectResult());
      if (table === "community_assets") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    mocks.serverClient.mockResolvedValue({ from });

    const data = await loadOnChainTxPageData(SLUG, HASH, null);
    expect(data?.cborTrusted).toBe(false);
    expect(data?.decoded).toEqual(EMPTY_TX_VIEW);
    expect(data?.title).toContain("Stake:");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { StakeAction, TxKind } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  txInfoBulk: vi.fn(),
  lookupStakePool: vi.fn(),
  lookupDrep: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/cardano/koios", () => ({
  txInfoBulk: mocks.txInfoBulk,
  lookupStakePool: mocks.lookupStakePool,
  lookupDrep: mocks.lookupDrep,
}));

import {
  classifyUnlabeledExternalTxs,
  enrichIncompleteExternalLabels,
} from "./classifyExternal";

type Op = "select" | "update";
interface Call {
  table: string;
  op: Op;
  values?: Record<string, unknown>;
  filters: [string, unknown][];
}
type Answer = { data: unknown; error: { message: string } | null };

let calls: Call[];
let selectData: unknown;

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const record = (k: string, v: unknown) => {
    call.filters.push([k, v]);
    return chain;
  };
  const chain = {
    select: () => chain,
    update: (values: Record<string, unknown>) => {
      call.op = "update";
      call.values = values;
      return chain;
    },
    eq: record,
    is: record,
    not: (k: string, op: string, v: unknown) => record(`not:${k}`, [op, v]),
    order: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      calls.push(call);
      const answer: Answer =
        call.op === "select"
          ? { data: selectData, error: null }
          : { data: null, error: null };
      return Promise.resolve(answer).then(resolve, reject);
    },
  };
  return chain;
}

beforeEach(() => {
  calls = [];
  selectData = [];
  mocks.from.mockReset();
  mocks.txInfoBulk.mockReset();
  mocks.lookupStakePool.mockReset();
  mocks.lookupDrep.mockReset();
  mocks.lookupStakePool.mockResolvedValue(null);
  mocks.lookupDrep.mockResolvedValue(null);
  mocks.from.mockImplementation(builder);
});

describe("classifyUnlabeledExternalTxs", () => {
  it("does nothing when every external row is already classified", async () => {
    expect(await classifyUnlabeledExternalTxs({ id: "t-1", network: 0 })).toEqual({ classified: 0 });
    expect(mocks.txInfoBulk).not.toHaveBeenCalled();
  });

  it("writes stake activity with DRep name and stamps the alert column", async () => {
    selectData = [{ tx_hash: "h-stake" }];
    mocks.lookupDrep.mockResolvedValue({ givenName: "Medusa DRep" });
    mocks.txInfoBulk.mockResolvedValue([{
      tx_hash: "h-stake",
      block_height: 1,
      tx_timestamp: 1,
      inputs: [],
      outputs: [],
      certificates: [{
        index: 0,
        type: "vote_delegation",
        info: { drep_id: "drep1medusa" },
      }],
    }]);
    expect(await classifyUnlabeledExternalTxs({ id: "t-1", network: 0 })).toEqual({ classified: 1 });
    expect(calls.find((c) => c.op === "select")?.filters).toEqual(
      expect.arrayContaining([["activity", null]]),
    );
    const update = calls.find((c) => c.op === "update");
    expect(update?.values).toMatchObject({
      activity: {
        kind: TxKind.Stake,
        action: StakeAction.VoteDelegation,
        dRepId: "drep1medusa",
        dRepName: "Medusa DRep",
      },
      governance_alerted_at: expect.any(String),
    });
  });

  it("writes {} when Koios has nothing recognizable", async () => {
    selectData = [{ tx_hash: "h-plain" }];
    mocks.txInfoBulk.mockResolvedValue([{
      tx_hash: "h-plain",
      block_height: 1,
      tx_timestamp: 1,
      inputs: [],
      outputs: [],
    }]);
    expect(await classifyUnlabeledExternalTxs({ id: "t-1", network: 0 })).toEqual({ classified: 1 });
    expect(calls.find((c) => c.op === "select")?.filters).toEqual(
      expect.arrayContaining([["activity", null]]),
    );
    expect(calls.find((c) => c.op === "update")?.values).toEqual({ activity: {} });
  });

  it("skips a hash Koios did not describe", async () => {
    selectData = [{ tx_hash: "h-missing" }];
    mocks.txInfoBulk.mockResolvedValue([]);
    expect(await classifyUnlabeledExternalTxs({ id: "t-1", network: 0 })).toEqual({ classified: 0 });
    expect(calls.find((c) => c.op === "select")?.filters).toEqual(
      expect.arrayContaining([["activity", null]]),
    );
    expect(calls.filter((c) => c.op === "update")).toEqual([]);
  });
});

describe("enrichIncompleteExternalLabels", () => {
  it("updates stake rows missing a ticker or DRep name", async () => {
    selectData = [
      {
        tx_hash: "h-1",
        activity: {
          kind: TxKind.Stake,
          action: StakeAction.Delegate,
          poolId: "pool1abc",
        },
      },
      {
        tx_hash: "h-done",
        activity: {
          kind: TxKind.Stake,
          action: StakeAction.Delegate,
          poolId: "pool1abc",
          poolTicker: "SIG",
        },
      },
      { tx_hash: "h-empty", activity: {} },
    ];
    mocks.lookupStakePool.mockResolvedValue({ ticker: "SIG" });
    expect(await enrichIncompleteExternalLabels({ id: "t-1", network: 0 })).toEqual({
      enriched: 1,
    });
    const updates = calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values?.activity).toMatchObject({
      kind: TxKind.Stake,
      action: StakeAction.Delegate,
      poolId: "pool1abc",
      poolTicker: "SIG",
    });
  });

  it("writes nothing when lookups fail", async () => {
    selectData = [{
      tx_hash: "h-1",
      activity: {
        kind: TxKind.Stake,
        action: StakeAction.VoteDelegation,
        dRepId: "drep1medusa",
      },
    }];
    mocks.lookupDrep.mockResolvedValue(null);
    expect(await enrichIncompleteExternalLabels({ id: "t-1", network: 0 })).toEqual({
      enriched: 0,
    });
    expect(calls.filter((c) => c.op === "update")).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));

import { listUnalertedSpends, markSpendAlerted } from "./outsideSpends";

interface Op {
  table: string;
  filters: [string, unknown][];
  values?: Record<string, unknown>;
  columns?: string;
  op: "select" | "update";
}

let ops: Op[];
let selectData: unknown;

function builder(table: string) {
  const op: Op = { table, op: "select", filters: [] };
  const record = (k: string, v: unknown) => {
    op.filters.push([k, v]);
    return chain;
  };
  const chain = {
    select: (columns: string) => {
      op.columns = columns;
      return chain;
    },
    update: (values: Record<string, unknown>) => {
      op.op = "update";
      op.values = values;
      return chain;
    },
    is: record,
    or: (v: string) => record("or", v),
    in: record,
    order: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ops.push(op);
      return Promise.resolve({ data: selectData, error: null }).then(resolve, reject);
    },
  };
  return chain;
}

beforeEach(() => {
  ops = [];
  selectData = [];
  mocks.from.mockReset();
  mocks.from.mockImplementation(builder);
});

describe("listUnalertedSpends", () => {
  it("loads only unalerted rows the chain import is done with", async () => {
    selectData = [{
      tx_hash: "a".repeat(64),
      treasury_id: "t-1",
      block_time: "2026-10-01T00:00:00Z",
      amount_lovelace: "1",
      assets: null,
      to_addresses: [],
      to_treasury_id: null,
      activity: null,
      treasuries: { name: "Main", network: 0, community_id: "c-1" },
    }];
    const rows = await listUnalertedSpends();
    expect(rows).toHaveLength(1);
    expect(rows[0].activity).toBeNull();
    expect(ops[0]).toMatchObject({
      table: "external_txs",
      columns: expect.stringContaining("activity"),
      filters: expect.arrayContaining([
        ["governance_alerted_at", null],
        ["or", "payout_meta.is.null,import_status.not.is.null"],
      ]),
    });
  });
});

describe("markSpendAlerted", () => {
  it("stamps the named hashes and does nothing with an empty list", async () => {
    await markSpendAlerted([]);
    expect(mocks.from).not.toHaveBeenCalled();

    await markSpendAlerted(["h1", "h2"]);
    expect(ops[0]).toMatchObject({
      table: "external_txs",
      op: "update",
      values: { governance_alerted_at: expect.any(String) },
      filters: [["tx_hash", ["h1", "h2"]]],
    });
  });
});

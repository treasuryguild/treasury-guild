import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { TxState } from "@/lib/constants";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));

import { findCommunityTransaction, loadTransactionDetail } from "./txDetail";

const TX_ID = "a0000000-0000-4000-8000-000000000001";
const HASH = "ab".repeat(32);

/** The rows each table answers, and the chain each query was built with. */
let answers: Record<string, { data?: unknown; error: PostgrestError | null }>;
let calls: Record<string, unknown[][]>;

/** A query builder that records its chain and resolves to its table's answer. */
function builder(table: string) {
  const chain: unknown[][] = (calls[table] = []);
  const query: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(answers[table] ?? { data: [], error: null }).then(ok, ko),
  };
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    query[method] = (...args: unknown[]) => {
      chain.push([method, ...args]);
      return query;
    };
  }
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  answers = {};
  calls = {};
  mocks.from.mockImplementation(builder);
});

describe("findCommunityTransaction", () => {
  const tx = (id: string, state: number) => ({ id, tx_hash: HASH, state });

  it("reads nothing for a community without treasuries", async () => {
    expect(await findCommunityTransaction([], TX_ID)).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("looks a uuid up by id, among the community's treasuries only", async () => {
    answers.transactions = { data: [tx(TX_ID, TxState.Pending)], error: null };
    expect(await findCommunityTransaction(["t-1", "t-2"], TX_ID)).toMatchObject({ id: TX_ID });
    expect(calls.transactions).toContainEqual(["in", "treasury_id", ["t-1", "t-2"]]);
    expect(calls.transactions).toContainEqual(["eq", "id", TX_ID]);
    expect(calls.transactions).not.toContainEqual(expect.arrayContaining(["eq", "tx_hash"]));
  });

  it("looks anything else up by its hash, lower-cased", async () => {
    answers.transactions = { data: [tx(TX_ID, TxState.Confirmed)], error: null };
    await findCommunityTransaction(["t-1"], HASH.toUpperCase());
    expect(calls.transactions).toContainEqual(["eq", "tx_hash", HASH]);
    expect(calls.transactions).toContainEqual(["order", "created_at", { ascending: false }]);
  });

  it("prefers a live row over a newer rejected one sharing the hash", async () => {
    // Newest first, as the query orders them: the rejected rebuild's twin comes first.
    answers.transactions = { data: [tx("tx-rejected", TxState.Rejected), tx("tx-live", TxState.Submitted)], error: null };
    expect(await findCommunityTransaction(["t-1"], HASH)).toMatchObject({ id: "tx-live" });
  });

  it("falls back to the newest rejected row, and null when nothing matches", async () => {
    answers.transactions = { data: [tx("tx-r2", TxState.Rejected), tx("tx-r1", TxState.Rejected)], error: null };
    expect(await findCommunityTransaction(["t-1"], HASH)).toMatchObject({ id: "tx-r2" });
    answers.transactions = { data: [], error: null };
    expect(await findCommunityTransaction(["t-1"], HASH)).toBeNull();
  });

  it("throws when the read fails", async () => {
    answers.transactions = { data: null, error: new PostgrestError({ message: "permission denied", code: "42501", details: "", hint: "" }) };
    await expect(findCommunityTransaction(["t-1"], HASH)).rejects.toThrow("find transaction: permission denied");
  });
});

describe("loadTransactionDetail", () => {
  it("flattens each payout's task and workgroup, whether the embeds come as objects or arrays", async () => {
    answers.payouts = {
      data: [
        { contributor_wallet: "addr_a", unit: "lovelace", amount: 5000000, tasks: { number: 7, title: "Docs", workgroups: { name: "Core" } } },
        { contributor_wallet: "addr_b", unit: "lovelace", amount: "3000000", tasks: [{ number: 8, title: "Tests", workgroups: [{ name: "QA" }] }] },
      ],
      error: null,
    };
    answers.payments = { data: [{ id: "pay-1" }], error: null };
    answers.mints = { data: [{ asset_name: "GV" }], error: null };
    answers.cosigner_decisions = { data: [{ id: "d-1" }], error: null };
    expect(await loadTransactionDetail({ id: TX_ID })).toEqual({
      payouts: [
        { wallet: "addr_a", unit: "lovelace", amount: "5000000", taskNumber: 7, taskTitle: "Docs", workgroup: "Core" },
        { wallet: "addr_b", unit: "lovelace", amount: "3000000", taskNumber: 8, taskTitle: "Tests", workgroup: "QA" },
      ],
      payments: [{ id: "pay-1" }],
      mints: [{ asset_name: "GV" }],
      decisions: [{ id: "d-1" }],
    });
    expect(calls.payouts).toContainEqual(["select", "contributor_wallet, unit, amount, tasks!inner(number, title, workgroups!inner(name))"]);
    for (const table of ["payouts", "payments", "mints", "cosigner_decisions"]) {
      expect(calls[table]).toContainEqual(["eq", "transaction_id", TX_ID]);
    }
  });

  it("answers empty lists for a transaction that pays nothing", async () => {
    expect(await loadTransactionDetail({ id: TX_ID })).toEqual({ payouts: [], payments: [], mints: [], decisions: [] });
  });

  it("throws when one of the reads fails", async () => {
    answers.mints = { data: null, error: new PostgrestError({ message: "timeout", code: "57014", details: "", hint: "" }) };
    await expect(loadTransactionDetail({ id: TX_ID })).rejects.toThrow("load mints: timeout");
  });
});

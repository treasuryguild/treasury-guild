// The treasury poll against a scripted Koios and service client: what it
// confirms, records and stamps. The output arithmetic is pollRules.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KoiosAddressTx, KoiosTxInfo } from "@/lib/cardano/koios";
import { PgCode } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  addressTxs: vi.fn(),
  txInfoBulk: vi.fn(),
  confirm: vi.fn(),
  tagInternalTransfers: vi.fn(),
}));
// db/client re-exports this client; its real rows / maybe / check unwrap the results.
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/cardano/koios", () => ({ addressTxs: mocks.addressTxs, txInfoBulk: mocks.txInfoBulk }));
vi.mock("@/lib/db/transactions", () => ({ confirmTransaction: mocks.confirm }));
vi.mock("@/lib/db/treasuries", () => ({ tagInternalTransfers: mocks.tagInternalTransfers }));

import { pollTreasury } from "./poll";

type Op = "select" | "update" | "insert" | "upsert";
interface Call { table: string; op: Op; values?: Record<string, unknown>; filters: [string, unknown][] }
type Answer = { data: unknown; error: { message: string; code?: string } | null };
type Handler = (call: Call) => Answer | undefined;

let calls: Call[];
/** What each table answers; a select falls back to no rows, a write to success. */
let handlers: Record<string, Handler>;

const OK: Answer = { data: null, error: null };
const NO_ROWS: Answer = { data: [], error: null };

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const record = (k: string, v: unknown) => { call.filters.push([k, v]); return chain; };
  const write = (op: Op) => (values: Record<string, unknown>) => { call.op = op; call.values = values; return chain; };
  const answer = (): Answer => handlers[table]?.(call) ?? (call.op === "select" ? NO_ROWS : OK);
  const chain = {
    select: () => chain,
    update: write("update"),
    insert: write("insert"),
    upsert: write("upsert"),
    eq: record,
    in: record,
    not: (k: string, op: string, v: unknown) => record(`not:${k}`, [op, v]),
    maybeSingle: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      calls.push(call);
      return Promise.resolve(answer()).then(resolve, reject);
    },
  };
  return chain;
}

const TREASURY = { id: "t-1", community_id: "c-1", address: "addr_test1_treasury", network: 0 };
const OTHER = "addr_test1_other";
const ALICE = "addr_test1_alice";
const BOB = "addr_test1_bob";
const POLICY = "d".repeat(56);
const UNIT = `${POLICY}aa`;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const TS = 1_700_000_000;
const TS_ISO = "2023-11-14T22:13:20.000Z";

const listed = (tx_hash: string, block_height: number): KoiosAddressTx => ({ tx_hash, epoch_no: 1, block_height, block_time: TS });

function info(tx_hash: string, patch: Partial<KoiosTxInfo> = {}): KoiosTxInfo {
  return { tx_hash, block_height: 1, tx_timestamp: TS, inputs: [], outputs: [], ...patch };
}

/** Spent by the treasury: two recipients and change, listed out of body order. */
function outgoing(tx_hash: string, patch: Partial<KoiosTxInfo> = {}): KoiosTxInfo {
  return info(tx_hash, {
    fee: "180000",
    inputs: [{ payment_addr: { bech32: TREASURY.address }, value: "100000000" }],
    outputs: [
      { payment_addr: { bech32: BOB }, value: "2000000", tx_index: 1, asset_list: [{ policy_id: POLICY, asset_name: "aa", quantity: "5" }] },
      { payment_addr: { bech32: ALICE }, value: "3000000", tx_index: 0 },
      { payment_addr: { bech32: TREASURY.address }, value: "94820000", tx_index: 2 },
    ],
    ...patch,
  });
}

/** Paid to the treasury from elsewhere, with tokens and change back to a sender. */
function inflow(tx_hash: string, patch: Partial<KoiosTxInfo> = {}): KoiosTxInfo {
  return info(tx_hash, {
    inputs: [
      { payment_addr: { bech32: OTHER }, value: "4000000" },
      { payment_addr: { bech32: OTHER }, value: "4000000" },
      { payment_addr: { bech32: ALICE }, value: "1000000" },
    ],
    outputs: [
      { payment_addr: { bech32: TREASURY.address }, value: "5000000", asset_list: [{ policy_id: POLICY, asset_name: "aa", quantity: "7" }] },
      { payment_addr: { bech32: TREASURY.address }, value: "1000000" },
      { payment_addr: { bech32: OTHER }, value: "2800000" },
    ],
    ...patch,
  });
}

const of = (table: string, op: Op = "select") => calls.filter((c) => c.table === table && c.op === op);
const has = (call: Call, key: string) => call.filters.some(([k]) => k === key);

/** The transactions table: the known-hash read (a `not` filter) and the pending/submitted read (a `state` filter). */
function transactions(known: string[], awaiting: { id: string; tx_hash: string | null }[]): Handler {
  return (call) => {
    if (call.op !== "select") return undefined;
    if (has(call, "state")) return { data: awaiting, error: null };
    return { data: known.map((tx_hash) => ({ tx_hash })), error: null };
  };
}

function chain(listedTxs: KoiosAddressTx[], infos: KoiosTxInfo[]) {
  mocks.addressTxs.mockResolvedValue(listedTxs);
  mocks.txInfoBulk.mockResolvedValue(infos);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  calls = [];
  handlers = {};
  mocks.from.mockImplementation(builder);
  chain([], []);
  mocks.confirm.mockResolvedValue(true);
  mocks.tagInternalTransfers.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pollTreasury", () => {
  describe("the sync cursor", () => {
    it("asks Koios from block zero when the treasury has no cursor, and stamps one even when nothing arrived", async () => {
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 0, newExternal: 0 });
      expect(mocks.addressTxs).toHaveBeenCalledExactlyOnceWith(0, TREASURY.address, 0);
      expect(mocks.txInfoBulk).not.toHaveBeenCalled();
      const cursor = of("treasury_sync_cursors", "select")[0];
      expect(cursor?.filters).toEqual([["treasury_id", "t-1"]]);
      expect(of("treasury_sync_cursors", "upsert").map((c) => c.values)).toEqual([
        { treasury_id: "t-1", last_block_height: 0, synced_at: new Date(NOW).toISOString() },
      ]);
      expect(mocks.tagInternalTransfers).not.toHaveBeenCalled();
    });

    it("resumes from the stored height on the community's network and advances to the highest block seen", async () => {
      handlers.treasury_sync_cursors = (call) => (call.op === "select" ? { data: { last_block_height: 500 }, error: null } : undefined);
      handlers.transactions = transactions([], []);
      chain([listed("h-in", 620), listed("h-later", 640)], [inflow("h-in"), inflow("h-later")]);
      await pollTreasury({ ...TREASURY, network: 1 });
      expect(mocks.addressTxs).toHaveBeenCalledExactlyOnceWith(1, TREASURY.address, 500);
      expect(mocks.txInfoBulk).toHaveBeenCalledExactlyOnceWith(1, ["h-in", "h-later"]);
      expect(of("incoming_txs", "insert")).toHaveLength(2);
      expect(of("treasury_sync_cursors", "upsert")[0]?.values).toEqual({ treasury_id: "t-1", last_block_height: 640, synced_at: new Date(NOW).toISOString() });
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("holds the cursor at the block of a hash Koios listed but did not describe, recording what it did describe", async () => {
      handlers.treasury_sync_cursors = (call) => (call.op === "select" ? { data: { last_block_height: 500 }, error: null } : undefined);
      chain(
        [listed("h-in", 620), listed("h-gap", 640), listed("h-gap-2", 660), listed("h-later", 700)],
        [inflow("h-in"), inflow("h-later")],
      );
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 2, confirmed: 0, newExternal: 0 });
      expect(of("incoming_txs", "insert").map((c) => c.values?.tx_hash)).toEqual(["h-in", "h-later"]);
      // Koios lists from the cursor's block inclusive, so the next poll asks for 640 again.
      expect(of("treasury_sync_cursors", "upsert")[0]?.values).toMatchObject({ last_block_height: 640 });
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("h-gap, h-gap-2"));
    });

    it("advances past the gap once the next poll finds it described", async () => {
      let cursor = 500;
      handlers.treasury_sync_cursors = (call) => {
        if (call.op === "select") return { data: { last_block_height: cursor }, error: null };
        cursor = call.values?.last_block_height as number;
        return undefined;
      };
      const seen = new Set<string>();
      handlers.incoming_txs = (call) => {
        const hash = String(call.values?.tx_hash);
        if (seen.has(hash)) return { data: null, error: { message: "duplicate", code: PgCode.UniqueViolation } };
        seen.add(hash);
        return undefined;
      };
      mocks.addressTxs.mockResolvedValueOnce([listed("h-in", 620), listed("h-gap", 640), listed("h-later", 700)]);
      mocks.txInfoBulk.mockResolvedValueOnce([inflow("h-in"), inflow("h-later")]);
      expect((await pollTreasury(TREASURY)).newIncoming).toBe(2);
      expect(cursor).toBe(640);

      mocks.addressTxs.mockResolvedValueOnce([listed("h-gap", 640), listed("h-later", 700)]);
      mocks.txInfoBulk.mockResolvedValueOnce([inflow("h-gap"), inflow("h-later")]);
      // Only the gap is new: the inflow recorded last time is refused by the table.
      expect((await pollTreasury(TREASURY)).newIncoming).toBe(1);
      expect(mocks.addressTxs).toHaveBeenLastCalledWith(0, TREASURY.address, 640);
      expect(cursor).toBe(700);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("never moves the cursor back when the only hash listed is undescribed", async () => {
      handlers.treasury_sync_cursors = (call) => (call.op === "select" ? { data: { last_block_height: 500 }, error: null } : undefined);
      chain([listed("h-gap", 500)], []);
      await pollTreasury(TREASURY);
      expect(of("treasury_sync_cursors", "upsert")[0]?.values).toMatchObject({ last_block_height: 500 });
    });
  });

  describe("confirming pending and submitted transactions", () => {
    it("confirms a submitted transaction the chain shows in one call carrying its block time", async () => {
      handlers.transactions = transactions(["h-1", "h-2"], [{ id: "tx-1", tx_hash: "h-1" }, { id: "tx-2", tx_hash: "h-2" }, { id: "tx-3", tx_hash: null }]);
      chain([listed("h-1", 900)], [outgoing("h-1")]);

      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 1, newExternal: 0 });

      // The row, its payouts and its tasks are confirm_transaction's; the poller writes none of them.
      // A submitted transaction the chain does not show yet (tx-2) or without a hash (tx-3) is left as it is.
      expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith("tx-1", TS_ISO);
      expect(of("transactions", "update")).toEqual([]);
      expect(of("payouts", "update")).toEqual([]);
      expect(of("tasks", "update")).toEqual([]);
      // The app's own transaction is never recorded as external.
      expect(of("external_txs", "insert")).toEqual([]);
      expect(mocks.tagInternalTransfers).not.toHaveBeenCalled();
    });

    it("confirms a transaction of any kind, each with its own block time", async () => {
      handlers.transactions = transactions(["h-pay", "h-mint", "h-anchor"], [
        { id: "tx-pay", tx_hash: "h-pay" }, { id: "tx-mint", tx_hash: "h-mint" }, { id: "tx-anchor", tx_hash: "h-anchor" },
      ]);
      chain(
        [listed("h-pay", 901), listed("h-mint", 902), listed("h-anchor", 903)],
        [outgoing("h-pay"), outgoing("h-mint", { tx_timestamp: TS + 60 }), outgoing("h-anchor", { outputs: [{ payment_addr: { bech32: TREASURY.address }, value: "99800000" }] })],
      );
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 3, newExternal: 0 });
      expect(mocks.confirm.mock.calls).toEqual([
        ["tx-pay", TS_ISO],
        ["tx-mint", new Date((TS + 60) * 1000).toISOString()],
        ["tx-anchor", TS_ISO],
      ]);
    });

    it("does not count a transaction another poll confirmed first, and writes nothing else for it", async () => {
      handlers.transactions = transactions(["h-1", "h-2"], [{ id: "tx-1", tx_hash: "h-1" }, { id: "tx-2", tx_hash: "h-2" }]);
      chain([listed("h-1", 900), listed("h-2", 901)], [outgoing("h-1"), outgoing("h-2")]);
      mocks.confirm.mockImplementation(async (id: string) => id === "tx-2");
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 1, newExternal: 0 });
      expect(mocks.confirm).toHaveBeenCalledTimes(2);
      expect(calls.filter((c) => c.op === "update" || c.op === "insert")).toEqual([]);
    });

    it("confirms a pending transaction whose hash is already on-chain", async () => {
      handlers.transactions = transactions(["h-pending"], [{ id: "tx-pending", tx_hash: "h-pending" }]);
      chain([listed("h-pending", 900)], [outgoing("h-pending")]);
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 1, newExternal: 0 });
      expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith("tx-pending", TS_ISO);
      expect(of("external_txs", "insert")).toEqual([]);
    });
  });

  describe("recording inflows", () => {
    it("records an inflow with its amount, tokens, distinct senders and block time, then tags transfers", async () => {
      chain([listed("h-in", 800)], [inflow("h-in")]);
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 1, confirmed: 0, newExternal: 0 });
      expect(of("incoming_txs", "insert").map((c) => c.values)).toEqual([{
        tx_hash: "h-in",
        treasury_id: "t-1",
        from_addresses: [OTHER, ALICE],
        amount_lovelace: "6000000",
        assets: { [UNIT]: "7" },
        block_time: TS_ISO,
      }]);
      expect(of("external_txs", "insert")).toEqual([]);
      expect(mocks.tagInternalTransfers).toHaveBeenCalledExactlyOnceWith("c-1");
      // Bookkeeping comes last: the rows are in before the cursor moves.
      const tagged = mocks.tagInternalTransfers.mock.invocationCallOrder[0]!;
      expect(mocks.from.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(tagged);
      expect(of("treasury_sync_cursors", "upsert")[0]?.values).toMatchObject({ last_block_height: 800 });
    });

    it("counts an inflow only once: a re-poll's duplicate is refused by the table and not tagged again", async () => {
      handlers.incoming_txs = (call) => (call.op === "insert"
        ? { data: null, error: { message: "duplicate key value violates unique constraint", code: PgCode.UniqueViolation } }
        : undefined);
      chain([listed("h-in", 800)], [inflow("h-in")]);
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 0, newExternal: 0 });
      expect(of("incoming_txs", "insert")).toHaveLength(1);
      expect(mocks.tagInternalTransfers).not.toHaveBeenCalled();
      expect(of("treasury_sync_cursors", "upsert")[0]?.values).toMatchObject({ last_block_height: 800 });
    });

    it("logs an inflow the table refuses for another reason, without counting it", async () => {
      const refusal = { message: "value too long", code: "22001" };
      handlers.incoming_txs = (call) => (call.op === "insert" ? { data: null, error: refusal } : undefined);
      chain([listed("h-in", 800)], [inflow("h-in")]);
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 0, newExternal: 0 });
      expect(console.error).toHaveBeenCalledExactlyOnceWith("incoming_txs insert h-in failed", refusal);
    });

    it("ignores a transaction from elsewhere that leaves nothing at the treasury", async () => {
      chain([listed("h-none", 800)], [inflow("h-none", { outputs: [{ payment_addr: { bech32: OTHER }, value: "1000000" }] })]);
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 0, newExternal: 0 });
      expect(of("incoming_txs", "insert")).toEqual([]);
    });
  });

  describe("recording outside transactions", () => {
    const META = { v: 3, src: "treasury-guild", c: "signius", p: [[0, [[12, 0, 0, ["3"]]]]] };

    it("records a spend the app did not build, with the Koios label-190001 record as payout_meta", async () => {
      handlers.transactions = transactions(["h-own"], []);
      chain([listed("h-out", 850)], [outgoing("h-out", { metadata: { "674": { msg: ["hi"] }, "190001": META } })]);
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 0, newExternal: 1 });
      expect(of("external_txs", "insert").map((c) => c.values)).toEqual([{
        tx_hash: "h-out",
        treasury_id: "t-1",
        block_height: 850,
        block_time: TS_ISO,
        fee_lovelace: "180000",
        amount_lovelace: "5000000",
        assets: { [UNIT]: "5" },
        to_addresses: [ALICE, BOB],
        payout_meta: META,
        activity: {},
      }]);
      expect(of("incoming_txs", "insert")).toEqual([]);
      expect(mocks.tagInternalTransfers).toHaveBeenCalledExactlyOnceWith("c-1");
    });

    it("stores no payout_meta for a spend without the label, and a zero fee when Koios gives none", async () => {
      chain([listed("h-out", 850)], [outgoing("h-out", { fee: undefined, metadata: { "674": { msg: ["hi"] } } })]);
      await pollTreasury(TREASURY);
      expect(of("external_txs", "insert")[0]?.values).toMatchObject({
        payout_meta: null,
        fee_lovelace: "0",
        activity: {},
      });
    });

    it("stores stake activity and stamps the alert column for a vote-delegation spend", async () => {
      chain([listed("h-stake", 850)], [outgoing("h-stake", {
        outputs: [{ payment_addr: { bech32: TREASURY.address }, value: "99820000", tx_index: 0 }],
        certificates: [{
          index: 0,
          type: "vote_delegation",
          info: { drep_id: "drep1medusa", stake_address: "stake_test1…" },
        }],
      })]);
      await pollTreasury(TREASURY);
      const inserted = of("external_txs", "insert")[0]?.values;
      expect(inserted).toMatchObject({
        tx_hash: "h-stake",
        activity: { kind: "stake", action: "vote_delegation", dRepId: "drep1medusa" },
        governance_alerted_at: expect.any(String),
      });
    });

    it("stores CIP-0146 registration activity from label 1854", async () => {
      chain([listed("h-reg", 850)], [outgoing("h-reg", {
        outputs: [{ payment_addr: { bech32: TREASURY.address }, value: "99820000", tx_index: 0 }],
        metadata: { "1854": { types: [1], name: "Gov" } },
      })]);
      await pollTreasury(TREASURY);
      expect(of("external_txs", "insert")[0]?.values).toMatchObject({
        activity: { kind: "registration" },
        governance_alerted_at: expect.any(String),
      });
    });

    it("skips a spend whose hash the app holds in any state, and the app's own rows are never external", async () => {
      handlers.transactions = transactions(["h-rejected", "h-pending"], []);
      chain([listed("h-rejected", 850), listed("h-pending", 851), listed("h-out", 852)], [outgoing("h-rejected"), outgoing("h-pending"), outgoing("h-out")]);
      expect((await pollTreasury(TREASURY)).newExternal).toBe(1);
      expect(of("external_txs", "insert").map((c) => c.values?.tx_hash)).toEqual(["h-out"]);
    });

    it("does not count a row the table already holds, and logs any other refusal", async () => {
      const refusals: Record<string, Answer> = {
        "h-dup": { data: null, error: { message: "duplicate", code: PgCode.UniqueViolation } },
        "h-bad": { data: null, error: { message: "value too long", code: "22001" } },
      };
      handlers.external_txs = (call) => (call.op === "insert" ? refusals[String(call.values?.tx_hash)] : undefined);
      chain([listed("h-dup", 850), listed("h-bad", 851), listed("h-new", 852)], [outgoing("h-dup"), outgoing("h-bad"), outgoing("h-new")]);
      expect(await pollTreasury(TREASURY)).toEqual({ newIncoming: 0, confirmed: 0, newExternal: 1 });
      expect(console.error).toHaveBeenCalledExactlyOnceWith("external_txs insert h-bad failed", refusals["h-bad"]?.error);
      expect(mocks.tagInternalTransfers).toHaveBeenCalledTimes(1);
    });
  });

  describe("failures", () => {
    it("throws when Koios cannot list the address, touching no row and moving no cursor", async () => {
      mocks.addressTxs.mockRejectedValue(new Error("koios 503"));
      await expect(pollTreasury(TREASURY)).rejects.toThrow("koios 503");
      expect(calls.filter((c) => c.op !== "select")).toEqual([]);
      expect(mocks.tagInternalTransfers).not.toHaveBeenCalled();
    });

    it("throws when Koios cannot describe the transactions, before any write", async () => {
      mocks.addressTxs.mockResolvedValue([listed("h-in", 800)]);
      mocks.txInfoBulk.mockRejectedValue(new Error("koios timeout"));
      await expect(pollTreasury(TREASURY)).rejects.toThrow("koios timeout");
      expect(calls.filter((c) => c.op !== "select")).toEqual([]);
    });

    it("throws when the known-hash read fails, so the app's own spends are never recorded as external", async () => {
      handlers.transactions = (call) => (has(call, "state") ? undefined : { data: null, error: { message: "connection reset" } });
      chain([listed("h-own", 850)], [outgoing("h-own")]);
      await expect(pollTreasury(TREASURY)).rejects.toThrow("load known tx hashes: connection reset");
      expect(of("external_txs", "insert")).toEqual([]);
      expect(of("treasury_sync_cursors", "upsert")).toEqual([]);
    });

    it("throws when a confirmation fails, leaving the rest for the next poll", async () => {
      handlers.transactions = transactions(["h-1"], [{ id: "tx-1", tx_hash: "h-1" }]);
      mocks.confirm.mockRejectedValue(new Error("deadlock detected"));
      chain([listed("h-1", 900), listed("h-in", 901)], [outgoing("h-1"), inflow("h-in")]);
      await expect(pollTreasury(TREASURY)).rejects.toThrow("deadlock detected");
      // Nothing was confirmed in part: the transaction is still submitted and the next poll retries it.
      expect(of("incoming_txs", "insert")).toEqual([]);
      expect(of("treasury_sync_cursors", "upsert")).toEqual([]);
    });
  });
});

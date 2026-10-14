import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { MSG, PgCode } from "@/lib/constants";
import { ConflictError, InvariantError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

import {
  addSignature, confirmTransaction, deletePendingTransaction, findTransactionByDraft, insertTransaction, recordRejection, withTransactionRow,
} from "./transactions";

const ROW = {
  treasury_id: "t-1", kind: "payout" as const, spending_path: "base" as const, tx_cbor: "84a0", tx_hash: "f".repeat(64), description: "Payout", created_by: "addr",
};
let inserted: { data: unknown; error: PostgrestError | null };
const insert = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  inserted = { data: { id: "tx-1", ...ROW }, error: null };
  insert.mockImplementation(() => ({ select: () => ({ single: async () => inserted }) }));
  mocks.from.mockImplementation(() => ({ insert }));
});

describe("insertTransaction", () => {
  it("returns the new row", async () => {
    expect(await insertTransaction(ROW)).toMatchObject({ id: "tx-1" });
  });

  it("maps the one-pending-transaction index (unique violation) to the pending conflict", async () => {
    inserted = {
      data: null,
      error: new PostgrestError({ message: "duplicate key value violates unique constraint \"transactions_one_pending_uq\"", code: PgCode.UniqueViolation, details: "", hint: "" }),
    };
    await expect(insertTransaction(ROW)).rejects.toThrow(new ConflictError(MSG.pendingTxExists));
  });

  it("stores the agent API draft that made it, and refuses a second row for the same draft with the same 409", async () => {
    const row = { ...ROW, agent_draft_id: "d0000000-0000-4000-8000-000000000001" };
    await insertTransaction(row);
    expect(insert).toHaveBeenCalledExactlyOnceWith(row);
    // The payout confirm catches this conflict and answers from findTransactionByDraft.
    inserted = {
      data: null,
      error: new PostgrestError({ message: "duplicate key value violates unique constraint \"transactions_agent_draft_uq\"", code: PgCode.UniqueViolation, details: "", hint: "" }),
    };
    await expect(insertTransaction(row)).rejects.toThrow(new ConflictError(MSG.pendingTxExists));
  });

  it("leaves any other failure as an invariant error", async () => {
    inserted = { data: null, error: new PostgrestError({ message: "permission denied", code: "42501", details: "", hint: "" }) };
    await expect(insertTransaction(ROW)).rejects.toThrow(InvariantError);
  });
});

describe("the guarded state changes", () => {
  const answers = (data: unknown) => mocks.rpc.mockResolvedValue({ data, error: null });
  const refused = new PostgrestError({ message: "deadlock detected", code: PgCode.DeadlockDetected, details: "", hint: "" });

  it("appends a signature through add_signature and reads anything but true as a miss", async () => {
    answers(true);
    expect(await addSignature({ txId: "tx-1", wallet: "addr", txCbor: "84a1", expectedCount: 1 })).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("add_signature", { p_tx: "tx-1", p_addr: "addr", p_cbor: "84a1", p_expected: 1 });
    answers(null);
    expect(await addSignature({ txId: "tx-1", wallet: "addr", txCbor: "84a1", expectedCount: 1 })).toBe(false);
  });

  it("records a rejection through reject_transaction with the lists the caller read", async () => {
    answers(true);
    const tx = { id: "tx-1", signed_addresses: ["alice"], rejected_addresses: [] };
    expect(await recordRejection({ tx, rejected: ["bob"], dead: true })).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("reject_transaction", {
      p_transaction_id: "tx-1", p_expected_signed: ["alice"], p_expected_rejected: [], p_rejected: ["bob"], p_dead: true,
    });
    answers(false);
    expect(await recordRejection({ tx, rejected: ["bob"], dead: false })).toBe(false);
    expect(mocks.rpc).toHaveBeenLastCalledWith("reject_transaction", expect.objectContaining({ p_dead: false }));
  });

  it("deletes a pending transaction through delete_pending_transaction", async () => {
    answers(true);
    expect(await deletePendingTransaction("tx-1")).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("delete_pending_transaction", { p_transaction_id: "tx-1" });
    answers(false);
    expect(await deletePendingTransaction("tx-1")).toBe(false);
  });

  it("confirms a submitted transaction through confirm_transaction", async () => {
    answers(true);
    expect(await confirmTransaction("tx-1", "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("confirm_transaction", { p_transaction_id: "tx-1", p_block_time: "2026-10-01T00:00:00.000Z" });
    answers(false);
    expect(await confirmTransaction("tx-1", "2026-10-01T00:00:00.000Z")).toBe(false);
  });

  it("throws when the database refuses, rather than answering false", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: refused });
    await expect(recordRejection({ tx: { id: "tx-1", signed_addresses: [], rejected_addresses: [] }, rejected: ["bob"], dead: true })).rejects.toThrow(ConflictError);
    await expect(deletePendingTransaction("tx-1")).rejects.toThrow("deadlock detected");
    await expect(confirmTransaction("tx-1", "2026-10-01T00:00:00.000Z")).rejects.toThrow("deadlock detected");
  });
});

describe("withTransactionRow", () => {
  it("deletes the row again, releasing its queued tasks, when the dependent writes fail", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    await expect(withTransactionRow(ROW, async () => { throw new Error("record anchors failed"); })).rejects.toThrow("record anchors failed");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("delete_pending_transaction", { p_transaction_id: "tx-1" });
  });

  it("still throws the build's own error when the cleanup fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new PostgrestError({ message: "deadlock detected", code: PgCode.DeadlockDetected, details: "", hint: "" }) });
    await expect(withTransactionRow(ROW, async () => { throw new Error("record anchors failed"); })).rejects.toThrow("record anchors failed");
  });

  it("does not insert at all, and cleans nothing, when the index refuses the row", async () => {
    inserted = { data: null, error: new PostgrestError({ message: "duplicate", code: PgCode.UniqueViolation, details: "", hint: "" }) };
    const fn = vi.fn();
    await expect(withTransactionRow(ROW, fn)).rejects.toThrow(ConflictError);
    expect(fn).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("findTransactionByDraft", () => {
  it("looks the transaction up by agent_draft_id, null when the draft made none", async () => {
    const row = { id: "tx-1", tx_hash: "f".repeat(64), treasury_id: "t-1", spending_path: "base" };
    let found: unknown = row;
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: found, error: null }) }));
    mocks.from.mockReturnValue({ select: () => ({ eq }) });
    expect(await findTransactionByDraft("d-1")).toEqual(row);
    expect(mocks.from).toHaveBeenCalledWith("transactions");
    expect(eq).toHaveBeenCalledWith("agent_draft_id", "d-1");
    found = null;
    expect(await findTransactionByDraft("d-1")).toBeNull();
  });
});

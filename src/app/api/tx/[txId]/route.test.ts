import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthzModule from "@/lib/authz";
import { CosignerKind, MSG, SignerGroup, SpendingPath, TreasuryTemplate, TxState } from "@/lib/constants";
import type { TransactionRow, TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

// The prologue (`loadPendingTxForSigner`) and the path rules run for real;
// the session, the row reads and the writer are mocked. The writer puts the
// queued tasks back to payable itself (delete_pending_transaction).
const mocks = vi.hoisted(() => ({
  session: vi.fn(), db: vi.fn(), treasury: vi.fn(), signers: vi.fn(), member: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: mocks.db }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasury: mocks.treasury, loadTreasurySigners: mocks.signers }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  requireMember: mocks.member,
}));
vi.mock("@/lib/db/transactions", () => ({ deletePendingTransaction: mocks.remove }));

import { DELETE } from "./route";

const TX = "40000000-0000-4000-8000-000000000001";
const TREASURY_ID = "40000000-0000-4000-8000-000000000002";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const CAROL = "addr_test1carol";
const RECOVERY = "addr_test1recovery";
const COSIGNER = "addr_test1cosigner";
const OUTSIDER = "addr_test1outsider";

const signer = (wallet: string, group: SignerGroup): TreasurySignerRow => ({
  treasury_id: TREASURY_ID, wallet_address: wallet, key_hash: "ab".repeat(28), stake_key_hash: null, drep_key_hash: null, display_name: null, signer_group: group,
});
const BASE = [signer(ALICE, SignerGroup.Base), signer(BOB, SignerGroup.Base), signer(CAROL, SignerGroup.Base)];
const plain: TreasuryRow = {
  id: TREASURY_ID, community_id: COMMUNITY, name: "Main", network: 0, required: 2, script_type: "atLeast",
  address: "addr_test1treasury", script_cbor: "00", stake_credential_hash: null, template: TreasuryTemplate.Plain,
  lock_slot: null, lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null,
  archived_at: null, archived_by: null,
};
const clawback: TreasuryRow = {
  ...plain, template: TreasuryTemplate.Clawback, lock_slot: 1000, lock_until: "2026-09-01T00:00:00.000Z",
  recovery_script_type: "any", recovery_required: 1,
};
const cosigner: TreasuryRow = { ...plain, template: TreasuryTemplate.Cosigner, cosigner_kind: CosignerKind.Member };

const tx = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  id: TX, treasury_id: TREASURY_ID, kind: "payout", tx_cbor: "84a0", tx_hash: "f".repeat(64), description: null,
  signed_addresses: [], rejected_addresses: [], state: TxState.Pending, created_by: ALICE, submitted_at: null,
  created_at: "2026-10-01T00:00:00.000Z", discord_notified_at: null, spend_problems: [], block_time: null,
  spending_path: SpendingPath.Base, governance_action: null, ...overrides,
});

/** The service client as loadTxContext uses it: transactions.select("*").eq("id").maybeSingle(). */
function txTable(row: TransactionRow | null) {
  const maybeSingle = async () => ({ data: row, error: null });
  return { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })) };
}

function arrange(input: { treasury?: TreasuryRow; signers?: TreasurySignerRow[]; tx?: TransactionRow | null }) {
  mocks.treasury.mockResolvedValue(input.treasury ?? plain);
  mocks.signers.mockResolvedValue(input.signers ?? BASE);
  mocks.db.mockReturnValue(txTable(input.tx === undefined ? tx() : input.tx));
}

const as = (wallet: string) => mocks.session.mockResolvedValue({ wallet });
const del = (headers: Record<string, string> = {}, id = TX) =>
  DELETE(new Request(`http://localhost/api/tx/${id}`, { method: "DELETE", headers }), { params: Promise.resolve({ txId: id }) });

beforeEach(() => {
  vi.resetAllMocks();
  as(ALICE);
  mocks.member.mockResolvedValue("member");
  mocks.remove.mockResolvedValue(true);
  arrange({});
});

describe("DELETE /api/tx/[txId]", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await del()).status).toBe(401);
    expect(mocks.treasury).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const res = await del({ origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Cross-site request rejected");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown transaction, without a lookup for a malformed id", async () => {
    arrange({ tx: null });
    let res = await del();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Transaction not found");
    mocks.db.mockClear();
    res = await del({}, "not-a-uuid");
    expect(res.status).toBe(404);
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a wallet that is not a member of the treasury's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    const res = await del();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not a community member");
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, ALICE);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a member who signs nothing on this treasury", async () => {
    as(OUTSIDER);
    const res = await del();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Caller is not a signer of this treasury");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("answers 409 for a transaction that is no longer pending, before touching anything", async () => {
    arrange({ tx: tx({ state: TxState.Submitted }) });
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txNotPending);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  describe("path participants", () => {
    const clawbackSigners = [...BASE, signer(RECOVERY, SignerGroup.Recovery)];
    const cosignerSigners = [...BASE, signer(COSIGNER, SignerGroup.Cosigner)];

    it("refuses a recovery signer on a base-path transaction", async () => {
      arrange({ treasury: clawback, signers: clawbackSigners, tx: tx({ spending_path: SpendingPath.Base }) });
      as(RECOVERY);
      const res = await del();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.remove).not.toHaveBeenCalled();
    });

    it("refuses a base signer on a recovery-path transaction, and lets a recovery signer delete it", async () => {
      arrange({ treasury: clawback, signers: clawbackSigners, tx: tx({ spending_path: SpendingPath.Recovery, kind: "payment" }) });
      as(ALICE);
      const res = await del();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      as(RECOVERY);
      expect((await del()).status).toBe(200);
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(TX);
    });

    it("lets the co-signer delete a co-signed transaction but not a bypass one", async () => {
      arrange({ treasury: cosigner, signers: cosignerSigners, tx: tx({ spending_path: SpendingPath.Cosigned }) });
      as(COSIGNER);
      expect((await del()).status).toBe(200);
      arrange({ treasury: cosigner, signers: cosignerSigners, tx: tx({ spending_path: SpendingPath.Bypass }) });
      const res = await del();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.remove).toHaveBeenCalledTimes(1);
    });
  });

  it("deletes the pending row in one guarded call", async () => {
    // A base signer who signed nothing and whom others already rejected may still clear the build.
    arrange({ tx: tx({ signed_addresses: [BOB], rejected_addresses: [CAROL] }) });
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(TX);
  });

  it("deletes a transaction of any kind the same way", async () => {
    arrange({ tx: tx({ kind: "payment" }) });
    expect((await del()).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(TX);
  });

  it("answers 409 when a submit landed in between", async () => {
    mocks.remove.mockResolvedValue(false);
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txNotPending);
  });
});

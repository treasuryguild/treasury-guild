import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthzModule from "@/lib/authz";
import { CosignerKind, MSG, SignerGroup, SpendingPath, TreasuryTemplate, TxState } from "@/lib/constants";
import type { TransactionRow, TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

// The prologue (`loadPendingTxForSigner`), the path rules and the
// reachability predicate run for real; the session, the row reads and the
// writer are mocked. The route only passes `dead` into reject_transaction:
// unsigned dead → state 3 + release; signed dead → state 4 (canceled), tasks stay queued.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), db: vi.fn(), treasury: vi.fn(), signers: vi.fn(), member: vi.fn(),
  record: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: mocks.db }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasury: mocks.treasury, loadTreasurySigners: mocks.signers }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  requireMember: mocks.member,
}));
vi.mock("@/lib/db/transactions", () => ({ recordRejection: mocks.record }));

import { POST } from "./route";

const TX = "40000000-0000-4000-8000-000000000001";
const TREASURY_ID = "40000000-0000-4000-8000-000000000002";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const CAROL = "addr_test1carol";
const RECOVERY1 = "addr_test1recovery1";
const RECOVERY2 = "addr_test1recovery2";
const COSIGNER = "addr_test1cosigner";
const OUTSIDER = "addr_test1outsider";

const signer = (wallet: string, group: SignerGroup): TreasurySignerRow => ({
  treasury_id: TREASURY_ID, wallet_address: wallet, key_hash: "ab".repeat(28), stake_key_hash: null, drep_key_hash: null, display_name: null, signer_group: group,
});
const BASE = [signer(ALICE, SignerGroup.Base), signer(BOB, SignerGroup.Base), signer(CAROL, SignerGroup.Base)];
const RECOVERY = [signer(RECOVERY1, SignerGroup.Recovery), signer(RECOVERY2, SignerGroup.Recovery)];
const WITH_COSIGNER = [...BASE, signer(COSIGNER, SignerGroup.Cosigner)];
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
  spending_path: SpendingPath.Base, governance_action: null, valid_to_slot: null, cosign_claimed_at: null, ...overrides,
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
const post = (headers: Record<string, string> = {}, id = TX) =>
  POST(new Request(`http://localhost/api/tx/${id}/reject`, { method: "POST", headers }), { params: Promise.resolve({ txId: id }) });

/** Reject as `wallet` on this row and report what was recorded. */
async function rejectAs(wallet: string, row: TransactionRow, treasury = plain, signers = BASE) {
  arrange({ treasury, signers, tx: row });
  as(wallet);
  const res = await post();
  expect(res.status).toBe(200);
  return (await res.json()) as { rejected: boolean; dead: boolean };
}

beforeEach(() => {
  vi.resetAllMocks();
  as(ALICE);
  mocks.member.mockResolvedValue("member");
  mocks.record.mockResolvedValue(true);
  arrange({});
});

describe("POST /api/tx/[txId]/reject", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.treasury).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const res = await post({ origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Cross-site request rejected");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown transaction, without a lookup for a malformed id", async () => {
    arrange({ tx: null });
    let res = await post();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Transaction not found");
    mocks.db.mockClear();
    res = await post({}, "not-a-uuid");
    expect(res.status).toBe(404);
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a wallet that is not a member of the treasury's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not a community member");
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, ALICE);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a member who signs nothing on this treasury", async () => {
    as(OUTSIDER);
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Caller is not a signer of this treasury");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers 409 once the transaction is no longer pending", async () => {
    arrange({ tx: tx({ state: TxState.Rejected }) });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txNotPending);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  describe("path participants", () => {
    it("refuses a recovery signer on a base-path transaction", async () => {
      arrange({ treasury: clawback, signers: [...BASE, ...RECOVERY], tx: tx({ spending_path: SpendingPath.Base }) });
      as(RECOVERY1);
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.record).not.toHaveBeenCalled();
    });

    it("refuses a base signer on a recovery-path transaction", async () => {
      arrange({ treasury: clawback, signers: [...BASE, ...RECOVERY], tx: tx({ spending_path: SpendingPath.Recovery }) });
      as(ALICE);
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.record).not.toHaveBeenCalled();
    });

    it("refuses the co-signer on a bypass transaction", async () => {
      arrange({ treasury: cosigner, signers: WITH_COSIGNER, tx: tx({ spending_path: SpendingPath.Bypass }) });
      as(COSIGNER);
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.record).not.toHaveBeenCalled();
    });
  });

  it("refuses a wallet that already rejected or already signed", async () => {
    arrange({ tx: tx({ rejected_addresses: [ALICE] }) });
    let res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Already responded to this transaction");
    arrange({ tx: tx({ signed_addresses: [ALICE] }) });
    res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Already responded to this transaction");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  describe("atLeast 2 of 3 on the base path", () => {
    it("records a first rejection without killing the transaction", async () => {
      const row = tx({ signed_addresses: [BOB] });
      expect(await rejectAs(ALICE, row)).toEqual({ rejected: true, dead: false });
      expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ tx: row, rejected: [ALICE], dead: false });
    });

    it("kills the transaction with the rejection that makes the rule unreachable", async () => {
      // Nobody signed, Alice rejected: Bob's rejection leaves one signer for a 2 of 3.
      const row = tx({ rejected_addresses: [ALICE] });
      expect(await rejectAs(BOB, row)).toEqual({ rejected: true, dead: true });
      expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ tx: row, rejected: [ALICE, BOB], dead: true });
    });

    it("keeps a transaction alive while the signatures collected plus the undecided still reach the rule", async () => {
      // Alice signed, Bob rejects: Carol can still complete 2 of 3.
      expect(await rejectAs(BOB, tx({ signed_addresses: [ALICE] }))).toEqual({ rejected: true, dead: false });
      // Alice signed, Bob rejected, Carol rejects: 1 + 0 < 2.
      expect(await rejectAs(CAROL, tx({ signed_addresses: [ALICE], rejected_addresses: [BOB] }))).toEqual({ rejected: true, dead: true });
    });
  });

  it("kills a bypass transaction on any base signer's rejection, whoever signed", async () => {
    const row = tx({ spending_path: SpendingPath.Bypass, signed_addresses: [ALICE, BOB] });
    expect(await rejectAs(CAROL, row, cosigner, WITH_COSIGNER)).toEqual({ rejected: true, dead: true });
    expect(mocks.record).toHaveBeenCalledWith({ tx: row, rejected: [CAROL], dead: true });
  });

  it("kills a co-signed transaction on the co-signer's rejection, whoever signed", async () => {
    const row = tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [ALICE, BOB, CAROL] });
    expect(await rejectAs(COSIGNER, row, cosigner, WITH_COSIGNER)).toEqual({ rejected: true, dead: true });
    expect(mocks.record).toHaveBeenCalledWith({ tx: row, rejected: [COSIGNER], dead: true });
  });

  it("keeps a co-signed transaction alive on one base signer's rejection of a 2 of 3", async () => {
    const row = tx({ spending_path: SpendingPath.Cosigned });
    expect(await rejectAs(ALICE, row, cosigner, WITH_COSIGNER)).toEqual({ rejected: true, dead: false });
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ tx: row, rejected: [ALICE], dead: false });
  });

  it("kills a recovery-path transaction only once every recovery signer rejected", async () => {
    const signers = [...BASE, ...RECOVERY];
    expect(await rejectAs(RECOVERY1, tx({ spending_path: SpendingPath.Recovery }), clawback, signers)).toEqual({ rejected: true, dead: false });
    expect(await rejectAs(RECOVERY2, tx({ spending_path: SpendingPath.Recovery, rejected_addresses: [RECOVERY1] }), clawback, signers)).toEqual({ rejected: true, dead: true });
    expect(mocks.record.mock.calls.map((call) => (call[0] as { dead: boolean }).dead)).toEqual([false, true]);
  });

  it("answers 409 when the row changed under the caller", async () => {
    mocks.record.mockResolvedValue(false);
    arrange({ tx: tx({ rejected_addresses: [BOB] }) });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txChanged);
  });
});

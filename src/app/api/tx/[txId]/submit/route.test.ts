import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthzModule from "@/lib/authz";
import { CosignerKind, MSG, SignerGroup, SpendingPath, TreasuryTemplate, TxState } from "@/lib/constants";
import type { TransactionRow, TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

// The prologue (`loadPendingTxForSigner`), the path rules and the threshold
// predicates run for real; the session, the row reads, the witness filter
// (core-cst / core-csl) and the provider are mocked.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), db: vi.fn(), treasury: vi.fn(), signers: vi.fn(), member: vi.fn(),
  filter: vi.fn(), provider: vi.fn(), submitTx: vi.fn(), markSubmitted: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: mocks.db }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasury: mocks.treasury, loadTreasurySigners: mocks.signers }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  requireMember: mocks.member,
}));
vi.mock("@/lib/cardano/txSignUtils", () => ({ filterWitnessesToScripts: mocks.filter }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));
vi.mock("@/lib/db/transactions", () => ({ markTransactionSubmitted: mocks.markSubmitted }));

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
const FILTERED = "84a1filtered";
const HASH = "e".repeat(64);

const signer = (wallet: string, group: SignerGroup): TreasurySignerRow => ({
  treasury_id: TREASURY_ID, wallet_address: wallet, key_hash: "ab".repeat(28), stake_key_hash: null, display_name: null, signer_group: group,
});
const BASE = [signer(ALICE, SignerGroup.Base), signer(BOB, SignerGroup.Base), signer(CAROL, SignerGroup.Base)];
const RECOVERY = [signer(RECOVERY1, SignerGroup.Recovery), signer(RECOVERY2, SignerGroup.Recovery)];
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
const cosigner: TreasuryRow = { ...plain, template: TreasuryTemplate.Cosigner, cosigner_kind: CosignerKind.App };

const tx = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  id: TX, treasury_id: TREASURY_ID, kind: "payout", tx_cbor: "84a0", tx_hash: "f".repeat(64), description: null,
  signed_addresses: [ALICE, BOB], rejected_addresses: [], state: TxState.Pending, created_by: ALICE, submitted_at: null,
  created_at: "2026-10-01T00:00:00.000Z", discord_notified_at: null, spend_problems: [], block_time: null,
  spending_path: SpendingPath.Base, ...overrides,
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

const post = (headers: Record<string, string> = {}, id = TX) =>
  POST(new Request(`http://localhost/api/tx/${id}/submit`, { method: "POST", headers }), { params: Promise.resolve({ txId: id }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ALICE });
  mocks.member.mockResolvedValue("member");
  mocks.filter.mockReturnValue(FILTERED);
  mocks.submitTx.mockResolvedValue(HASH);
  mocks.provider.mockReturnValue({ submitTx: mocks.submitTx });
  mocks.markSubmitted.mockResolvedValue(undefined);
  arrange({});
});

describe("POST /api/tx/[txId]/submit", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.treasury).not.toHaveBeenCalled();
    expect(mocks.submitTx).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const res = await post({ origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Cross-site request rejected");
    expect(mocks.submitTx).not.toHaveBeenCalled();
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
    expect(mocks.submitTx).not.toHaveBeenCalled();
  });

  it("refuses a wallet that is not a member of the treasury's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not a community member");
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, ALICE);
    expect(mocks.submitTx).not.toHaveBeenCalled();
  });

  it("refuses a member who signs nothing on this treasury, even with enough signatures collected", async () => {
    mocks.session.mockResolvedValue({ wallet: OUTSIDER });
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Caller is not a signer of this treasury");
    expect(mocks.submitTx).not.toHaveBeenCalled();
  });

  it("answers 409 once the transaction is no longer pending", async () => {
    arrange({ tx: tx({ state: TxState.Submitted }) });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txNotPending);
    expect(mocks.submitTx).not.toHaveBeenCalled();
  });

  describe("path participants", () => {
    it("refuses a recovery signer on a base-path transaction", async () => {
      arrange({ treasury: clawback, signers: [...BASE, ...RECOVERY], tx: tx({ spending_path: SpendingPath.Base }) });
      mocks.session.mockResolvedValue({ wallet: RECOVERY1 });
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.submitTx).not.toHaveBeenCalled();
    });

    it("refuses a base signer on a recovery-path transaction", async () => {
      arrange({ treasury: clawback, signers: [...BASE, ...RECOVERY], tx: tx({ spending_path: SpendingPath.Recovery, signed_addresses: [RECOVERY1] }) });
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.submitTx).not.toHaveBeenCalled();
    });

    it("lets a co-signer submit a co-signed transaction but not a bypass one", async () => {
      const signers = [...BASE, signer(COSIGNER, SignerGroup.Cosigner)];
      arrange({ treasury: cosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [ALICE, BOB, COSIGNER] }) });
      mocks.session.mockResolvedValue({ wallet: COSIGNER });
      expect((await post()).status).toBe(200);
      arrange({ treasury: cosigner, signers, tx: tx({ spending_path: SpendingPath.Bypass, signed_addresses: [ALICE, BOB, CAROL] }) });
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.submitTx).toHaveBeenCalledTimes(1);
    });
  });

  describe("threshold on the transaction's own path", () => {
    it("refuses a plain 2 of 3 with one signature", async () => {
      arrange({ tx: tx({ signed_addresses: [ALICE] }) });
      const res = await post();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Not enough signatures: 1 collected, 2 of 3 required");
      expect(mocks.filter).not.toHaveBeenCalled();
      expect(mocks.submitTx).not.toHaveBeenCalled();
    });

    it("counts recovery signatures for nothing on the base path", async () => {
      arrange({ treasury: clawback, signers: [...BASE, ...RECOVERY], tx: tx({ signed_addresses: [RECOVERY1, RECOVERY2, ALICE] }) });
      const res = await post();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Not enough signatures: 3 collected, 2 of 3 required");
      expect(mocks.submitTx).not.toHaveBeenCalled();
    });

    it("counts base signatures for nothing on the recovery path", async () => {
      arrange({ treasury: clawback, signers: [...BASE, ...RECOVERY], tx: tx({ spending_path: SpendingPath.Recovery, signed_addresses: [ALICE, BOB] }) });
      mocks.session.mockResolvedValue({ wallet: RECOVERY1 });
      const res = await post();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Not enough signatures: 2 collected, any signer required");
      // One recovery signature is the rule.
      arrange({ treasury: clawback, signers: [...BASE, ...RECOVERY], tx: tx({ spending_path: SpendingPath.Recovery, signed_addresses: [RECOVERY2] }) });
      expect((await post()).status).toBe(200);
    });

    it("keeps a co-signed transaction incomplete until the co-signer signed, however many base signers did", async () => {
      const signers = [...BASE, signer(COSIGNER, SignerGroup.Cosigner)];
      arrange({ treasury: cosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [ALICE, BOB, CAROL] }) });
      const res = await post();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Not enough signatures: 3 collected, 2 of 3 + co-signer required");
      expect(mocks.submitTx).not.toHaveBeenCalled();
      // The base rule plus the co-signer: complete.
      arrange({ treasury: cosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [ALICE, COSIGNER, BOB] }) });
      expect((await post()).status).toBe(200);
      expect(mocks.submitTx).toHaveBeenCalledTimes(1);
    });

    it("needs every base signer on the bypass path and no co-signer", async () => {
      const signers = [...BASE, signer(COSIGNER, SignerGroup.Cosigner)];
      arrange({ treasury: cosigner, signers, tx: tx({ spending_path: SpendingPath.Bypass, signed_addresses: [ALICE, BOB, COSIGNER] }) });
      const res = await post();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Not enough signatures: 3 collected, all 3 signers required");
      arrange({ treasury: cosigner, signers, tx: tx({ spending_path: SpendingPath.Bypass, signed_addresses: [ALICE, BOB, CAROL] }) });
      expect((await post()).status).toBe(200);
      expect(mocks.submitTx).toHaveBeenCalledTimes(1);
    });
  });

  it("filters the witnesses to the scripts, submits on the treasury's network and records the hash", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txHash: HASH });
    expect(mocks.filter).toHaveBeenCalledExactlyOnceWith("84a0");
    expect(mocks.provider).toHaveBeenCalledExactlyOnceWith(0);
    expect(mocks.submitTx).toHaveBeenCalledExactlyOnceWith(FILTERED);
    expect(mocks.markSubmitted).toHaveBeenCalledExactlyOnceWith(TX, HASH, FILTERED);
    expect(mocks.submitTx.mock.invocationCallOrder[0]).toBeLessThan(mocks.markSubmitted.mock.invocationCallOrder[0] ?? 0);
  });

  it("takes the network from the treasury row", async () => {
    arrange({ treasury: { ...plain, network: 1 } });
    expect((await post()).status).toBe(200);
    expect(mocks.provider).toHaveBeenCalledWith(1);
  });

  it("does not touch the row when the network refuses the transaction", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.submitTx.mockRejectedValue(new Error("BadInputsUTxO"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(mocks.markSubmitted).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("surfaces a failed bookkeeping write, logged with the hash the network accepted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.markSubmitted.mockRejectedValue(new Error("update failed"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledWith(`tx ${TX} submitted as ${HASH} but bookkeeping failed`, expect.any(Error));
    error.mockRestore();
  });
});

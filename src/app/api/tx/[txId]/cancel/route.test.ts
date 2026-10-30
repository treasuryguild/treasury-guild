import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthzModule from "@/lib/authz";
import { CosignerKind, MSG, SignerGroup, SpendingPath, TreasuryTemplate, TxState } from "@/lib/constants";
import type { TransactionRow, TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), db: vi.fn(), treasury: vi.fn(), signers: vi.fn(), member: vi.fn(),
  cancel: vi.fn(), onChain: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: mocks.db }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasury: mocks.treasury, loadTreasurySigners: mocks.signers }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  requireMember: mocks.member,
}));
vi.mock("@/lib/db/transactions", () => ({ cancelPendingTransaction: mocks.cancel }));
vi.mock("@/lib/reconciliation/onChain", () => ({ confirmIfOnChain: mocks.onChain }));

import { POST } from "./route";

const TX = "40000000-0000-4000-8000-000000000001";
const TREASURY_ID = "40000000-0000-4000-8000-000000000002";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const CAROL = "addr_test1carol";

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

const tx = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  id: TX, treasury_id: TREASURY_ID, kind: "payout", tx_cbor: "84a0", tx_hash: "f".repeat(64), description: null,
  signed_addresses: [ALICE], rejected_addresses: [], state: TxState.Pending, created_by: ALICE, submitted_at: null,
  created_at: "2026-10-01T00:00:00.000Z", discord_notified_at: null, spend_problems: [], block_time: null,
  spending_path: SpendingPath.Base, governance_action: null, valid_to_slot: 99, cosign_claimed_at: null, ...overrides,
});

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
const cancel = (headers: Record<string, string> = {}, id = TX) =>
  POST(new Request(`http://localhost/api/tx/${id}/cancel`, { method: "POST", headers }), { params: Promise.resolve({ txId: id }) });

beforeEach(() => {
  vi.resetAllMocks();
  as(ALICE);
  mocks.member.mockResolvedValue("member");
  mocks.cancel.mockResolvedValue(true);
  mocks.onChain.mockResolvedValue(false);
  arrange({});
});

describe("POST /api/tx/[txId]/cancel", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await cancel()).status).toBe(401);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const res = await cancel({ origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("answers 409 when the hash is already on-chain", async () => {
    mocks.onChain.mockResolvedValue(true);
    const res = await cancel();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txAlreadyOnChain);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("refuses cancel of an unsigned pending row", async () => {
    arrange({ tx: tx({ signed_addresses: [] }) });
    const res = await cancel();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(MSG.txNotSigned);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("cancels a signed pending row", async () => {
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canceled: true });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(TX);
  });

  it("answers 409 when the row moved on", async () => {
    mocks.cancel.mockResolvedValue(false);
    const res = await cancel();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txNotPending);
  });

  it("refuses a member who is not a path signer", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    const res = await cancel();
    expect(res.status).toBe(403);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("works for a co-signer treasury path participant", async () => {
    const cosigner = { ...plain, template: TreasuryTemplate.Cosigner, cosigner_kind: CosignerKind.Member };
    const cosignerWallet = "addr_test1cosigner";
    arrange({
      treasury: cosigner,
      signers: [...BASE, signer(cosignerWallet, SignerGroup.Cosigner)],
      tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [ALICE, cosignerWallet] }),
    });
    as(cosignerWallet);
    expect((await cancel()).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(TX);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthzModule from "@/lib/authz";
import { CosignerKind, MSG, SignerGroup, SpendingPath, TreasuryTemplate, TxState } from "@/lib/constants";
import type { TransactionRow, TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

// The prologue (`loadPendingTxForSigner`), the path rules and the threshold
// predicates run for real; only the session, the row reads and the witness
// merge (core-cst) are mocked.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), db: vi.fn(), treasury: vi.fn(), signers: vi.fn(), member: vi.fn(),
  merge: vi.fn(), addSignature: vi.fn(), cosign: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: mocks.db }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasury: mocks.treasury, loadTreasurySigners: mocks.signers }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  requireMember: mocks.member,
}));
vi.mock("@/lib/cardano/txSignUtils", () => ({ mergeSignerWitnesses: mocks.merge }));
vi.mock("@/lib/db/transactions", () => ({ addSignature: mocks.addSignature }));
vi.mock("@/lib/cosigner/sign", () => ({ cosignWithAppKey: mocks.cosign }));

import { POST } from "./route";

const TX = "40000000-0000-4000-8000-000000000001";
const TREASURY_ID = "40000000-0000-4000-8000-000000000002";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const CAROL = "addr_test1carol";
const RECOVERY = "addr_test1recovery";
const COSIGNER = "addr_test1cosigner";
const OUTSIDER = "addr_test1outsider";
const KEY: Record<string, string> = {
  [ALICE]: "a1".repeat(28), [BOB]: "b2".repeat(28), [CAROL]: "c3".repeat(28),
  [RECOVERY]: "d4".repeat(28), [COSIGNER]: "e5".repeat(28),
};
const MERGED = "84a1merged";

const signer = (wallet: string, group: SignerGroup): TreasurySignerRow => ({
  treasury_id: TREASURY_ID, wallet_address: wallet, key_hash: KEY[wallet] ?? "", stake_key_hash: null, display_name: null, signer_group: group,
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
const appCosigner: TreasuryRow = { ...plain, template: TreasuryTemplate.Cosigner, cosigner_kind: CosignerKind.App };
const memberCosigner: TreasuryRow = { ...appCosigner, cosigner_kind: CosignerKind.Member };

const tx = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  id: TX, treasury_id: TREASURY_ID, kind: "payout", tx_cbor: "84a0", tx_hash: "f".repeat(64), description: null,
  signed_addresses: [], rejected_addresses: [], state: TxState.Pending, created_by: ALICE, submitted_at: null,
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

/** Sign as this wallet: the session and a merged payload carrying its key's witness. */
function signAs(wallet: string) {
  mocks.session.mockResolvedValue({ wallet });
  mocks.merge.mockReturnValue({ txHex: MERGED, invalidVkeyPubKeysHex: [], addedKeyHashes: [KEY[wallet] ?? ""] });
}

const post = (body: unknown = { signedPayloadHex: "a100" }, headers: Record<string, string> = {}, id = TX) =>
  POST(new Request(`http://localhost/api/tx/${id}/sign`, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }), { params: Promise.resolve({ txId: id }) });

beforeEach(() => {
  vi.resetAllMocks();
  signAs(ALICE);
  mocks.member.mockResolvedValue("member");
  mocks.addSignature.mockResolvedValue(true);
  mocks.cosign.mockResolvedValue({ signed: true, check: { passed: true, problems: [] } });
  arrange({});
});

describe("POST /api/tx/[txId]/sign", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.treasury).not.toHaveBeenCalled();
    expect(mocks.addSignature).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const res = await post(undefined, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Cross-site request rejected");
    expect(mocks.addSignature).not.toHaveBeenCalled();
  });

  it("rejects a malformed body before reading the transaction", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ signedPayloadHex: "not hex" })).status).toBe(400);
    expect(mocks.treasury).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown transaction, without a lookup for a malformed id", async () => {
    arrange({ tx: null });
    let res = await post();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Transaction not found");
    mocks.db.mockClear();
    res = await post(undefined, {}, "not-a-uuid");
    expect(res.status).toBe(404);
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.addSignature).not.toHaveBeenCalled();
  });

  it("refuses a wallet that is not a member of the treasury's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not a community member");
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, ALICE);
    expect(mocks.addSignature).not.toHaveBeenCalled();
  });

  it("refuses a member who signs nothing on this treasury", async () => {
    signAs(OUTSIDER);
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Caller is not a signer of this treasury");
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("answers 409 once the transaction is no longer pending", async () => {
    arrange({ tx: tx({ state: TxState.Submitted }) });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.txNotPending);
    expect(mocks.addSignature).not.toHaveBeenCalled();
  });

  describe("path participants", () => {
    const clawbackSigners = [...BASE, signer(RECOVERY, SignerGroup.Recovery)];

    it("refuses a recovery signer on a base-path transaction", async () => {
      arrange({ treasury: clawback, signers: clawbackSigners, tx: tx({ spending_path: SpendingPath.Base }) });
      signAs(RECOVERY);
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.addSignature).not.toHaveBeenCalled();
    });

    it("refuses a base signer on a recovery-path transaction", async () => {
      arrange({ treasury: clawback, signers: clawbackSigners, tx: tx({ spending_path: SpendingPath.Recovery }) });
      signAs(ALICE);
      const res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
    });

    it("lets a recovery signer sign a recovery-path transaction", async () => {
      arrange({ treasury: clawback, signers: clawbackSigners, tx: tx({ spending_path: SpendingPath.Recovery }) });
      signAs(RECOVERY);
      const res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedCount: 1, signedAddresses: [RECOVERY] });
      expect(mocks.addSignature).toHaveBeenCalledWith({ txId: TX, wallet: RECOVERY, txCbor: MERGED, expectedCount: 0 });
    });

    it("lets a member co-signer sign a co-signed transaction but not a bypass one", async () => {
      const signers = [...BASE, signer(COSIGNER, SignerGroup.Cosigner)];
      arrange({ treasury: memberCosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [ALICE, BOB] }) });
      signAs(COSIGNER);
      let res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedCount: 3, signedAddresses: [ALICE, BOB, COSIGNER] });
      expect(mocks.addSignature).toHaveBeenCalledWith({ txId: TX, wallet: COSIGNER, txCbor: MERGED, expectedCount: 2 });
      // The co-signer is no participant of the bypass path.
      arrange({ treasury: memberCosigner, signers, tx: tx({ spending_path: SpendingPath.Bypass }) });
      res = await post();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(MSG.notPathSigner);
      expect(mocks.addSignature).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses a wallet that already signed", async () => {
    arrange({ tx: tx({ signed_addresses: [ALICE] }) });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Already signed by this wallet");
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("refuses a witness that does not verify against the transaction body", async () => {
    mocks.merge.mockReturnValue({ txHex: MERGED, invalidVkeyPubKeysHex: ["ff".repeat(32)], addedKeyHashes: [KEY[ALICE]] });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Witness does not verify against the transaction body");
    expect(mocks.merge).toHaveBeenCalledWith("84a0", "a100");
    expect(mocks.addSignature).not.toHaveBeenCalled();
  });

  it("refuses a payload that carries no witness of the caller's own key", async () => {
    mocks.merge.mockReturnValue({ txHex: MERGED, invalidVkeyPubKeysHex: [], addedKeyHashes: [KEY[BOB]] });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Signed payload does not contain your key's witness");
    expect(mocks.addSignature).not.toHaveBeenCalled();
  });

  it("matches the caller's key hash case-insensitively", async () => {
    arrange({ signers: [signer(ALICE, SignerGroup.Base), signer(BOB, SignerGroup.Base), signer(CAROL, SignerGroup.Base)].map((s) =>
      s.wallet_address === ALICE ? { ...s, key_hash: s.key_hash.toUpperCase() } : s) });
    expect((await post()).status).toBe(200);
  });

  it("answers 409 when another signature landed first", async () => {
    mocks.addSignature.mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Another signature landed first. Reload and sign the updated transaction.");
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("appends the signature with the merged cbor, guarded on the count it read, and reports who has signed", async () => {
    arrange({ tx: tx({ signed_addresses: [BOB] }) });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedCount: 2, signedAddresses: [BOB, ALICE] });
    expect(mocks.addSignature).toHaveBeenCalledExactlyOnceWith({ txId: TX, wallet: ALICE, txCbor: MERGED, expectedCount: 1 });
    // A plain treasury has no co-signer: nothing to trigger.
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("never submits: the response only reports the signatures, the browser decides on the submit", async () => {
    arrange({ tx: tx({ signed_addresses: [BOB] }) });
    // A second base signature completes the 2 of 3 rule; the route still only records it.
    const res = await post();
    expect(await res.json()).toEqual({ signedCount: 2, signedAddresses: [BOB, ALICE] });
    expect(mocks.addSignature).toHaveBeenCalledTimes(1);
  });

  describe("app-held co-signer", () => {
    const signers = [...BASE, signer(COSIGNER, SignerGroup.Cosigner)];

    it("does not run the co-signer while the base rule is unmet", async () => {
      arrange({ treasury: appCosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned }) });
      const res = await post();
      expect(await res.json()).toEqual({ signedCount: 1, signedAddresses: [ALICE] });
      expect(mocks.cosign).not.toHaveBeenCalled();
    });

    it("co-signs after the signature that completes the base rule, reporting the app's address too", async () => {
      arrange({ treasury: appCosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [BOB] }) });
      const res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedCount: 3, signedAddresses: [BOB, ALICE, COSIGNER] });
      expect(mocks.cosign).toHaveBeenCalledExactlyOnceWith(TX, "sign");
      // The signer's own append came first and stays guarded on the count it read.
      expect(mocks.addSignature).toHaveBeenCalledExactlyOnceWith({ txId: TX, wallet: ALICE, txCbor: MERGED, expectedCount: 1 });
      expect(mocks.addSignature.mock.invocationCallOrder[0]).toBeLessThan(mocks.cosign.mock.invocationCallOrder[0] ?? 0);
    });

    it("reports only the wallets' signatures when the check refuses", async () => {
      mocks.cosign.mockResolvedValue({ signed: false, check: { passed: false, problems: ["Budget for 2026-10 is over"] } });
      arrange({ treasury: appCosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [BOB] }) });
      const res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedCount: 2, signedAddresses: [BOB, ALICE] });
    });

    it("never fails the signer when the co-signer throws", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.cosign.mockRejectedValue(new Error("key store down"));
      arrange({ treasury: appCosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [BOB] }) });
      const res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedCount: 2, signedAddresses: [BOB, ALICE] });
      expect(error).toHaveBeenCalledWith(`co-signing tx ${TX} after a signature failed`, expect.any(Error));
      error.mockRestore();
    });

    it("leaves a member co-signer to sign on the page", async () => {
      arrange({ treasury: memberCosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [BOB] }) });
      const res = await post();
      expect(await res.json()).toEqual({ signedCount: 2, signedAddresses: [BOB, ALICE] });
      expect(mocks.cosign).not.toHaveBeenCalled();
    });

    it("does not run on the bypass path, nor once the app already signed", async () => {
      arrange({ treasury: appCosigner, signers, tx: tx({ spending_path: SpendingPath.Bypass, signed_addresses: [BOB, CAROL] }) });
      let res = await post();
      expect(await res.json()).toEqual({ signedCount: 3, signedAddresses: [BOB, CAROL, ALICE] });
      arrange({ treasury: appCosigner, signers, tx: tx({ spending_path: SpendingPath.Cosigned, signed_addresses: [BOB, COSIGNER] }) });
      res = await post();
      expect(await res.json()).toEqual({ signedCount: 3, signedAddresses: [BOB, COSIGNER, ALICE] });
      expect(mocks.cosign).not.toHaveBeenCalled();
    });
  });
});

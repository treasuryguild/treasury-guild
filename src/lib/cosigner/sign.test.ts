import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionRow, TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { CosignerKind, CosignTrigger, SignerGroup, SpendingPath, TreasuryTemplate, TxKind, TxState } from "@/lib/constants";
import { BadRequestError, ConflictError, InvariantError, NotFoundError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  insertDecision: vi.fn(), listPending: vi.fn(), loadDecisions: vi.fn(), loadKey: vi.fn(),
  addSignature: vi.fn(),
  loadTreasury: vi.fn(),
  merge: vi.fn(),
  check: vi.fn(),
  address: vi.fn(), decrypt: vi.fn(), witness: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/db/cosigner", () => ({
  insertCosignerDecision: mocks.insertDecision,
  listPendingAppCosignedTransactions: mocks.listPending,
  loadCosignerDecisions: mocks.loadDecisions,
  loadCosignerKey: mocks.loadKey,
}));
vi.mock("@/lib/db/transactions", () => ({ addSignature: mocks.addSignature }));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasuryWithSigners: mocks.loadTreasury }));
vi.mock("@/lib/cardano/txSignUtils", () => ({ mergeSignerWitnesses: mocks.merge }));
vi.mock("@/lib/cosigner/check", () => ({ runCosignerCheck: mocks.check }));
vi.mock("@/lib/cosigner/keys", () => ({ cosignerAddress: mocks.address, decryptSeed: mocks.decrypt, witnessSetHex: mocks.witness }));

import { cosignReadyTransactions, cosignWithAppKey } from "./sign";

const TX_HASH = "a".repeat(64);
const CBOR = "84a0";
const MERGED = "84a1";
const WITNESS = "a100";
const KEY_HASH = "k".repeat(56);
const SEED = new Uint8Array(32);
const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const CAROL = "addr_test1carol";
const COSIGNER = "addr_test1cosigner";

const TREASURY: TreasuryRow = {
  id: "t-1", community_id: "c-1", name: "Main", network: 0, required: 2, script_type: "atLeast",
  address: "addr_test1treasury", script_cbor: "8200", stake_credential_hash: null,
  template: TreasuryTemplate.Cosigner, lock_slot: null, lock_until: null,
  recovery_script_type: null, recovery_required: null, cosigner_kind: CosignerKind.App,
};
const signer = (wallet: string, group: SignerGroup, keyHash = `h-${wallet}`): TreasurySignerRow => ({
  treasury_id: "t-1", wallet_address: wallet, key_hash: keyHash, stake_key_hash: null, display_name: null, signer_group: group,
});
const SIGNERS = [
  signer(ALICE, SignerGroup.Base), signer(BOB, SignerGroup.Base), signer(CAROL, SignerGroup.Base),
  signer(COSIGNER, SignerGroup.Cosigner, KEY_HASH),
];
const KEY = { treasury_id: "t-1", key_hash: KEY_HASH, public_key_hex: "p".repeat(64), encrypted_key: "v1:iv:tag:ct" };

function tx(patch: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: "tx-1", treasury_id: "t-1", kind: TxKind.Payout, tx_cbor: CBOR, tx_hash: TX_HASH, description: null,
    signed_addresses: [ALICE, BOB], rejected_addresses: [], state: TxState.Pending, created_by: ALICE,
    submitted_at: null, created_at: "2026-10-01T00:00:00Z", discord_notified_at: null, spend_problems: [],
    block_time: null, spending_path: SpendingPath.Cosigned, ...patch,
  };
}

/** What `loadTx` finds by id; the list of ids it asked for. */
let txs: Map<string, TransactionRow>;
let loads: string[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  txs = new Map([["tx-1", tx()]]);
  loads = [];
  mocks.from.mockImplementation((table: string) => {
    if (table !== "transactions") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => { loads.push(id); return { data: txs.get(id) ?? null, error: null }; },
        }),
      }),
    };
  });
  mocks.loadTreasury.mockResolvedValue({ treasury: TREASURY, signers: SIGNERS });
  mocks.loadKey.mockResolvedValue(KEY);
  mocks.loadDecisions.mockResolvedValue([]);
  mocks.listPending.mockResolvedValue([]);
  mocks.insertDecision.mockImplementation(async (d: Record<string, unknown>) => ({ id: "d-1", decided_at: "2026-10-01T00:00:00Z", ...d }));
  mocks.check.mockResolvedValue({ passed: true, problems: [] });
  mocks.decrypt.mockReturnValue(SEED);
  mocks.address.mockReturnValue(COSIGNER);
  mocks.witness.mockReturnValue(WITNESS);
  mocks.merge.mockReturnValue({ txHex: MERGED, invalidVkeyPubKeysHex: [], addedKeyHashes: [KEY_HASH] });
  mocks.addSignature.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const nothingSigned = () => {
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.merge).not.toHaveBeenCalled();
  expect(mocks.addSignature).not.toHaveBeenCalled();
  expect(mocks.insertDecision).not.toHaveBeenCalled();
};

describe("cosignWithAppKey: what it refuses to touch", () => {
  it("throws for a transaction that does not exist", async () => {
    await expect(cosignWithAppKey("tx-missing", CosignTrigger.Manual)).rejects.toThrow(NotFoundError);
    nothingSigned();
  });

  it("does not sign a transaction that is no longer pending", async () => {
    txs.set("tx-1", tx({ state: TxState.Submitted }));
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Manual)).rejects.toThrow(new ConflictError("Transaction is no longer pending"));
    nothingSigned();
  });

  it("does not sign a transaction built for another path", async () => {
    txs.set("tx-1", tx({ spending_path: SpendingPath.Bypass }));
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Manual)).rejects.toThrow(BadRequestError);
    nothingSigned();
  });

  it("does not sign for a treasury whose co-signer is a member", async () => {
    mocks.loadTreasury.mockResolvedValue({ treasury: { ...TREASURY, cosigner_kind: CosignerKind.Member }, signers: SIGNERS });
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Manual)).rejects.toThrow(new BadRequestError("This treasury's co-signer is a member, not Guild Vault"));
    nothingSigned();
  });

  it("does not sign without an app key, or with a key another than the co-signer row's", async () => {
    mocks.loadKey.mockResolvedValue(null);
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Manual)).rejects.toThrow(InvariantError);
    mocks.loadKey.mockResolvedValue({ ...KEY, key_hash: "x".repeat(56) });
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Manual)).rejects.toThrow(InvariantError);
    nothingSigned();
  });

  it("does not sign twice", async () => {
    txs.set("tx-1", tx({ signed_addresses: [ALICE, BOB, COSIGNER] }));
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Manual)).rejects.toThrow(new ConflictError("Already co-signed"));
    nothingSigned();
  });

  it("waits for the base rule to be met before running the check", async () => {
    txs.set("tx-1", tx({ signed_addresses: [ALICE] }));
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Sign)).rejects.toThrow(new BadRequestError("The base signers have not finished signing yet"));
    nothingSigned();
  });

  it("counts only base signers towards the base rule", async () => {
    txs.set("tx-1", tx({ signed_addresses: [ALICE, "addr_test1stranger"] }));
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Sign)).rejects.toThrow(BadRequestError);
    nothingSigned();
  });
});

describe("cosignWithAppKey: the decision", () => {
  it("records a refusal with its problems and adds no witness", async () => {
    const check = { passed: false, problems: ["Dev has no budget for 2026-10."] };
    mocks.check.mockResolvedValue(check);
    expect(await cosignWithAppKey("tx-1", CosignTrigger.Manual)).toEqual({ signed: false, check });
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith(tx(), TREASURY);
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.addSignature).not.toHaveBeenCalled();
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith({
      transactionId: "tx-1", trigger: CosignTrigger.Manual, passed: false, problems: ["Dev has no budget for 2026-10."], signed: false,
    });
  });

  it("merges the key's witness on a pass, appends it through add_signature and records the signed decision with its trigger", async () => {
    expect(await cosignWithAppKey("tx-1", CosignTrigger.Sign)).toEqual({ signed: true, check: { passed: true, problems: [] } });
    expect(mocks.decrypt).toHaveBeenCalledExactlyOnceWith(KEY.encrypted_key);
    expect(mocks.address).toHaveBeenCalledExactlyOnceWith(KEY_HASH, 0);
    expect(mocks.witness).toHaveBeenCalledExactlyOnceWith(SEED, TX_HASH);
    expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(CBOR, WITNESS);
    expect(mocks.addSignature).toHaveBeenCalledExactlyOnceWith({ txId: "tx-1", wallet: COSIGNER, txCbor: MERGED, expectedCount: 2 });
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith({
      transactionId: "tx-1", trigger: CosignTrigger.Sign, passed: true, problems: [], signed: true,
    });
    expect(loads).toEqual(["tx-1"]);
  });

  it("retries once against the reloaded row when a wallet's signature landed in between, then reports it unsigned", async () => {
    // The first read saw two signatures; by the time add_signature runs a third landed, so the reload sees three.
    mocks.addSignature.mockImplementation(async () => {
      txs.set("tx-1", tx({ signed_addresses: [ALICE, BOB, CAROL], tx_cbor: "84a2" }));
      return false;
    });
    expect(await cosignWithAppKey("tx-1", CosignTrigger.Sign)).toEqual({ signed: false, check: { passed: true, problems: [] } });
    expect(loads).toEqual(["tx-1", "tx-1"]);
    expect(mocks.addSignature).toHaveBeenCalledTimes(2);
    expect(mocks.addSignature).toHaveBeenNthCalledWith(1, { txId: "tx-1", wallet: COSIGNER, txCbor: MERGED, expectedCount: 2 });
    expect(mocks.addSignature).toHaveBeenNthCalledWith(2, { txId: "tx-1", wallet: COSIGNER, txCbor: MERGED, expectedCount: 3 });
    expect(mocks.merge).toHaveBeenNthCalledWith(2, "84a2", WITNESS);
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith({
      transactionId: "tx-1", trigger: CosignTrigger.Sign, passed: true, problems: [], signed: false,
    });
  });

  it("lands on the retry when the reloaded row still lacks the co-signature", async () => {
    mocks.addSignature.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await cosignWithAppKey("tx-1", CosignTrigger.Sweep)).toEqual({ signed: true, check: { passed: true, problems: [] } });
    expect(mocks.addSignature).toHaveBeenCalledTimes(2);
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ trigger: CosignTrigger.Sweep, signed: true }));
  });

  it("stops retrying when the reload shows the transaction no longer pending or already co-signed", async () => {
    mocks.addSignature.mockImplementation(async () => {
      txs.set("tx-1", tx({ signed_addresses: [ALICE, BOB, COSIGNER] }));
      return false;
    });
    expect(await cosignWithAppKey("tx-1", CosignTrigger.Sign)).toMatchObject({ signed: false });
    expect(mocks.addSignature).toHaveBeenCalledTimes(1);
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ passed: true, signed: false }));
  });

  const failure = (error: string, trigger: CosignTrigger = CosignTrigger.Sign) => ({
    transactionId: "tx-1", trigger, passed: true, problems: [], signed: false, error,
  });

  it("records a signing failure and rethrows, adding no witness, when the witness does not verify", async () => {
    mocks.merge.mockReturnValue({ txHex: MERGED, invalidVkeyPubKeysHex: ["deadbeef"], addedKeyHashes: [] });
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Sign)).rejects.toThrow(new InvariantError("The co-signer's witness does not verify against the transaction"));
    expect(mocks.addSignature).not.toHaveBeenCalled();
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(failure("The co-signer's witness does not verify against the transaction"));
  });

  it("records a signing failure when the merge adds another key than the treasury's co-signer key", async () => {
    mocks.merge.mockReturnValue({ txHex: MERGED, invalidVkeyPubKeysHex: [], addedKeyHashes: ["z".repeat(56)] });
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Manual)).rejects.toThrow(InvariantError);
    expect(mocks.addSignature).not.toHaveBeenCalled();
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(failure("The co-signer's witness does not verify against the transaction", CosignTrigger.Manual));
  });

  it("records a merge failure and rethrows it as it is", async () => {
    mocks.merge.mockImplementation(() => { throw new Error("Invalid cbor"); });
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Sign)).rejects.toThrow("Invalid cbor");
    expect(mocks.addSignature).not.toHaveBeenCalled();
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(failure("Invalid cbor"));
  });

  it("records a key that cannot be decrypted (a missing or wrong key secret)", async () => {
    mocks.decrypt.mockImplementation(() => { throw new Error("COSIGNER_KEY_SECRET is not set"); });
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Sweep)).rejects.toThrow("COSIGNER_KEY_SECRET is not set");
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(failure("COSIGNER_KEY_SECRET is not set", CosignTrigger.Sweep));
  });

  it("refuses to sign when the key's address is not the co-signer row's, and records it", async () => {
    mocks.address.mockReturnValue("addr_test1other");
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Sign)).rejects.toThrow(new InvariantError("The co-signer's address does not match its key"));
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(failure("The co-signer's address does not match its key"));
  });

  it("rethrows the signing failure itself when recording it fails too", async () => {
    mocks.merge.mockImplementation(() => { throw new Error("Invalid cbor"); });
    mocks.insertDecision.mockRejectedValue(new Error("db down"));
    await expect(cosignWithAppKey("tx-1", CosignTrigger.Sign)).rejects.toThrow("Invalid cbor");
    expect(console.error).toHaveBeenCalledExactlyOnceWith("recording the signing failure of tx tx-1 failed", expect.any(Error));
  });

  it("records no signing failure for a refusal or for a signature that simply did not land", async () => {
    mocks.addSignature.mockResolvedValue(false);
    await cosignWithAppKey("tx-1", CosignTrigger.Sign);
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith({
      transactionId: "tx-1", trigger: CosignTrigger.Sign, passed: true, problems: [], signed: false,
    });
  });
});

describe("cosignReadyTransactions", () => {
  const decision = (signed: boolean) => ({
    id: "d-0", transaction_id: "x", decided_at: "2026-09-30T00:00:00Z", trigger: CosignTrigger.Sweep, passed: signed, problems: [], signed, error: null,
  });
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const signingFailure = (minutesAgo: number) => ({
    ...decision(false), passed: true, error: "COSIGNER_KEY_SECRET is not set", decided_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  });

  it("signs the ready ones, re-runs an earlier refusal, skips the rest and keeps going past a failure", async () => {
    const boom = tx({ id: "tx-boom", treasury_id: "t-boom" });
    const ready = tx({ id: "tx-ready" });
    const short = tx({ id: "tx-short", signed_addresses: [ALICE] });
    const done = tx({ id: "tx-done", signed_addresses: [ALICE, BOB, COSIGNER] });
    const signedBefore = tx({ id: "tx-signed-before" });
    const refused = tx({ id: "tx-refused", signed_addresses: [BOB, CAROL] });
    for (const t of [boom, ready, short, done, signedBefore, refused]) txs.set(t.id, t);
    mocks.listPending.mockResolvedValue([boom, ready, short, done, signedBefore, refused]);
    mocks.loadTreasury.mockImplementation(async (treasuryId: string) => {
      if (treasuryId === "t-boom") throw new Error("db down");
      return { treasury: TREASURY, signers: SIGNERS };
    });
    mocks.loadDecisions.mockImplementation(async (txId: string) => {
      if (txId === "tx-signed-before") return [decision(true), decision(false)];
      if (txId === "tx-ready") return [decision(false)];
      return [];
    });
    mocks.check.mockImplementation(async (t: TransactionRow) => (
      t.id === "tx-refused" ? { passed: false, problems: ["Cited proposal #1 did not pass"] } : { passed: true, problems: [] }
    ));

    expect(await cosignReadyTransactions()).toEqual({ signed: 1, refused: 1 });

    expect(mocks.check.mock.calls.map((c) => (c[0] as TransactionRow).id)).toEqual(["tx-ready", "tx-refused"]);
    expect(mocks.addSignature).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ txId: "tx-ready", wallet: COSIGNER }));
    expect(mocks.insertDecision.mock.calls.map((c) => c[0])).toEqual([
      { transactionId: "tx-ready", trigger: CosignTrigger.Sweep, passed: true, problems: [], signed: true },
      { transactionId: "tx-refused", trigger: CosignTrigger.Sweep, passed: false, problems: ["Cited proposal #1 did not pass"], signed: false },
    ]);
    // The base rule and an existing co-signature are checked before any decision is read.
    expect(mocks.loadDecisions.mock.calls.map((c) => c[0])).toEqual(["tx-ready", "tx-signed-before", "tx-refused"]);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("co-signing tx tx-boom in the sweep failed", expect.any(Error));
  });

  it("skips a transaction whose latest decision is a recent signing failure, and retries one older than an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const recent = tx({ id: "tx-recent" });
    const old = tx({ id: "tx-old" });
    const refusedSince = tx({ id: "tx-refused-since" });
    for (const t of [recent, old, refusedSince]) txs.set(t.id, t);
    mocks.listPending.mockResolvedValue([recent, old, refusedSince]);
    mocks.loadDecisions.mockImplementation(async (txId: string) => {
      if (txId === "tx-recent") return [signingFailure(59), decision(false)];
      if (txId === "tx-old") return [signingFailure(61)];
      // A later decision of another kind is what counts, however fresh an earlier failure is.
      return [decision(false), signingFailure(5)];
    });

    expect(await cosignReadyTransactions()).toEqual({ signed: 2, refused: 0 });
    expect(mocks.check.mock.calls.map((c) => (c[0] as TransactionRow).id)).toEqual(["tx-old", "tx-refused-since"]);
    expect(console.error).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps going, signing nothing, when a retried signing still fails", async () => {
    mocks.listPending.mockResolvedValue([tx()]);
    mocks.decrypt.mockImplementation(() => { throw new Error("COSIGNER_KEY_SECRET is not set"); });
    expect(await cosignReadyTransactions()).toEqual({ signed: 0, refused: 0 });
    expect(mocks.insertDecision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ trigger: CosignTrigger.Sweep, error: "COSIGNER_KEY_SECRET is not set" }));
    expect(console.error).toHaveBeenCalledExactlyOnceWith("co-signing tx tx-1 in the sweep failed", expect.any(Error));
  });

  it("does nothing with nothing pending", async () => {
    expect(await cosignReadyTransactions()).toEqual({ signed: 0, refused: 0 });
    expect(mocks.loadTreasury).not.toHaveBeenCalled();
  });

  it("skips a treasury that lost its co-signer row", async () => {
    mocks.listPending.mockResolvedValue([tx()]);
    mocks.loadTreasury.mockResolvedValue({ treasury: TREASURY, signers: SIGNERS.filter((s) => s.signer_group === SignerGroup.Base) });
    expect(await cosignReadyTransactions()).toEqual({ signed: 0, refused: 0 });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

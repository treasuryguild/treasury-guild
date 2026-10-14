import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TxModule from "@/lib/tx";
import { ConflictError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), context: vi.fn(), noPending: vi.fn(), withTx: vi.fn(), due: vi.fn(), record: vi.fn(),
  build: vi.fn(), script: vi.fn(), provider: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  loadBuildContext: mocks.context,
}));
vi.mock("@/lib/db/transactions", () => ({ assertNoPendingTx: mocks.noPending, withTransactionRow: mocks.withTx }));
vi.mock("@/lib/governance/anchorsDue", () => ({ loadDueAnchors: mocks.due }));
vi.mock("@/lib/db/anchors", () => ({ recordProposalAnchors: mocks.record }));
vi.mock("@/lib/cardano/anchorBuilder", () => ({ buildAnchorTx: mocks.build }));
vi.mock("@/lib/treasury", () => ({ resolveTreasuryScript: mocks.script }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));

import { POST } from "./route";

const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
const TREASURY = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";
const HASH = "f".repeat(64);
const context = { params: Promise.resolve({}) };
const request = (body: object, headers: Record<string, string> = {}) => new Request("http://localhost/api/tx/build-anchor", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
});
const post = (body: object = { treasuryId: TREASURY_ID }, headers?: Record<string, string>) => POST(request(body, headers), context);

const plainTreasury = {
  id: TREASURY_ID, community_id: "community", address: TREASURY, network: 0,
  template: "plain", script_type: "atLeast", required: 2, lock_slot: null, lock_until: null,
  recovery_script_type: null, recovery_required: null, cosigner_kind: null,
};
const buildContext = (overrides: object = {}) => ({
  treasury: plainTreasury, signers: [], role: "member", isSigner: true, callerGroups: new Set(["base"]),
  communitySlug: "signius", network: 0, ...overrides,
});
const anchor = (proposalId: string, number: number, step: string) => ({
  proposalId, number, step, entry: step === "proposed" ? [number, "proposed", "a".repeat(64), "b".repeat(64)] : [number, "opened", "c".repeat(64)],
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1signer" });
  mocks.context.mockResolvedValue(buildContext());
  mocks.noPending.mockResolvedValue(undefined);
  mocks.due.mockResolvedValue([anchor("p1", 3, "proposed"), anchor("p1", 3, "opened"), anchor("p2", 7, "proposed")]);
  mocks.script.mockReturnValue({ address: TREASURY, scriptCbor: "00" });
  mocks.provider.mockReturnValue({});
  mocks.build.mockResolvedValue({ unsignedTxHex: "84a0", txHash: HASH });
  mocks.withTx.mockImplementation(async (_row: unknown, fn: (tx: { id: string }) => Promise<unknown>) => fn({ id: "tx-1" }));
  mocks.record.mockResolvedValue(3);
});

describe("POST /api/tx/build-anchor", () => {
  it("requires a session and refuses a cross-site request", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect((await post({ treasuryId: TREASURY_ID }, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await post({ treasuryId: "nope" })).status).toBe(400);
    expect((await post({ treasuryId: TREASURY_ID, path: "sideways" })).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("refuses a member who is neither an admin nor a base signer", async () => {
    mocks.context.mockResolvedValue(buildContext({ isSigner: false, callerGroups: new Set(["recovery"]) }));
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/build an anchor transaction/);
    expect(mocks.noPending).not.toHaveBeenCalled();
  });

  it("refuses the recovery path: anchors are never a recovery payment", async () => {
    mocks.context.mockResolvedValue(buildContext({
      treasury: { ...plainTreasury, template: "clawback", recovery_script_type: "any", recovery_required: 1, lock_slot: 1, lock_until: "2020-01-01T00:00:00.000Z" },
      role: "admin",
    }));
    const res = await post({ treasuryId: TREASURY_ID, path: "recovery" });
    expect(res.status).toBe(400);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("refuses a lock-until treasury before its date", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    mocks.context.mockResolvedValue(buildContext({ treasury: { ...plainTreasury, template: "lock_until", lock_slot: 99, lock_until: future } }));
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/locked until/);
  });

  it("passes on the one-pending-transaction conflict", async () => {
    mocks.noPending.mockRejectedValue(new ConflictError("A pending transaction already exists for this treasury. Submit or reject it first."));
    expect((await post()).status).toBe(409);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("answers 400 when nothing is due", async () => {
    mocks.due.mockResolvedValue([]);
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No anchors are due");
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("builds a fee-only transaction carrying the due anchors and links them inside the row insert", async () => {
    mocks.withTx.mockImplementation(async (row: Record<string, unknown>, fn: (tx: { id: string }) => Promise<unknown>) => {
      expect(row).toMatchObject({
        treasury_id: TREASURY_ID, kind: "anchor", spending_path: "base", tx_cbor: "84a0", tx_hash: HASH,
        description: "Anchors: proposals #3, #7", created_by: "addr_test1signer",
      });
      expect(mocks.record).not.toHaveBeenCalled();
      return fn({ id: "tx-1" });
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txId: "tx-1", txHash: HASH, proposals: [3, 7], remaining: 0 });
    expect(mocks.due).toHaveBeenCalledWith("community");
    const built = mocks.build.mock.calls[0]?.[0];
    expect(built).toMatchObject({ treasuryAddress: TREASURY, scriptCbor: "00", network: 0, validFromSlot: null });
    expect(built.message).toMatch(/^Treasury Guild anchors: signius \d{4}-\d{2}-\d{2}, 2 proposals$/);
    expect(built.record).toMatchObject({ v: 1, src: "treasury-guild", c: "signius" });
    expect(built.record.a).toHaveLength(3);
    expect(mocks.record).toHaveBeenCalledWith("tx-1", expect.arrayContaining([expect.objectContaining({ proposalId: "p1", step: "opened" })]));
  });

  it("sets the validity start to the lock slot of an open lock-until treasury", async () => {
    mocks.context.mockResolvedValue(buildContext({ treasury: { ...plainTreasury, template: "lock_until", lock_slot: 4242, lock_until: "2020-01-01T00:00:00.000Z" } }));
    expect((await post()).status).toBe(200);
    expect(mocks.build.mock.calls[0]?.[0].validFromSlot).toBe(4242);
  });

  it("uses the requested co-signed path on a co-signer treasury and records it on the row", async () => {
    mocks.context.mockResolvedValue(buildContext({ treasury: { ...plainTreasury, template: "cosigner", cosigner_kind: "app" } }));
    await post({ treasuryId: TREASURY_ID, path: "cosigned" });
    expect(mocks.withTx.mock.calls[0]?.[0]).toMatchObject({ spending_path: "cosigned" });
  });
});

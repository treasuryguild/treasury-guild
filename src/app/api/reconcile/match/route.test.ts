import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), member: vi.fn(), incoming: vi.fn(), payout: vi.fn(), adjust: vi.fn(), record: vi.fn(),
  reconcileTask: vi.fn(), signer: vi.fn(), suggest: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/incoming", () => ({
  loadIncomingWithTreasury: mocks.incoming, loadPayoutTreasury: mocks.payout,
  markPayoutAdjusted: mocks.adjust, recordReconciliation: mocks.record,
}));
vi.mock("@/lib/db/tasks", () => ({ markTaskReconciled: mocks.reconcileTask }));
vi.mock("@/lib/db/treasuries", () => ({ isTreasurySigner: mocks.signer }));
vi.mock("@/lib/reconciliation/match", () => ({ suggestMatches: mocks.suggest }));
import { GET, POST } from "./route";

const WALLET = "addr_test1signer";
const TX_HASH = "ab".repeat(32);
const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_TREASURY_ID = "40000000-0000-4000-8000-000000000002";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const PAYOUT_ID = "80000000-0000-4000-8000-000000000001";
const TASK_ID = "60000000-0000-4000-8000-000000000001";
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";

const context = { params: Promise.resolve({}) };
const get = (query: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/reconcile/match${query}`, { method: "GET", headers }), context);
const post = (body: object, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/reconcile/match", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }), context);
const body = (overrides: object = {}) => ({ txHash: TX_HASH, payoutId: PAYOUT_ID, amount: "2500000", ...overrides });

const incoming = (overrides: object = {}) => ({
  tx_hash: TX_HASH, treasury_id: TREASURY_ID, from_addresses: [ALICE], amount_lovelace: "2500000", assets: null,
  block_time: "2026-08-01T00:00:00Z", matched: false, incoming_type: "refund", requires_reconciliation: true,
  note: null, from_treasury_id: null, funding_source_id: null, funding_commitment_id: null,
  treasuries: { id: TREASURY_ID, community_id: COMMUNITY },
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.incoming.mockResolvedValue(incoming());
  mocks.signer.mockResolvedValue(true);
  mocks.payout.mockResolvedValue({ task_id: TASK_ID, treasury_id: TREASURY_ID });
  mocks.record.mockResolvedValue(undefined);
  mocks.adjust.mockResolvedValue(undefined);
  mocks.reconcileTask.mockResolvedValue(undefined);
  mocks.suggest.mockResolvedValue([]);
});

describe("GET /api/reconcile/match", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get(`?txHash=${TX_HASH}`)).status).toBe(401);
    expect(mocks.incoming).not.toHaveBeenCalled();
  });

  it("validates the hash", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?txHash=nope")).status).toBe(400);
    expect(mocks.incoming).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown inflow", async () => {
    mocks.incoming.mockRejectedValue(new NotFoundError("Incoming transaction not found"));
    expect((await get(`?txHash=${TX_HASH}`)).status).toBe(404);
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("requires a member of the receiving treasury's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await get(`?txHash=${TX_HASH}`)).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it("returns the ranked suggestions for the inflow; a GET is never cross-site checked", async () => {
    const suggestions = [{ payoutId: PAYOUT_ID, taskId: TASK_ID, taskTitle: "Fix login", contributorWallet: ALICE, unit: "lovelace", amount: "2500000", score: 150 }];
    mocks.suggest.mockResolvedValue(suggestions);
    const response = await get(`?txHash=${TX_HASH}`, { origin: "https://evil.test" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions });
    expect(mocks.incoming).toHaveBeenCalledWith(TX_HASH);
    expect(mocks.suggest).toHaveBeenCalledWith(expect.objectContaining({ tx_hash: TX_HASH, treasury_id: TREASURY_ID }));
  });
});

describe("POST /api/reconcile/match", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post(body())).status).toBe(401);
    expect(mocks.incoming).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post(body(), { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("validates the body before loading anything", async () => {
    expect((await post(body({ txHash: "nope" }))).status).toBe(400);
    expect((await post(body({ amount: "2.5" }))).status).toBe(400);
    expect((await post(body({ amount: "" }))).status).toBe(400);
    expect((await post(body({ payoutId: "nope" }))).status).toBe(400);
    expect((await post(body({ note: "x".repeat(501) }))).status).toBe(400);
    expect((await post({ txHash: TX_HASH })).status).toBe(400);
    expect(mocks.incoming).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown inflow", async () => {
    mocks.incoming.mockRejectedValue(new NotFoundError("Incoming transaction not found"));
    expect((await post(body())).status).toBe(404);
    expect(mocks.member).not.toHaveBeenCalled();
  });

  it("requires a member of the community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await post(body())).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("conflicts when the inflow needs no reconciliation", async () => {
    mocks.incoming.mockResolvedValue(incoming({ requires_reconciliation: false }));
    const response = await post(body());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "This incoming transaction does not require reconciliation", conflict: true });
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("conflicts when the inflow is already reconciled", async () => {
    mocks.incoming.mockResolvedValue(incoming({ matched: true }));
    const response = await post(body());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "This incoming transaction is already reconciled", conflict: true });
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("lets only the treasury's base signers reconcile", async () => {
    mocks.signer.mockResolvedValue(false);
    const response = await post(body());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only treasury signers can reconcile" });
    expect(mocks.signer).toHaveBeenCalledWith(TREASURY_ID, WALLET);
    expect(mocks.payout).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a payout that does not exist or that another treasury paid", async () => {
    mocks.payout.mockResolvedValue(null);
    let response = await post(body());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Payout not found for this treasury" });
    expect(mocks.payout).toHaveBeenCalledWith(PAYOUT_ID);

    mocks.payout.mockResolvedValue({ task_id: TASK_ID, treasury_id: OTHER_TREASURY_ID });
    response = await post(body());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Payout not found for this treasury" });
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.adjust).not.toHaveBeenCalled();
    expect(mocks.reconcileTask).not.toHaveBeenCalled();
  });

  it("records the match against the payout, adjusts it and settles its task", async () => {
    const response = await post(body({ unit: `${"a".repeat(56)}47565454`, note: "  partial refund  " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith({
      txHash: TX_HASH, payoutId: PAYOUT_ID, amount: "2500000", unit: `${"a".repeat(56)}47565454`,
      note: "partial refund", createdBy: WALLET,
    });
    expect(mocks.adjust).toHaveBeenCalledExactlyOnceWith(PAYOUT_ID);
    expect(mocks.reconcileTask).toHaveBeenCalledExactlyOnceWith(TASK_ID);
  });

  it("records a match without a payout in lovelace, touching no payout or task", async () => {
    for (const overrides of [{ payoutId: null }, { payoutId: undefined }]) {
      vi.clearAllMocks();
      const response = await post(body({ ...overrides, unit: "", note: "   " }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.payout).not.toHaveBeenCalled();
      expect(mocks.record).toHaveBeenCalledExactlyOnceWith({
        txHash: TX_HASH, payoutId: null, amount: "2500000", unit: "lovelace", note: null, createdBy: WALLET,
      });
      expect(mocks.adjust).not.toHaveBeenCalled();
      expect(mocks.reconcileTask).not.toHaveBeenCalled();
    }
  });
});

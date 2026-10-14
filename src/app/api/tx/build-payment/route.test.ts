import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TxModule from "@/lib/tx";
import type * as SpendGuardModule from "@/lib/governance/spendGuard";
import { ConflictError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), context: vi.fn(), noPending: vi.fn(), withTx: vi.fn(),
  wallet: vi.fn(), siblings: vi.fn(), members: vi.fn(), setups: vi.fn(), sources: vi.fn(),
  insert: vi.fn(), build: vi.fn(), script: vi.fn(), provider: vi.fn(),
  citations: vi.fn(), budgetProposal: vi.fn(), guard: vi.fn(), dueAnchors: vi.fn(), recordAnchors: vi.fn(),
}));
vi.mock("@/lib/governance/anchorsDue", () => ({ loadDueAnchorsBestEffort: mocks.dueAnchors }));
vi.mock("@/lib/db/anchors", () => ({ recordProposalAnchors: mocks.recordAnchors }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  loadBuildContext: mocks.context,
}));
vi.mock("@/lib/db/transactions", () => ({ assertNoPendingTx: mocks.noPending, withTransactionRow: mocks.withTx }));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.wallet }));
vi.mock("@/lib/db/payments", () => ({
  loadSiblingTreasuries: mocks.siblings, loadMemberLabels: mocks.members, insertPayments: mocks.insert,
}));
vi.mock("@/lib/db/budgetSetups", () => ({ loadBudgetSetupsForTreasury: mocks.setups, loadBudgetSources: mocks.sources }));
vi.mock("@/lib/db/governance", () => ({
  loadProposalCitations: mocks.citations, loadAppliedBudgetProposal: mocks.budgetProposal,
}));
vi.mock("@/lib/governance/spendGuard", async (importOriginal) => ({
  ...(await importOriginal<typeof SpendGuardModule>()),
  guardSpend: mocks.guard,
}));
vi.mock("@/lib/cardano/paymentBuilder", () => ({ buildPaymentTx: mocks.build }));
vi.mock("@/lib/treasury", () => ({ resolveTreasuryScript: mocks.script }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));
import { POST } from "./route";

const GVTT = `${"a".repeat(56)}47565454`;
const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
const DEV_ID = "40000000-0000-4000-8000-000000000002";
// Well-formed preprod enterprise addresses (random key hashes) so the schema's address check passes.
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const OUTSIDE = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const DEV = "addr_test1vr9mtjy7453pue4fs0d6qmwwenvf6z2zay0a6a9vj3n7eeqdurjp6";
const TREASURY = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";

const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/tx/build-payment", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const body = (overrides: object = {}) => ({
  treasuryId: TREASURY_ID, budgetMonth: "2026-08", memo: "Design invoice",
  recipients: [
    { address: ALICE, amounts: { lovelace: "2.5", [GVTT]: "10" } },
    { address: OUTSIDE, amounts: { lovelace: "1" } },
    { address: DEV, amounts: { [GVTT]: "5" } },
  ],
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.context.mockResolvedValue({
    treasury: { id: TREASURY_ID, community_id: "community", address: TREASURY, network: 0 },
    signers: [], role: "member", isSigner: true, communitySlug: "guild", network: 0,
  });
  mocks.noPending.mockResolvedValue(undefined);
  mocks.wallet.mockResolvedValue({ lovelace: 100_000_000n, utxoCount: 2, tokens: [
    { unit: GVTT, quantity: 1_000_000_000n, ticker: "GVTT", name: "Test Token", decimals: 6, source: "registry" },
  ] });
  mocks.siblings.mockResolvedValue([{ id: DEV_ID, name: "Dev wallet", address: DEV }]);
  mocks.members.mockResolvedValue(new Map([[ALICE, "alice"]]));
  mocks.setups.mockResolvedValue([{ starts_on: "2026-01-01", cadence: "quarterly" }]);
  mocks.sources.mockResolvedValue({ setups: new Map(), plans: [] });
  mocks.citations.mockResolvedValue(new Map());
  mocks.budgetProposal.mockResolvedValue(null);
  mocks.guard.mockResolvedValue([]);
  mocks.script.mockReturnValue({ address: TREASURY, scriptCbor: "00" });
  mocks.provider.mockReturnValue({});
  mocks.build.mockResolvedValue({
    unsignedTxHex: "84a0", txHash: "f".repeat(64),
    outputs: [{ address: ALICE, assets: [{ unit: "lovelace", quantity: 2_500_000n }] }],
    totalByUnit: new Map([["lovelace", 3_500_000n], [GVTT, 15_000_000n]]),
    anchorsCarried: [],
  });
  mocks.withTx.mockImplementation(async (_row: unknown, fn: (tx: { id: string }) => Promise<unknown>) => fn({ id: "tx-1" }));
  mocks.insert.mockResolvedValue(undefined);
  mocks.dueAnchors.mockResolvedValue([]);
  mocks.recordAnchors.mockResolvedValue(0);
});

describe("build-payment API", () => {
  it("hands the community's due anchors to the builder and links the ones it carried, inside the row insert", async () => {
    const due = [
      { proposalId: "p1", number: 1, step: "proposed", entry: [1, "proposed", "a".repeat(64), "b".repeat(64)] },
      { proposalId: "p2", number: 2, step: "opened", entry: [2, "opened", "c".repeat(64)] },
    ];
    mocks.dueAnchors.mockResolvedValue(due);
    mocks.build.mockResolvedValue({ ...(await mocks.build()), anchorsCarried: [due[0]] });
    const response = await POST(request(body()), context);
    expect(response.status).toBe(200);
    expect(mocks.dueAnchors).toHaveBeenCalledWith("community");
    expect(mocks.build).toHaveBeenLastCalledWith(expect.objectContaining({ anchors: due }));
    expect(mocks.recordAnchors).toHaveBeenCalledExactlyOnceWith("tx-1", [due[0]]);
    // Nothing due: the builder gets an empty list and nothing is linked.
    mocks.dueAnchors.mockResolvedValue([]);
    mocks.build.mockResolvedValue({ ...(await mocks.build()), anchorsCarried: [] });
    await POST(request(body()), context);
    expect(mocks.recordAnchors).toHaveBeenLastCalledWith("tx-1", []);
  });

  it("builds one tx, stamps spend with the quarter-aligned month and leaves transfers unstamped", async () => {
    const response = await POST(request(body()), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ txId: "tx-1", txHash: "f".repeat(64), totalByUnit: { lovelace: "3500000", [GVTT]: "15000000" } });
    expect(mocks.noPending).toHaveBeenCalledWith(TREASURY_ID);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
      communitySlug: "guild", budgetPeriod: "2026-Q3", memo: "Design invoice", scriptCbor: "00",
      recipients: [
        { address: ALICE, treasuryId: null, label: "alice", amounts: [{ unit: "lovelace", quantity: 2_500_000n }, { unit: GVTT, quantity: 10_000_000n }] },
        { address: OUTSIDE, treasuryId: null, label: null, amounts: [{ unit: "lovelace", quantity: 1_000_000n }] },
        { address: DEV, treasuryId: DEV_ID, label: "Dev wallet", amounts: [{ unit: GVTT, quantity: 5_000_000n }] },
      ],
    }));
    expect(mocks.withTx).toHaveBeenCalledWith(expect.objectContaining({
      treasury_id: TREASURY_ID, kind: "payment", tx_hash: "f".repeat(64), created_by: "admin",
      description: "Payment: Design invoice, 3 recipients (ADA, GVTT)", spend_problems: [],
    }), expect.any(Function));
    // The spend lines: the two spend outputs per unit, aligned to the quarter; the transfer is no line.
    expect(mocks.guard).toHaveBeenCalledWith("community", [
      expect.objectContaining({ ownerKey: `t:${TREASURY_ID}`, periodMonth: "2026-07", unit: "lovelace", amount: 2_500_000n, ticker: "ADA" }),
      expect.objectContaining({ ownerKey: `t:${TREASURY_ID}`, periodMonth: "2026-07", unit: GVTT, amount: 10_000_000n, ticker: "GVTT" }),
      expect.objectContaining({ ownerKey: `t:${TREASURY_ID}`, periodMonth: "2026-07", unit: "lovelace", amount: 1_000_000n }),
    ], { setups: new Map(), plans: [] });
    expect(mocks.insert).toHaveBeenCalledWith([
      { transaction_id: "tx-1", community_id: "community", treasury_id: TREASURY_ID, recipient_wallet: ALICE, recipient_treasury_id: null, label: "alice", unit: "lovelace", amount: "2500000", budget_month: "2026-07-01" },
      { transaction_id: "tx-1", community_id: "community", treasury_id: TREASURY_ID, recipient_wallet: ALICE, recipient_treasury_id: null, label: "alice", unit: GVTT, amount: "10000000", budget_month: "2026-07-01" },
      { transaction_id: "tx-1", community_id: "community", treasury_id: TREASURY_ID, recipient_wallet: OUTSIDE, recipient_treasury_id: null, label: null, unit: "lovelace", amount: "1000000", budget_month: "2026-07-01" },
      { transaction_id: "tx-1", community_id: "community", treasury_id: TREASURY_ID, recipient_wallet: DEV, recipient_treasury_id: DEV_ID, label: "Dev wallet", unit: GVTT, amount: "5000000", budget_month: null },
    ]);
  });

  it("refuses members who are neither admins nor signers", async () => {
    mocks.context.mockResolvedValue({
      treasury: { id: TREASURY_ID, community_id: "community", address: TREASURY, network: 0 },
      signers: [], role: "member", isSigner: false, communitySlug: "guild", network: 0,
    });
    const response = await POST(request(body()), context);
    expect(response.status).toBe(403);
    expect(mocks.noPending).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("lists every recipient problem without building", async () => {
    const response = await POST(request(body({ recipients: [
      { address: TREASURY, amounts: { lovelace: "1" } },
      { address: OUTSIDE, amounts: { [`${"b".repeat(56)}00`]: "1" } },
    ] })), context);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Some recipients cannot be paid");
    expect(json.problems).toHaveLength(2);
    expect(json.problems[0]).toContain("paying treasury itself");
    expect(json.problems[1]).toContain("not held by this treasury");
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.withTx).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies before touching the chain", async () => {
    expect((await POST(request(body({ recipients: [] })), context)).status).toBe(400);
    expect((await POST(request(body({ budgetMonth: "2026-13" })), context)).status).toBe(400);
    expect((await POST(request(body({ recipients: [{ address: "nope", amounts: { lovelace: "1" } }] })), context)).status).toBe(400);
    expect((await POST(request(body({ recipients: [{ address: ALICE, amounts: { lovelace: "-1" } }] })), context)).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("cites the budget proposal that set the period's budget, and a named applied budget proposal", async () => {
    const HASH = "ab".repeat(32);
    const budgetProposal = "40000000-0000-4000-8000-000000000009";
    const named = "40000000-0000-4000-8000-000000000010";
    mocks.sources.mockResolvedValue({
      setups: new Map([[`t:${TREASURY_ID}`, [{
        id: "s1", owner_key: `t:${TREASURY_ID}`, starts_on: "2026-01-01", mode: "recurring", cadence: "quarterly",
        amounts: [{ unit: "lovelace", amount: "100000000", asset_label: "ADA", decimals: 6 }], proposal_id: budgetProposal,
      }]]]),
      plans: [],
    });
    mocks.budgetProposal.mockResolvedValue({ id: named, number: 9, content_hash: "cd".repeat(32) });
    mocks.citations.mockResolvedValue(new Map([
      [budgetProposal, { id: budgetProposal, number: 4, content_hash: HASH }],
      [named, { id: named, number: 9, content_hash: "cd".repeat(32) }],
    ]));
    mocks.guard.mockResolvedValue([{ code: "over_budget", ownerKey: `t:${TREASURY_ID}`, ownerName: "Treasury: T", period: "2026-Q3" }]);
    const response = await POST(request(body({ proposalId: named })), context);
    expect(response.status).toBe(200);
    expect(mocks.budgetProposal).toHaveBeenCalledWith("community", named);
    expect(mocks.citations).toHaveBeenCalledWith([budgetProposal, named]);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
      citations: [{ number: 4, contentHash: HASH }, { number: 9, contentHash: "cd".repeat(32) }],
    }));
    // Warn mode: the problems ride on the transaction row.
    expect(mocks.withTx).toHaveBeenCalledWith(expect.objectContaining({
      spend_problems: [expect.objectContaining({ code: "over_budget" })],
    }), expect.any(Function));
  });

  it("refuses a named proposal that is not an applied budget proposal of the community", async () => {
    mocks.budgetProposal.mockResolvedValue(null);
    const response = await POST(request(body({ proposalId: "40000000-0000-4000-8000-000000000010" })), context);
    expect(response.status).toBe(400);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("surfaces a pending transaction as a conflict", async () => {
    mocks.noPending.mockRejectedValue(new ConflictError("A pending transaction already exists for this treasury."));
    const response = await POST(request(body()), context);
    expect(response.status).toBe(409);
    expect(mocks.build).not.toHaveBeenCalled();
  });
});

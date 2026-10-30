// planPayout's checks are exercised through POST /api/tx/build-payout (the
// route is planPayout + persistPayout); this covers what only the agent API's
// payout confirm reaches: persistPayout keyed by a draft, and its writes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTx: vi.fn(), insertPayouts: vi.fn(), upsertMappings: vi.fn(),
  stampMonth: vi.fn(), queue: vi.fn(), recordAnchors: vi.fn(),
}));
vi.mock("@/lib/db/transactions", () => ({ assertNoPendingTx: vi.fn(), withTransactionRow: mocks.withTx, insertPayouts: mocks.insertPayouts }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: vi.fn(), upsertAssetMappings: mocks.upsertMappings }));
vi.mock("@/lib/db/tasks", () => ({
  loadTasksForBuild: vi.fn(), tasksWithLivePayouts: vi.fn(), claimTasksForPayout: mocks.queue, setBudgetMonthIfNull: mocks.stampMonth,
}));
vi.mock("@/lib/db/anchors", () => ({ recordProposalAnchors: mocks.recordAnchors }));
vi.mock("@/lib/db/budgetSetups", () => ({}));
vi.mock("@/lib/db/workgroupRouting", () => ({}));
vi.mock("@/lib/db/governance", () => ({}));
vi.mock("@/lib/governance/anchorsDue", () => ({}));
vi.mock("@/lib/cardano/walletAssets", () => ({}));
vi.mock("@/lib/cardano/payoutBuilder", () => ({}));
vi.mock("@/lib/cardano/provider", () => ({}));

import { persistPayout, type PayoutPlan } from "./build";

const GVTT = `${"a".repeat(56)}47565454`;
const DRAFT = "d0000000000040008000000000000001";

/** Two tasks: A (unset month, paid to Alice and Bob) and B (set month, Alice), plus C (unset, another quarter). */
function plan(overrides: Partial<PayoutPlan> = {}): PayoutPlan {
  const taskA = { id: "task-a", budget_month: null };
  const taskB = { id: "task-b", budget_month: "2026-05-01" };
  const taskC = { id: "task-c", budget_month: null };
  return {
    treasuryId: "treasury-1",
    ctx: { treasury: { community_id: "community" } },
    path: "base",
    tasks: [taskA, taskB, taskC],
    periods: new Map([
      ["task-a", { month: "2026-07", code: "2026-Q3" }],
      ["task-b", { month: "2026-05", code: "2026-05" }],
      ["task-c", { month: "2026-04", code: "2026-Q2" }],
    ]),
    recipients: [
      { contributorWallet: "alice", tasks: [
        { taskId: "task-a", amounts: [{ unit: "lovelace", quantity: 2_500_000n }, { unit: GVTT, quantity: 10_000_000n }] },
        { taskId: "task-b", amounts: [{ unit: "lovelace", quantity: 1_000_000n }] },
      ] },
      { contributorWallet: "bob", tasks: [
        { taskId: "task-a", amounts: [{ unit: "lovelace", quantity: 2_500_000n }, { unit: GVTT, quantity: 10_000_000n }] },
        { taskId: "task-c", amounts: [{ unit: "lovelace", quantity: 3_000_000n }] },
      ] },
    ],
    payments: 4,
    unitDisplay: new Map([[GVTT, { ticker: "GVTT", decimals: 6 }]]),
    spendProblems: [],
    built: { unsignedTxHex: "84a0", txHash: "f".repeat(64), totalByUnit: new Map([["lovelace", 9_000_000n], [GVTT, 20_000_000n]]) },
    carried: [{ proposalId: "p-1", step: "proposed" }],
    mappings: [{ fieldName: "GVTT", unit: GVTT, decimals: 6 }],
    ...overrides,
  } as unknown as PayoutPlan;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.withTx.mockImplementation(async (row: object, fn: (tx: object) => Promise<unknown>) => fn({ id: "tx-1", ...row }));
});

describe("persistPayout", () => {
  it("stores the pending payout without a draft id when the route builds it", async () => {
    const tx = await persistPayout(plan(), "admin");
    expect(tx).toMatchObject({ id: "tx-1", treasury_id: "treasury-1", kind: "payout", spending_path: "base", created_by: "admin" });
    const [row] = mocks.withTx.mock.calls[0]!;
    expect(row).not.toHaveProperty("agent_draft_id");
    expect(row).toMatchObject({ tx_cbor: "84a0", tx_hash: "f".repeat(64), spend_problems: [] });
  });

  it("keys the row by the agent API draft when one is given", async () => {
    await persistPayout(plan(), "admin", { agentDraftId: DRAFT });
    expect(mocks.withTx.mock.calls[0]![0]).toMatchObject({ agent_draft_id: DRAFT });
  });

  it("remembers the token mappings before inserting the row", async () => {
    await persistPayout(plan(), "admin");
    expect(mocks.upsertMappings).toHaveBeenCalledExactlyOnceWith("community", [{ fieldName: "GVTT", unit: GVTT, decimals: 6 }]);
    expect(mocks.upsertMappings.mock.invocationCallOrder[0]).toBeLessThan(mocks.withTx.mock.invocationCallOrder[0]!);
  });

  it("writes one payouts row per (task, wallet, unit), stamps unset months grouped by period, claims the tasks and links the anchors", async () => {
    await persistPayout(plan(), "admin");
    expect(mocks.queue).toHaveBeenCalledExactlyOnceWith("tx-1", ["task-a", "task-b", "task-c"]);
    expect(mocks.insertPayouts).toHaveBeenCalledExactlyOnceWith([
      { transaction_id: "tx-1", task_id: "task-a", contributor_wallet: "alice", unit: "lovelace", amount: "2500000" },
      { transaction_id: "tx-1", task_id: "task-a", contributor_wallet: "alice", unit: GVTT, amount: "10000000" },
      { transaction_id: "tx-1", task_id: "task-b", contributor_wallet: "alice", unit: "lovelace", amount: "1000000" },
      { transaction_id: "tx-1", task_id: "task-a", contributor_wallet: "bob", unit: "lovelace", amount: "2500000" },
      { transaction_id: "tx-1", task_id: "task-a", contributor_wallet: "bob", unit: GVTT, amount: "10000000" },
      { transaction_id: "tx-1", task_id: "task-c", contributor_wallet: "bob", unit: "lovelace", amount: "3000000" },
    ]);
    // task-b already has a month: never restamped.
    expect(mocks.stampMonth.mock.calls).toEqual([[["task-a"], "2026-07"], [["task-c"], "2026-04"]]);
    expect(mocks.recordAnchors).toHaveBeenCalledExactlyOnceWith("tx-1", [{ proposalId: "p-1", step: "proposed" }]);
  });

  it("lets a failed claim propagate before payouts, so withTransactionRow deletes the row again", async () => {
    mocks.queue.mockRejectedValue(new Error("claim failed"));
    await expect(persistPayout(plan(), "admin", { agentDraftId: DRAFT })).rejects.toThrow("claim failed");
    expect(mocks.insertPayouts).not.toHaveBeenCalled();
    expect(mocks.recordAnchors).not.toHaveBeenCalled();
  });
});

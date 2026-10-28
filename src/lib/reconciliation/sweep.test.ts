import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  registry: vi.fn(),
  purgeOAuth: vi.fn(),
  purgeNonces: vi.fn(),
  purgeRateLimits: vi.fn(),
  purgeInvites: vi.fn(),
  notifyPayouts: vi.fn(),
  notifyProposals: vi.fn(),
  writeBack: vi.fn(),
  advance: vi.fn(),
  syncTreasury: vi.fn(),
  freeze: vi.fn(),
  publish: vi.fn(),
  notifyAnchors: vi.fn(),
  notifyOutside: vi.fn(),
  cosign: vi.fn(),
  releaseOrphans: vi.fn(),
}));
// db/client re-exports this client; its real rows / maybe / check unwrap the results.
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry }));
vi.mock("@/lib/db/oauth", () => ({ purgeOAuth: mocks.purgeOAuth }));
vi.mock("@/lib/db/auth", () => ({ purgeExpiredNonces: mocks.purgeNonces }));
vi.mock("@/lib/db/rateLimit", () => ({ purgeRateLimits: mocks.purgeRateLimits }));
vi.mock("@/lib/db/invites", () => ({ purgeCommunityInvites: mocks.purgeInvites }));
vi.mock("@/lib/db/tasks", () => ({ releaseOrphanedQueuedTasks: mocks.releaseOrphans }));
vi.mock("@/lib/discord/notifyPayouts", () => ({ notifyConfirmedPayouts: mocks.notifyPayouts }));
vi.mock("@/lib/discord/notifyProposals", () => ({ notifyProposalMilestones: mocks.notifyProposals }));
vi.mock("@/lib/github/writeback", () => ({ writeBackPayment: mocks.writeBack }));
vi.mock("@/lib/governance/advance", () => ({ advanceDueProposals: mocks.advance }));
vi.mock("@/lib/governance/freeze", () => ({ freezeMissingTallyDocuments: mocks.freeze }));
vi.mock("@/lib/governance/publish", () => ({ publishTallyDocuments: mocks.publish }));
vi.mock("@/lib/discord/notifyAnchorsDue", () => ({ notifyAnchorsDue: mocks.notifyAnchors }));
vi.mock("@/lib/discord/notifyOutsideSpends", () => ({ notifyOutsideSpends: mocks.notifyOutside }));
vi.mock("@/lib/cosigner/sign", () => ({ cosignReadyTransactions: mocks.cosign }));
vi.mock("@/lib/reconciliation/syncTreasury", () => ({ syncTreasury: mocks.syncTreasury }));

import { runReconcileSweep } from "./sweep";

interface Op { table: string; op: "select" | "update"; values?: Record<string, unknown>; filters: [string, unknown][] }
type Answer = { data: unknown; error: { message: string } | null };
let ops: Op[];
/** What a select of each table answers; an update answers `updates[table]` or success. */
let selects: Record<string, Answer>;
let updates: Record<string, Answer>;

function builder(table: string) {
  const op: Op = { table, op: "select", filters: [] };
  const record = (k: string, v: unknown) => { op.filters.push([k, v]); return chain; };
  const answer = (): Answer => (op.op === "update"
    ? updates[table] ?? { data: null, error: null }
    : selects[table] ?? { data: [], error: null });
  const chain = {
    select: () => chain,
    update: (values: Record<string, unknown>) => { op.op = "update"; op.values = values; return chain; },
    eq: record, in: record,
    limit: () => chain,
    maybeSingle: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ops.push(op);
      return Promise.resolve(answer()).then(resolve, reject);
    },
  };
  return chain;
}

const TREASURIES = [
  { id: "t-1", community_id: "c-1", address: "addr_test1_one", network: 0 },
  { id: "t-2", community_id: "c-1", address: "addr_test1_two", network: 0 },
  { id: "t-3", community_id: "c-2", address: "addr1_three", network: 1 },
];
const SYNCED = { confirmed: 1, incoming: 0 };
const payout = (patch: Record<string, unknown> = {}) => ({
  id: "po-1", transaction_id: "tx-1", task_id: "task-1", unit: "lovelace", amount: "50000000", contributor_wallet: "addr_test1_wallet_aaaaaa",
  tasks: { gh_issue_number: 12, gh_repo_id: 99, gh_project_item_node_id: "item-1" },
  transactions: { tx_hash: "hash-1", treasuries: { network: 0, community_id: "c-1" } },
  ...patch,
});
const updatesOf = (table: string) => ops.filter((o) => o.table === table && o.op === "update");


beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  ops = [];
  selects = { treasuries: { data: TREASURIES, error: null } };
  updates = {};
  mocks.from.mockImplementation(builder);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.registry.mockResolvedValue([]);
  mocks.advance.mockResolvedValue({ advanced: 2, failed: 1 });
  mocks.notifyProposals.mockResolvedValue({ posted: 3, failed: 1, dead: 1 });
  mocks.notifyPayouts.mockResolvedValue({ posted: 4 });
  mocks.syncTreasury.mockResolvedValue(SYNCED);
  mocks.writeBack.mockResolvedValue({ movedToStatus: null });
  mocks.freeze.mockResolvedValue({ frozen: 1, failed: 0 });
  mocks.publish.mockResolvedValue({ published: 1, republished: 0, failed: 0, checked: 2 });
  mocks.notifyAnchors.mockResolvedValue({ posted: 2, skipped: 0, failed: 0 });
  mocks.notifyOutside.mockResolvedValue({ posted: 1, skipped: 2, failed: 0 });
  mocks.cosign.mockResolvedValue({ signed: 1, refused: 0 });
  mocks.releaseOrphans.mockResolvedValue(0);
});

const EMPTY_FREEZE = { frozen: 0, failed: 0 };
const EMPTY_PUBLISH = { published: 0, republished: 0, failed: 0, checked: 0 };
const EMPTY_ANCHORS = { posted: 0, skipped: 0, failed: 0 };
const EMPTY_OUTSIDE = { posted: 0, skipped: 0, failed: 0 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runReconcileSweep", () => {
  it("runs every step and reports each one's result", async () => {
    const result = await runReconcileSweep();
    expect(result).toEqual({
      results: { "t-1": SYNCED, "t-2": SYNCED, "t-3": SYNCED },
      writtenBack: 0,
      statusMoved: 0,
      discordPosted: 4,
      proposals: { advanced: 2, failed: 1 },
      proposalAnnouncements: { posted: 3, failed: 1, dead: 1 },
      tallyDocuments: { frozen: 1, failed: 0 },
      documentCopies: { published: 1, republished: 0, failed: 0, checked: 2 },
      anchorAlerts: { posted: 2, skipped: 0, failed: 0 },
      outsideSpends: { posted: 1, skipped: 2, failed: 0 },
      cosigned: { signed: 1, refused: 0 },
      releasedTasks: 0,
    });
    expect(mocks.releaseOrphans).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("apply_workgroup_treasury_assignments");
    expect(mocks.advance).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(mocks.notifyProposals).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(mocks.freeze).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(mocks.notifyAnchors).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(mocks.notifyOutside).toHaveBeenCalledTimes(1);
    // Freeze before publish before anchor alerts; treasuries synced before outside spends.
    expect(mocks.freeze.mock.invocationCallOrder[0]!).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]!);
    expect(mocks.publish.mock.invocationCallOrder[0]!).toBeLessThan(mocks.notifyAnchors.mock.invocationCallOrder[0]!);
    expect(mocks.syncTreasury.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.notifyOutside.mock.invocationCallOrder[0]!);
    expect(mocks.syncTreasury.mock.calls.map((call) => call[0])).toEqual(TREASURIES);
    expect(mocks.purgeRateLimits).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(mocks.purgeInvites).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(mocks.purgeOAuth).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(mocks.purgeNonces).toHaveBeenCalledExactlyOnceWith(expect.any(Date));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("moves proposals along before announcing them", async () => {
    await runReconcileSweep();
    expect(mocks.advance.mock.invocationCallOrder[0]!).toBeLessThan(mocks.notifyProposals.mock.invocationCallOrder[0]!);
  });

  it("falls back to no announcements when the proposal announcer throws, without failing the sweep", async () => {
    mocks.notifyProposals.mockRejectedValue(new Error("load proposal webhooks: connection refused"));
    const result = await runReconcileSweep();
    expect(result.proposalAnnouncements).toEqual({ posted: 0, failed: 0, dead: 0 });
    // Everything after it still ran.
    expect(result.proposals).toEqual({ advanced: 2, failed: 1 });
    expect(Object.keys(result.results)).toEqual(["t-1", "t-2", "t-3"]);
    expect(result.discordPosted).toBe(4);
    expect(mocks.purgeRateLimits).toHaveBeenCalled();
    expect(mocks.purgeOAuth).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("notifyProposalMilestones failed", expect.any(Error));
  });

  it("falls back to no proposals advanced when that step throws, and still announces", async () => {
    mocks.advance.mockRejectedValue(new Error("load due proposals: timeout"));
    const result = await runReconcileSweep();
    expect(result.proposals).toEqual({ advanced: 0, failed: 0 });
    expect(result.proposalAnnouncements).toEqual({ posted: 3, failed: 1, dead: 1 });
    expect(mocks.syncTreasury).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith("advanceDueProposals failed", expect.any(Error));
  });

  it("carries on when applying scheduled workgroup wallets fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const result = await runReconcileSweep();
    expect(Object.keys(result.results)).toHaveLength(3);
    expect(mocks.advance).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("apply_workgroup_treasury_assignments failed", { message: "function does not exist" });
  });

  it("leaves out a treasury whose sync threw and syncs the others", async () => {
    mocks.syncTreasury.mockImplementation(async (treasury: { id: string }) => {
      if (treasury.id === "t-2") throw new Error("koios 503");
      return SYNCED;
    });
    const result = await runReconcileSweep();
    expect(result.results).toEqual({ "t-1": SYNCED, "t-3": SYNCED });
    expect(result.discordPosted).toBe(4);
    expect(console.error).toHaveBeenCalledWith("syncTreasury t-2 failed", expect.any(Error));
  });

  it("reports no Discord posts when the payout announcer throws, and still purges", async () => {
    mocks.notifyPayouts.mockRejectedValue(new Error("discord down"));
    const result = await runReconcileSweep();
    expect(result.discordPosted).toBe(0);
    expect(mocks.purgeRateLimits).toHaveBeenCalled();
    expect(mocks.purgeOAuth).toHaveBeenCalled();
  });

  it("does not let one purge failing stop the other or the sweep", async () => {
    mocks.purgeRateLimits.mockRejectedValue(new Error("purge failed"));
    mocks.purgeInvites.mockRejectedValue(new Error("purge failed"));
    mocks.purgeOAuth.mockRejectedValue(new Error("purge failed"));
    mocks.purgeNonces.mockRejectedValue(new Error("purge failed"));
    const result = await runReconcileSweep();
    expect(result.discordPosted).toBe(4);
    expect(mocks.purgeInvites).toHaveBeenCalled();
    expect(mocks.purgeOAuth).toHaveBeenCalled();
    expect(mocks.purgeNonces).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("rate limit purge failed", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("community invite purge failed", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("oauth purge failed", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("login challenge purge failed", expect.any(Error));
  });

  it("reports the queued tasks it found without a live payout and put back to payable", async () => {
    mocks.releaseOrphans.mockResolvedValue(2);
    expect((await runReconcileSweep()).releasedTasks).toBe(2);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("released 2 queued task(s) with no live payout");
  });

  it("survives every isolated step failing at once", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    for (const step of [
      mocks.advance, mocks.notifyProposals, mocks.freeze, mocks.publish, mocks.notifyAnchors, mocks.syncTreasury,
      mocks.notifyOutside, mocks.notifyPayouts, mocks.purgeRateLimits, mocks.purgeInvites, mocks.purgeOAuth,
      mocks.cosign, mocks.releaseOrphans,
    ]) {
      step.mockRejectedValue(new Error("boom"));
    }
    expect(await runReconcileSweep()).toEqual({
      results: {}, writtenBack: 0, statusMoved: 0, discordPosted: 0,
      proposals: { advanced: 0, failed: 0 }, proposalAnnouncements: { posted: 0, failed: 0, dead: 0 },
      tallyDocuments: EMPTY_FREEZE, documentCopies: EMPTY_PUBLISH, anchorAlerts: EMPTY_ANCHORS,
      outsideSpends: EMPTY_OUTSIDE, cosigned: { signed: 0, refused: 0 },
      releasedTasks: 0,
    });
    expect(console.error).toHaveBeenCalledWith("orphaned task release failed", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("freezeMissingTallyDocuments failed", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("publishTallyDocuments failed", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("notifyAnchorsDue failed", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("notifyOutsideSpends failed", expect.any(Error));
  });

  it("fails when the treasuries cannot be read, rather than reporting an empty sweep", async () => {
    selects.treasuries = { data: null, error: { message: "permission denied" } };
    await expect(runReconcileSweep()).rejects.toThrow("load treasuries: permission denied");
    expect(mocks.syncTreasury).not.toHaveBeenCalled();
    // The proposal steps come first, so they already ran.
    expect(mocks.advance).toHaveBeenCalled();
    expect(mocks.notifyProposals).toHaveBeenCalled();
  });

  describe("GitHub write-backs", () => {
    beforeEach(() => {
      selects.github_repos = { data: { installation_id: 7, full_name: "guild/repo", paid_status: " Paid " }, error: null };
      selects.contributors = { data: [{ wallet_address: "addr_test1_wallet_aaaaaa", handle: "ann" }], error: null };
    });

    it("writes one comment per task, listing each asset and each wallet paid, and marks its rows", async () => {
      mocks.registry.mockResolvedValue([{ fieldName: "HOSKY", unit: "hosky-unit", decimals: 2 }]);
      selects.payouts = {
        error: null,
        data: [
          payout(),
          payout({ id: "po-2", unit: "hosky-unit", amount: "150" }),
          payout({ id: "po-3", contributor_wallet: "addr_test1_wallet_bbbbbb" }),
          payout({ id: "po-4", unit: "hosky-unit", amount: "150", contributor_wallet: "addr_test1_wallet_bbbbbb" }),
        ],
      };
      mocks.writeBack.mockResolvedValue({ movedToStatus: "Paid" });
      const result = await runReconcileSweep();
      expect(result).toMatchObject({ writtenBack: 1, statusMoved: 1 });
      expect(mocks.writeBack).toHaveBeenCalledExactlyOnceWith({
        installationId: 7, repoFullName: "guild/repo", issueNumber: 12,
        amounts: [{ ticker: "ADA", decimals: 6, quantity: 50_000_000n }, { ticker: "HOSKY", decimals: 2, quantity: 150n }],
        recipientLabels: ["ann", "…bbbbbb"],
        txHash: "hash-1", network: 0,
        projectItem: { itemNodeId: "item-1", status: "Paid" },
      });
      expect(updatesOf("tasks")).toEqual([expect.objectContaining({ values: { gh_status: "Paid" }, filters: [["id", "task-1"]] })]);
      expect(updatesOf("payouts")).toEqual([
        expect.objectContaining({ values: { status: "written_back" }, filters: [["id", ["po-1", "po-2", "po-3", "po-4"]]] }),
      ]);
    });

    it("keeps going after one write-back fails, leaving its rows to retry", async () => {
      selects.payouts = {
        error: null,
        data: [payout(), payout({ id: "po-9", task_id: "task-2", tasks: { gh_issue_number: 13, gh_repo_id: 99, gh_project_item_node_id: null } })],
      };
      mocks.writeBack.mockRejectedValueOnce(new Error("github 502")).mockResolvedValue({ movedToStatus: null });
      const result = await runReconcileSweep();
      expect(result).toMatchObject({ writtenBack: 1, statusMoved: 0, discordPosted: 4 });
      expect(mocks.writeBack).toHaveBeenCalledTimes(2);
      expect(mocks.writeBack.mock.calls[1]![0]).toMatchObject({ issueNumber: 13, projectItem: null });
      expect(updatesOf("payouts").map((o) => o.filters)).toEqual([[["id", ["po-9"]]]]);
      expect(console.error).toHaveBeenCalledWith("write-back for payout po-1 failed", expect.any(Error));
    });

    it("skips a payout with no issue, no tx hash or no linked repo", async () => {
      selects.payouts = {
        error: null,
        data: [
          payout({ id: "a", task_id: "k-a", tasks: { gh_issue_number: null, gh_repo_id: 99, gh_project_item_node_id: null } }),
          payout({ id: "b", task_id: "k-b", transactions: { tx_hash: null, treasuries: { network: 0, community_id: "c-1" } } }),
        ],
      };
      expect(await runReconcileSweep()).toMatchObject({ writtenBack: 0 });
      selects.payouts = { error: null, data: [payout()] };
      selects.github_repos = { data: null, error: null };
      expect(await runReconcileSweep()).toMatchObject({ writtenBack: 0 });
      expect(mocks.writeBack).not.toHaveBeenCalled();
      expect(updatesOf("payouts")).toEqual([]);
    });

    it("counts a comment as written only once its rows are marked", async () => {
      selects.payouts = { error: null, data: [payout()] };
      updates.payouts = { data: null, error: { message: "deadlock" } };
      const result = await runReconcileSweep();
      expect(result).toMatchObject({ writtenBack: 0, discordPosted: 4 });
      expect(console.error).toHaveBeenCalledWith("write-back for payout po-1 failed", expect.any(Error));
    });
  });
});

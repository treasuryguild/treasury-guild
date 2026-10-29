import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { currentBudgetMonth } from "@/lib/budgets";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  treasuries: vi.fn(),
  pending: vi.fn(),
  walletAssets: vi.fn(),
  hints: vi.fn(),
  rateLimit: vi.fn(),
  workgroups: vi.fn(),
  tasks: vi.fn(),
  payable: vi.fn(),
  memberships: vi.fn(),
  registry: vi.fn(),
  dashboard: vi.fn(),
  txList: vi.fn(),
  workgroupsWithLeads: vi.fn(),
  members: vi.fn(),
  incoming: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/treasuries", () => ({ listCommunityTreasuries: mocks.treasuries }));
vi.mock("@/lib/db/transactions", () => ({ loadPendingTransactions: mocks.pending, listTreasuryTransactions: mocks.txList }));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.walletAssets }));
vi.mock("@/lib/db/assets", () => ({ loadMintAssetHints: mocks.hints, loadAssetRegistry: mocks.registry }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/workgroups", () => ({ listCommunityWorkgroups: mocks.workgroups, listWorkgroupsWithLeads: mocks.workgroupsWithLeads }));
vi.mock("@/lib/db/dashboard", () => ({ loadRecentIncoming: mocks.incoming }));
vi.mock("@/lib/db/membership", () => ({ communitiesForWallet: mocks.memberships, listCommunityMembers: mocks.members }));
vi.mock("@/lib/db/budgetDashboard", () => ({ loadBudgetDashboard: mocks.dashboard }));
vi.mock("@/lib/db/tasks", () => ({ listCommunityTasks: mocks.tasks, countPayableTasks: mocks.payable }));

import { budgetSummary, RECENT_SPENDING_MAX } from "./budgets";
import { listCommunities, whoami } from "./communities";
import { callEndpoint } from "./endpoint";
import { listIncoming } from "./incoming";
import { listMembers } from "./members";
import { memberCommunity } from "./shared";
import { signingQueue } from "./signing";
import { listTasks } from "./tasks";
import { listTransactions } from "./transactions";
import { treasuryOverview } from "./treasuries";
import { listWorkgroups } from "./workgroups";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["communities:read"], clientId: "c1", via: "oauth" };
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("member");
  mocks.pending.mockResolvedValue([]);
  mocks.hints.mockResolvedValue(new Map());
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.payable.mockResolvedValue(0);
  mocks.registry.mockResolvedValue([]);
  mocks.dashboard.mockResolvedValue({ budgets: [], totals: [], spending: [], refunds: [], setups: [] });
  mocks.tasks.mockResolvedValue({ tasks: [], total: 0 });
  mocks.workgroups.mockResolvedValue([{ id: "wg-dev", name: "Development", kind: "native", archived_at: null, treasury_id: null }]);
  mocks.treasuries.mockResolvedValue([{
    id: "t1", name: "Main", address: "addr_test1_main", network: 0, required: 2, script_type: "atLeast",
    template: "plain", lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null,
    treasury_signers: [
      { wallet_address: "addr_a", display_name: "Ann", signer_group: "base" },
      { wallet_address: "addr_b", display_name: null, signer_group: "base" },
      { wallet_address: "addr_c", display_name: "Cy", signer_group: "base" },
    ],
  }]);
});

describe("community access", () => {
  it("hides a private community from a non-member, and refuses a public one", async () => {
    mocks.role.mockResolvedValue(null);
    await expect(callEndpoint(listTasks, caller, { community: "signius" })).rejects.toBeInstanceOf(NotFoundError);
    mocks.community.mockResolvedValue({ ...COMMUNITY, visibility: "public" });
    await expect(callEndpoint(listTasks, caller, { community: "signius" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.tasks).not.toHaveBeenCalled();
  });

  it("refuses a caller without the scope before touching data", async () => {
    await expect(callEndpoint(listTasks, { ...caller, scopes: [] }, { community: "signius" }))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.community).not.toHaveBeenCalled();
  });
});

describe("memberCommunity", () => {
  it("returns the community and the caller's role", async () => {
    mocks.role.mockResolvedValue("admin");
    expect(await memberCommunity(caller, "signius")).toEqual({ community: COMMUNITY, role: "admin" });
    expect(mocks.community).toHaveBeenCalledWith("signius");
    expect(mocks.role).toHaveBeenCalledWith("c1", "addr_w");
  });

  it("answers a non-member of a private community as if it did not exist", async () => {
    mocks.role.mockResolvedValue(null);
    const err = await memberCommunity(caller, "signius").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ status: 404, message: "Community not found" });
  });

  it("answers 403 to a non-member of a public community", async () => {
    mocks.role.mockResolvedValue(null);
    mocks.community.mockResolvedValue({ ...COMMUNITY, visibility: "public" });
    const err = await memberCommunity(caller, "signius").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ status: 403, message: "Not a community member" });
  });

  it("passes on the 404 of a slug that names no community, without a role lookup", async () => {
    mocks.community.mockRejectedValue(new NotFoundError("Community not found"));
    await expect(memberCommunity(caller, "nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.role).not.toHaveBeenCalled();
  });
});

describe("whoami", () => {
  it("names the wallet, the client acting for it and the scopes granted", async () => {
    expect(await callEndpoint(whoami, caller, undefined)).toEqual({ wallet: "addr_w", client: "c1", scopes: ["communities:read"] });
    const session: ApiCaller = { wallet: "addr_s", scopes: ["communities:read"], clientId: null, via: "session" };
    expect(await callEndpoint(whoami, session, {})).toEqual({ wallet: "addr_s", client: null, scopes: ["communities:read"] });
    expect(mocks.community).not.toHaveBeenCalled();
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it("needs the scope", async () => {
    await expect(callEndpoint(whoami, { ...caller, scopes: [] }, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("community_list", () => {
  it("lists the caller's own memberships with role, network name and link", async () => {
    mocks.memberships.mockResolvedValue([
      { role: "owner", community: { id: "c1", slug: "signius", name: "Signius", description: "Audits", network: 1, visibility: "private" } },
      { role: "member", community: { id: "c2", slug: "lab", name: "Lab", description: null, network: 0, visibility: "public" } },
    ]);
    const res = await callEndpoint(listCommunities, caller, {});
    expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith("addr_w");
    expect(res).toEqual({
      communities: [
        { slug: "signius", name: "Signius", description: "Audits", network: "mainnet", visibility: "private", role: "owner", url: "http://localhost:3000/c/signius" },
        { slug: "lab", name: "Lab", description: null, network: "preprod", visibility: "public", role: "member", url: "http://localhost:3000/c/lab" },
      ],
    });
    // Internal ids stay out of the answer.
    expect(JSON.stringify(res)).not.toContain('"id"');
  });

  it("answers an empty list for a wallet in no community, and refuses a caller without the scope", async () => {
    mocks.memberships.mockResolvedValue([]);
    expect(await callEndpoint(listCommunities, caller, {})).toEqual({ communities: [] });
    mocks.memberships.mockClear();
    await expect(callEndpoint(listCommunities, { ...caller, scopes: [] }, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.memberships).not.toHaveBeenCalled();
  });
});

describe("budget_summary", () => {
  const HOSKY = "p".repeat(56) + "484f534b59";
  const UNKNOWN = "q".repeat(56) + "abcdef";
  const budget = (patch: Record<string, unknown>) => ({
    id: "b1", budgetMonth: "2026-09-01", ownerType: "workgroup", ownerId: "wg-dev", ownerName: "Development", treasuryId: null,
    workgroupKind: "native", cadence: "monthly", unit: "lovelace", assetLabel: "ADA", decimals: 6,
    amount: "1000000000", spent: "250500000", balance: "749500000",
    periodStart: "2026-09-01", periodEnd: "2026-10-01", periodLabel: "Sep 2026", ...patch,
  });
  const spend = (patch: Record<string, unknown>) => ({
    id: "s1", kind: "payout", ownerType: "workgroup", ownerId: "wg-dev", ownerName: "Development", title: "Fix login",
    unit: "lovelace", amount: "50000000", status: "confirmed", createdAt: "2026-09-10T00:00:00Z", ...patch,
  });

  it("shows budgets, totals and spending in exact display units", async () => {
    mocks.registry.mockResolvedValue([{ fieldName: "HOSKY", unit: HOSKY, decimals: 2 }]);
    mocks.dashboard.mockResolvedValue({
      budgets: [
        budget({}),
        budget({ id: "b2", ownerType: "treasury", ownerId: "t1", ownerName: "Treasury: Main", cadence: "quarterly", periodLabel: "Q3 2026",
          unit: "tok", assetLabel: "GOLD", decimals: 3, amount: "5000", spent: "6500", balance: "-1500" }),
      ],
      totals: [
        { unit: "lovelace", amount: "1000000000", spent: "250500000", balance: "749500000" },
        { unit: "tok", amount: "5000", spent: "6500", balance: "-1500" },
        { unit: HOSKY, amount: "0", spent: "150", balance: "-150" },
        { unit: UNKNOWN, amount: "0", spent: "7", balance: "-7" },
      ],
      spending: [
        spend({}),
        spend({ id: "s2", kind: "payment", ownerName: "Treasury: Main", title: "Hosting", unit: HOSKY, amount: "150", status: "submitted" }),
      ],
      refunds: [], setups: [],
    });
    const res = await callEndpoint(budgetSummary, caller, { community: "signius", month: "2026-09", view: "quarter" });
    expect(mocks.dashboard).toHaveBeenCalledExactlyOnceWith("c1", new Date("2026-09-01T00:00:00Z"), "quarter");
    expect(mocks.registry).toHaveBeenCalledWith("c1");
    expect(res).toEqual({
      community: { slug: "signius", name: "Signius" },
      view: "quarter",
      month: "2026-09",
      budgets: [
        { owner: "Development", ownerType: "workgroup", cadence: "monthly", period: "Sep 2026", token: "ADA", budget: "1000", spent: "250.5", remaining: "749.5" },
        { owner: "Treasury: Main", ownerType: "treasury", cadence: "quarterly", period: "Q3 2026", token: "GOLD", budget: "5", spent: "6.5", remaining: "-1.5" },
      ],
      totals: [
        { token: "ADA", budget: "1000", spent: "250.5", remaining: "749.5" },
        // A budget's own label and decimals name its unit in the totals.
        { token: "GOLD", budget: "5", spent: "6.5", remaining: "-1.5" },
        // Spending in a token with no budget takes the registry's name.
        { token: "HOSKY", budget: "0", spent: "1.5", remaining: "-1.5" },
        // An unknown unit is shown in base units, never with guessed decimals.
        { token: "TOKEN-ABCDEF", budget: "0", spent: "7", remaining: "-7" },
      ],
      recentSpending: [
        { owner: "Development", kind: "payout", title: "Fix login", token: "ADA", amount: "50", status: "confirmed", createdAt: "2026-09-10T00:00:00Z" },
        { owner: "Treasury: Main", kind: "payment", title: "Hosting", token: "HOSKY", amount: "1.5", status: "submitted", createdAt: "2026-09-10T00:00:00Z" },
      ],
      url: "http://localhost:3000/c/signius/budgets?month=2026-09&view=quarter",
    });
  });

  it("defaults to the current month and the month view", async () => {
    const res = await callEndpoint(budgetSummary, caller, { community: "signius" });
    const month = currentBudgetMonth();
    expect(res).toMatchObject({ view: "month", month, budgets: [], totals: [], recentSpending: [] });
    expect(mocks.dashboard).toHaveBeenCalledWith("c1", new Date(`${month}-01T00:00:00Z`), "month");
    expect(res.url).toBe(`http://localhost:3000/c/signius/budgets?month=${month}&view=month`);
  });

  it("cuts recent spending at RECENT_SPENDING_MAX lines", async () => {
    mocks.dashboard.mockResolvedValue({
      budgets: [], totals: [], refunds: [], setups: [],
      spending: Array.from({ length: RECENT_SPENDING_MAX + 5 }, (_, i) => spend({ id: `s${i}`, title: `Task ${i}` })),
    });
    const res = await callEndpoint(budgetSummary, caller, { community: "signius", month: "2026-09" });
    expect(res.recentSpending).toHaveLength(RECENT_SPENDING_MAX);
    expect(res.recentSpending[RECENT_SPENDING_MAX - 1]?.title).toBe(`Task ${RECENT_SPENDING_MAX - 1}`);
  });

  it("refuses a malformed month or view before touching data", async () => {
    await expect(callEndpoint(budgetSummary, caller, { community: "signius", month: "2026-13" })).rejects.toThrow("month must be YYYY-MM");
    await expect(callEndpoint(budgetSummary, caller, { community: "signius", month: "2026-9" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(callEndpoint(budgetSummary, caller, { community: "signius", view: "all" })).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.community).not.toHaveBeenCalled();
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it("reads nothing for a non-member", async () => {
    mocks.role.mockResolvedValue(null);
    await expect(callEndpoint(budgetSummary, caller, { community: "signius" })).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.dashboard).not.toHaveBeenCalled();
    expect(mocks.registry).not.toHaveBeenCalled();
  });
});

describe("treasury_overview", () => {
  it("describes the signing rule, balance in display units and the pending transaction", async () => {
    mocks.walletAssets.mockResolvedValue({
      lovelace: 1_234_567_890n, utxoCount: 3,
      tokens: [{ unit: "p".repeat(56) + "48", quantity: 150n, ticker: "HOSKY", name: "Hosky", decimals: 2, source: "registry" }],
    });
    mocks.pending.mockResolvedValue([{
      id: "tx1", treasury_id: "t1", kind: "payout", description: "July payouts",
      signed_addresses: ["addr_a"], rejected_addresses: [], created_at: "2026-09-01T00:00:00Z", created_by: "addr_a",
      spending_path: "base",
    }]);
    const res = await callEndpoint(treasuryOverview, caller, { community: "signius" });
    expect(res.treasuries[0]).toMatchObject({
      template: "plain",
      lockUntil: null,
      signingRule: "2 of 3 signers",
      requiredSignatures: 2,
      signers: [{ name: "Ann", address: "addr_a", group: "base" }, { name: null, address: "addr_b", group: "base" }, { name: "Cy", address: "addr_c", group: "base" }],
      balance: { ada: "1234.56789", lovelace: "1234567890", tokens: [{ ticker: "HOSKY", quantity: "1.5" }] },
      pendingTransaction: { id: "tx1", spendingPath: "base", signatures: 1, requiredSignatures: 2, url: "http://localhost:3000/c/signius/tx/tx1" },
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith("chainProxy", "addr_w");
  });

  it("reports a chain failure per treasury instead of failing the call", async () => {
    mocks.walletAssets.mockRejectedValue(new Error("koios down"));
    const res = await callEndpoint(treasuryOverview, caller, { community: "signius" });
    expect(res.treasuries[0]).toMatchObject({ balance: null, balanceError: "koios down" });
  });

  it("keeps unexpected chain-library text out of production answers", async () => {
    const env = process.env as Record<string, string | undefined>;
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      mocks.walletAssets.mockRejectedValue(new Error("TypeError at wasm://0x1f internal"));
      const res = await callEndpoint(treasuryOverview, caller, { community: "signius" });
      expect(res.treasuries[0]?.balanceError).toBe("The chain could not be read");
    } finally {
      env.NODE_ENV = nodeEnv;
    }
  });

  it("skips the chain when balances are not wanted", async () => {
    const res = await callEndpoint(treasuryOverview, caller, { community: "signius", balances: false });
    expect(res.treasuries[0]?.balance).toBeNull();
    expect(mocks.walletAssets).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });
});

describe("task_list", () => {
  it("resolves a workgroup by name and marks what can be paid now", async () => {
    mocks.payable.mockResolvedValue(4);
    mocks.tasks.mockResolvedValue({
      total: 1,
      tasks: [{
        id: "k1", number: 12, title: "Fix login", source: "native", pay_state: "payable", archived_at: null,
        bounty_lovelace: null, amounts: { ADA: "50" }, budget_month: "2026-09-01", paid_tx_hash: null, gh_url: null,
        created_at: "2026-09-01T00:00:00Z", workgroup_id: "wg-dev", workgroups: { name: "Development" },
        board_columns: [{ name: "Audited" }],
        task_assignees: [{ id: "a", source: "manual", gh_login: null, gh_user_id: null, wallet_address: "addr_x", position: 0, contributors: { handle: "Xi", github_username: null } }],
      }],
    });
    const res = await callEndpoint(listTasks, caller, { community: "signius", workgroup: "development", limit: "10" });
    expect(mocks.tasks).toHaveBeenCalledWith("c1", expect.objectContaining({ workgroupIds: ["wg-dev"], limit: 10, includeArchived: false }));
    expect(res).toMatchObject({ total: 1, payableCount: 4 });
    expect(res.tasks[0]).toMatchObject({
      number: 12, workgroup: "Development", column: "Audited", reward: { ADA: "50" },
      assignees: [{ name: "Xi", wallet: "addr_x" }], readyToPay: true, budgetMonth: "2026-09",
      url: "http://localhost:3000/c/signius/boards/wg-dev",
    });
  });

  it("passes the payState filter on, and is not ready to pay when archived or an assignee has no wallet", async () => {
    const task = (patch: Record<string, unknown>) => ({
      id: "k1", number: 12, title: "Fix login", source: "native", pay_state: "payable", archived_at: null,
      bounty_lovelace: null, amounts: { ADA: "50" }, budget_month: null, paid_tx_hash: null, gh_url: null,
      created_at: "2026-09-01T00:00:00Z", workgroup_id: "wg-dev", workgroups: { name: "Development" }, board_columns: null,
      task_assignees: [{ id: "a", source: "manual", gh_login: null, gh_user_id: null, wallet_address: "addr_x", position: 0, contributors: { handle: "Xi", github_username: null } }],
      ...patch,
    });
    mocks.tasks.mockResolvedValue({
      total: 3,
      tasks: [
        task({}),
        task({ id: "k2", number: 13, archived_at: "2026-09-20T00:00:00Z" }),
        task({
          id: "k3", number: 14,
          task_assignees: [
            { id: "a", source: "manual", gh_login: null, gh_user_id: null, wallet_address: "addr_x", position: 0, contributors: { handle: "Xi", github_username: null } },
            { id: "b", source: "github", gh_login: "octo", gh_user_id: 9, wallet_address: null, position: 1, contributors: null },
          ],
        }),
      ],
    });
    const res = await callEndpoint(listTasks, caller, { community: "signius", payState: "payable", includeArchived: true });
    expect(mocks.tasks).toHaveBeenCalledExactlyOnceWith("c1", { workgroupIds: undefined, payState: "payable", includeArchived: true, limit: 50 });
    expect(mocks.workgroups).not.toHaveBeenCalled();
    expect(res.tasks.map((t) => [t.number, t.archived, t.readyToPay])).toEqual([[12, false, true], [13, true, false], [14, false, false]]);
    expect(res.tasks[0]).toMatchObject({ column: null, budgetMonth: null });
    await expect(callEndpoint(listTasks, caller, { community: "signius", payState: "pending" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("names the community's workgroups when the one asked for does not exist", async () => {
    await expect(callEndpoint(listTasks, caller, { community: "signius", workgroup: "Design" }))
      .rejects.toThrow('No workgroup "Design" in this community. Workgroups: Development');
  });
});

describe("signing_queue", () => {
  const pendingTx = (patch: Record<string, unknown>) => ({
    id: "tx1", treasury_id: "t1", kind: "payout", description: "July payouts",
    signed_addresses: [], rejected_addresses: [], created_at: "2026-09-02T00:00:00Z", created_by: "addr_a",
    spending_path: "base", ...patch,
  });

  beforeEach(() => {
    mocks.memberships.mockResolvedValue([
      { role: "admin", community: { id: "c1", slug: "signius", name: "Signius", description: null, network: 0, visibility: "private" } },
    ]);
  });

  it("lists, oldest first, the pending transactions whose rule counts the caller's signature", async () => {
    const signer: ApiCaller = { ...caller, wallet: "addr_b" };
    mocks.treasuries.mockResolvedValue([
      {
        id: "t1", name: "Main", address: "addr_test1_main", network: 0, required: 2, script_type: "atLeast",
        template: "plain", lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null,
        treasury_signers: [
          { wallet_address: "addr_a", display_name: "Ann", signer_group: "base" },
          { wallet_address: "addr_b", display_name: null, signer_group: "base" },
          { wallet_address: "addr_c", display_name: "Cy", signer_group: "base" },
        ],
      },
      {
        id: "t2", name: "Other", address: "addr_test1_other", network: 0, required: 1, script_type: "atLeast",
        template: "plain", lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null,
        treasury_signers: [{ wallet_address: "addr_z", display_name: null, signer_group: "base" }],
      },
    ]);
    mocks.pending.mockResolvedValue([
      pendingTx({ id: "tx2", created_at: "2026-09-03T00:00:00Z", signed_addresses: ["addr_a", "addr_b"] }),
      pendingTx({ id: "tx1" }),
      // A treasury the caller does not sign for.
      pendingTx({ id: "tx3", treasury_id: "t2" }),
    ]);
    const res = await callEndpoint(signingQueue, signer, {});
    expect(mocks.treasuries).toHaveBeenCalledWith("c1");
    expect(mocks.pending).toHaveBeenCalledWith(expect.arrayContaining(["t1", "t2"]));
    expect(res.transactions.map((t) => t.id)).toEqual(["tx1", "tx2"]);
    expect(res.transactions[0]).toEqual({
      community: { slug: "signius", name: "Signius" }, treasury: "Main", id: "tx1", kind: "payout",
      description: "July payouts", spendingPath: "base", signatures: 0, requiredSignatures: 2, rejections: 0,
      signedByMe: false, rejectedByMe: false, readyToSubmit: false, createdAt: "2026-09-02T00:00:00Z",
      url: "http://localhost:3000/c/signius/tx/tx1",
    });
    expect(res.transactions[1]).toMatchObject({ signedByMe: true, readyToSubmit: true, signatures: 2 });
    expect(res.waitingOnMe).toBe(1);
  });

  it("counts a recovery signer only on the recovery path", async () => {
    const recovery: ApiCaller = { ...caller, wallet: "addr_r" };
    mocks.treasuries.mockResolvedValue([{
      id: "t1", name: "Main", address: "addr_test1_main", network: 0, required: 1, script_type: "atLeast",
      template: "clawback", lock_until: "2026-01-01T00:00:00Z", recovery_script_type: "any", recovery_required: 1, cosigner_kind: null,
      treasury_signers: [
        { wallet_address: "addr_a", display_name: null, signer_group: "base" },
        { wallet_address: "addr_r", display_name: null, signer_group: "recovery" },
      ],
    }]);
    mocks.pending.mockResolvedValue([pendingTx({ id: "base" }), pendingTx({ id: "rec", spending_path: "recovery" })]);
    const res = await callEndpoint(signingQueue, recovery, {});
    expect(res.transactions.map((t) => t.id)).toEqual(["rec"]);
  });

  it("skips a pending transaction of a treasury it did not list", async () => {
    const signer: ApiCaller = { ...caller, wallet: "addr_a" };
    mocks.pending.mockResolvedValue([pendingTx({ id: "tx1" }), pendingTx({ id: "ghost", treasury_id: "t-gone" })]);
    const res = await callEndpoint(signingQueue, signer, {});
    expect(res.transactions.map((t) => t.id)).toEqual(["tx1"]);
    expect(res.waitingOnMe).toBe(1);
  });

  it("answers an empty queue for a wallet in no community", async () => {
    mocks.memberships.mockResolvedValue([]);
    expect(await callEndpoint(signingQueue, caller, {})).toEqual({ transactions: [], waitingOnMe: 0 });
    expect(mocks.pending).toHaveBeenCalledWith([]);
  });
});

describe("transaction_list", () => {
  const txRow = (patch: Record<string, unknown>) => ({
    id: "tx1", treasury_id: "t1", kind: "payment", description: "Hosting", signed_addresses: ["addr_a", "addr_b"],
    rejected_addresses: [], state: 2, tx_hash: "h".repeat(64), created_at: "2026-09-01T00:00:00Z",
    submitted_at: "2026-09-01T01:00:00Z", block_time: "2026-09-01T01:05:00Z", spending_path: "base", spend_problems: [], ...patch,
  });

  it("describes transactions with their treasury, state name and budget problems", async () => {
    mocks.txList.mockResolvedValue({
      total: 7,
      transactions: [
        txRow({}),
        txRow({
          id: "tx2", state: 0, tx_hash: null, submitted_at: null, block_time: null,
          spend_problems: [{ code: "no_budget", ownerName: "Development", period: "Sep 2026" }],
        }),
      ],
    });
    const res = await callEndpoint(listTransactions, caller, { community: "signius", state: "confirmed", kind: "payment", limit: "5" });
    expect(mocks.txList).toHaveBeenCalledExactlyOnceWith(["t1"], { kind: "payment", state: 2, limit: 5 });
    expect(res).toMatchObject({ community: { slug: "signius", name: "Signius" }, total: 7, url: "http://localhost:3000/c/signius/treasury" });
    expect(res.transactions[0]).toEqual({
      id: "tx1", treasury: "Main", kind: "payment", state: "confirmed", description: "Hosting", spendingPath: "base",
      txHash: "h".repeat(64), signatures: 2, rejections: 0, createdAt: "2026-09-01T00:00:00Z",
      submittedAt: "2026-09-01T01:00:00Z", blockTime: "2026-09-01T01:05:00Z", spendProblems: [],
      url: "http://localhost:3000/c/signius/tx/tx1",
    });
    expect(res.transactions[1]).toMatchObject({ state: "pending", spendProblems: ["Development has no budget for Sep 2026."] });
  });

  it("filters by treasury name and names the treasuries when it does not exist", async () => {
    mocks.txList.mockResolvedValue({ transactions: [], total: 0 });
    await callEndpoint(listTransactions, caller, { community: "signius", treasury: "main" });
    expect(mocks.txList).toHaveBeenCalledWith(["t1"], { kind: undefined, state: undefined, limit: 25 });
    await expect(callEndpoint(listTransactions, caller, { community: "signius", treasury: "Ops" }))
      .rejects.toThrow('No treasury "Ops" in this community. Treasuries: Main');
  });

  it("matches a treasury by its id, and names each transaction's own treasury", async () => {
    const treasury = (id: string, name: string) => ({
      id, name, address: `addr_test1_${id}`, network: 0, required: 1, script_type: "atLeast",
      template: "plain", lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null,
      treasury_signers: [{ wallet_address: "addr_a", display_name: "Ann", signer_group: "base" }],
    });
    mocks.treasuries.mockResolvedValue([treasury("t1", "Main"), treasury("t2", "Ops")]);
    mocks.txList.mockResolvedValue({ transactions: [txRow({ id: "tx9", treasury_id: "t2" })], total: 1 });
    const res = await callEndpoint(listTransactions, caller, { community: "signius", treasury: "t2" });
    expect(mocks.txList).toHaveBeenCalledExactlyOnceWith(["t2"], { kind: undefined, state: undefined, limit: 25 });
    expect(res.transactions[0]).toMatchObject({ id: "tx9", treasury: "Ops" });
    // The id must match exactly; without a filter every treasury is read.
    await expect(callEndpoint(listTransactions, caller, { community: "signius", treasury: "T2" })).rejects.toBeInstanceOf(BadRequestError);
    await callEndpoint(listTransactions, caller, { community: "signius" });
    expect(mocks.txList).toHaveBeenLastCalledWith(["t1", "t2"], { kind: undefined, state: undefined, limit: 25 });
  });

  it("refuses an unknown state or kind, and reads nothing for a non-member", async () => {
    await expect(callEndpoint(listTransactions, caller, { community: "signius", state: "lost" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(callEndpoint(listTransactions, caller, { community: "signius", kind: "refund" })).rejects.toBeInstanceOf(BadRequestError);
    mocks.role.mockResolvedValue(null);
    await expect(callEndpoint(listTransactions, caller, { community: "signius" })).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.txList).not.toHaveBeenCalled();
  });
});

describe("workgroup_list", () => {
  beforeEach(() => {
    mocks.workgroupsWithLeads.mockResolvedValue([
      {
        id: "wg-dev", name: "Development", description: "Code", kind: "native", archived_at: null, treasury_id: "t1",
        workgroup_leads: [{ wallet_address: "addr_l", contributors: { handle: "Lee", github_username: "lee" } }],
      },
      { id: "wg-old", name: "Old", description: null, kind: "github", archived_at: "2026-01-01T00:00:00Z", treasury_id: null, workgroup_leads: [] },
    ]);
  });

  it("lists live workgroups with leads, source and current treasury", async () => {
    const res = await callEndpoint(listWorkgroups, caller, { community: "signius" });
    expect(res).toEqual({
      community: { slug: "signius", name: "Signius" },
      workgroups: [{
        id: "wg-dev", name: "Development", description: "Code", source: "native", archived: false, treasury: "Main",
        leads: [{ name: "Lee (@lee)", wallet: "addr_l" }], url: "http://localhost:3000/c/signius/boards/wg-dev",
      }],
    });
  });

  it("includes archived workgroups when asked", async () => {
    const res = await callEndpoint(listWorkgroups, caller, { community: "signius", includeArchived: true });
    expect(res.workgroups[1]).toMatchObject({ name: "Old", source: "github", archived: true, treasury: null, leads: [] });
  });
});

describe("incoming_list", () => {
  const HOSKY = "p".repeat(56) + "484f534b59";
  const UNKNOWN = "q".repeat(56) + "abcdef";

  it("shows inflows in display units and flags those waiting for review", async () => {
    mocks.registry.mockResolvedValue([{ fieldName: "HOSKY", unit: HOSKY, decimals: 2 }]);
    mocks.incoming.mockResolvedValue([
      {
        txHash: "h1", treasuryName: "Main", fromTreasuryName: null, amountLovelace: "1500000",
        assets: { [HOSKY]: "150", [UNKNOWN]: "7" }, blockTime: "2026-09-01T00:00:00Z",
        incomingType: "unclassified", requiresReconciliation: true, matched: false,
      },
      {
        txHash: "h2", treasuryName: "Main", fromTreasuryName: "Ops", amountLovelace: "10000000", assets: null,
        blockTime: null, incomingType: "transfer", requiresReconciliation: false, matched: false,
      },
    ]);
    const res = await callEndpoint(listIncoming, caller, { community: "signius", limit: "5" });
    expect(mocks.incoming).toHaveBeenCalledExactlyOnceWith("c1", 5);
    expect(res).toEqual({
      community: { slug: "signius", name: "Signius" },
      incoming: [
        {
          txHash: "h1", treasury: "Main", fromTreasury: null, ada: "1.5", tokens: { HOSKY: "1.5", "TOKEN-ABCDEF": "7" },
          blockTime: "2026-09-01T00:00:00Z", type: "unclassified", needsReview: true,
        },
        { txHash: "h2", treasury: "Main", fromTreasury: "Ops", ada: "10", tokens: {}, blockTime: null, type: "transfer", needsReview: false },
      ],
      url: "http://localhost:3000/c/signius/reconcile",
    });
  });

  it("caps the limit and reads nothing for a non-member", async () => {
    await expect(callEndpoint(listIncoming, caller, { community: "signius", limit: "101" })).rejects.toBeInstanceOf(BadRequestError);
    mocks.role.mockResolvedValue(null);
    await expect(callEndpoint(listIncoming, caller, { community: "signius" })).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.incoming).not.toHaveBeenCalled();
  });
});

describe("member_list", () => {
  it("names each member as the app does, with role, wallet and the live workgroups they lead", async () => {
    mocks.members.mockResolvedValue([
      { wallet_address: "addr_l", role: "admin", contributors: { handle: "Lee", github_username: "lee" } },
      { wallet_address: "addr_test1qzmemberwithnoprofile", role: "member", contributors: null },
    ]);
    mocks.workgroupsWithLeads.mockResolvedValue([
      { id: "wg-dev", name: "Development", archived_at: null, workgroup_leads: [{ wallet_address: "addr_l", contributors: null }] },
      { id: "wg-old", name: "Old", archived_at: "2026-01-01T00:00:00Z", workgroup_leads: [{ wallet_address: "addr_l", contributors: null }] },
    ]);
    const res = await callEndpoint(listMembers, caller, { community: "signius" });
    expect(mocks.members).toHaveBeenCalledWith("c1");
    expect(res.members).toEqual([
      { name: "Lee (@lee)", role: "admin", wallet: "addr_l", githubUsername: "lee", leads: ["Development"] },
      { name: expect.stringContaining("addr_test1"), role: "member", wallet: "addr_test1qzmemberwithnoprofile", githubUsername: null, leads: [] },
    ]);
    expect(res.url).toBe("http://localhost:3000/c/signius");
  });

  it("reads nothing for a non-member", async () => {
    mocks.role.mockResolvedValue(null);
    await expect(callEndpoint(listMembers, caller, { community: "signius" })).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.members).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TxModule from "@/lib/tx";
import type * as AuthzModule from "@/lib/authz";
import type * as SpendGuardModule from "@/lib/governance/spendGuard";
import { MSG } from "@/lib/constants";
import { BadRequestError, ConflictError, UnauthorizedError } from "@/lib/errors";
import { SPEND_CHECK_FAILED } from "@/lib/governance/spendGuard";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), context: vi.fn(), leads: vi.fn(), noPending: vi.fn(), withTx: vi.fn(), insertPayouts: vi.fn(),
  registry: vi.fn(), upsertMappings: vi.fn(),
  tasks: vi.fn(), livePayouts: vi.fn(), queue: vi.fn(), stampMonth: vi.fn(),
  setups: vi.fn(), sources: vi.fn(), assignments: vi.fn(), citations: vi.fn(),
  wallet: vi.fn(), build: vi.fn(), script: vi.fn(), provider: vi.fn(),
  guard: vi.fn(), dueAnchors: vi.fn(), recordAnchors: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  loadBuildContext: mocks.context,
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  leadsAllWorkgroups: mocks.leads,
}));
vi.mock("@/lib/db/transactions", () => ({
  assertNoPendingTx: mocks.noPending, withTransactionRow: mocks.withTx, insertPayouts: mocks.insertPayouts,
}));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry, upsertAssetMappings: mocks.upsertMappings }));
vi.mock("@/lib/db/tasks", () => ({
  loadTasksForBuild: mocks.tasks, tasksWithLivePayouts: mocks.livePayouts,
  claimTasksForPayout: mocks.queue, setBudgetMonthIfNull: mocks.stampMonth,
}));
vi.mock("@/lib/db/budgetSetups", () => ({
  loadBudgetSetupsForWorkgroups: mocks.setups, loadBudgetSources: mocks.sources,
}));
vi.mock("@/lib/db/workgroupRouting", () => ({ loadTreasuryAssignmentsForWorkgroups: mocks.assignments }));
vi.mock("@/lib/db/governance", () => ({ loadProposalCitations: mocks.citations }));
vi.mock("@/lib/governance/anchorsDue", () => ({ loadDueAnchorsBestEffort: mocks.dueAnchors }));
vi.mock("@/lib/db/anchors", () => ({ recordProposalAnchors: mocks.recordAnchors }));
vi.mock("@/lib/governance/spendGuard", async (importOriginal) => ({
  ...(await importOriginal<typeof SpendGuardModule>()),
  guardSpend: mocks.guard,
}));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.wallet }));
vi.mock("@/lib/cardano/payoutBuilder", () => ({ buildPayoutTx: mocks.build }));
vi.mock("@/lib/treasury", () => ({ resolveTreasuryScript: mocks.script }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));
import { POST } from "./route";

const GVTT = `${"a".repeat(56)}47565454`;
const OTHER_TOKEN = `${"b".repeat(56)}4f54484552`;
const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_TREASURY_ID = "40000000-0000-4000-8000-000000000002";
const WG_A = "50000000-0000-4000-8000-000000000001";
const WG_B = "50000000-0000-4000-8000-000000000002";
const TASK_A = "60000000-0000-4000-8000-000000000001";
const TASK_B = "60000000-0000-4000-8000-000000000002";
const TASK_PROPOSAL = "70000000-0000-4000-8000-000000000001";
const BUDGET_PROPOSAL = "70000000-0000-4000-8000-000000000002";
// Well-formed preprod enterprise addresses (random key hashes); assignee wallets come from the
// database, so only their network prefix matters here.
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const BOB = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const CAROL = "addr_test1vr9mtjy7453pue4fs0d6qmwwenvf6z2zay0a6a9vj3n7eeqdurjp6";
const TREASURY = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";
const MAINNET = "addr1v9mainnetwalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const context = { params: Promise.resolve({}) };
const request = (body: object, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/tx/build-payout", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  });
const body = (overrides: object = {}) => ({ treasuryId: TREASURY_ID, taskIds: [TASK_A], ...overrides });

const treasury = (overrides: object = {}) => ({
  id: TREASURY_ID, community_id: "community", name: "Main", address: TREASURY, network: 0,
  script_type: "atLeast", required: 2, script_cbor: "00", stake_credential_hash: null,
  template: "plain", lock_slot: null, lock_until: null,
  recovery_script_type: null, recovery_required: null, cosigner_kind: null,
  ...overrides,
});
const buildContext = (overrides: object = {}, treasuryOverrides: object = {}) => ({
  treasury: treasury(treasuryOverrides), signers: [], role: "admin", isSigner: true,
  callerGroups: new Set(), communitySlug: "guild", network: 0, ...overrides,
});
const assignee = (wallet: string | null, position = 0, gh_login: string | null = null) => ({
  id: `${wallet ?? "none"}-${position}`, source: "manual" as const, gh_login, gh_user_id: null, wallet_address: wallet, position,
});
/** A payable native task in the quarterly workgroup A with no budget month yet. */
const task = (overrides: object = {}) => ({
  id: TASK_A, number: 7, title: "Fix login", source: "native", bounty_lovelace: null,
  amounts: { ADA: "2.5", GVTT: "10" }, pay_state: "payable", archived_at: null, budget_month: null,
  workgroup_id: WG_A, proposal_id: null,
  workgroups: { community_id: "community", name: "Dev", archived_at: null },
  task_assignees: [assignee(ALICE)],
  ...overrides,
});
/** A second task in the monthly workgroup B, already placed in May. */
const taskB = (overrides: object = {}) => task({
  id: TASK_B, number: 8, title: "Write docs", amounts: { ADA: "1" }, budget_month: "2026-05-01",
  workgroup_id: WG_B, workgroups: { community_id: "community", name: "Ops", archived_at: null },
  task_assignees: [assignee(BOB)], ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  // Today is mid-August 2026: an unset task lands in Q3 of a quarterly workgroup.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.context.mockResolvedValue(buildContext());
  mocks.leads.mockResolvedValue(false);
  mocks.noPending.mockResolvedValue(undefined);
  mocks.registry.mockResolvedValue([]);
  mocks.upsertMappings.mockResolvedValue(undefined);
  mocks.tasks.mockResolvedValue([task()]);
  mocks.livePayouts.mockResolvedValue(new Set());
  mocks.queue.mockResolvedValue(undefined);
  mocks.stampMonth.mockResolvedValue(undefined);
  mocks.setups.mockResolvedValue(new Map([[WG_A, [{ starts_on: "2026-01-01", cadence: "quarterly" }]]]));
  mocks.sources.mockResolvedValue({ setups: new Map(), plans: [] });
  mocks.assignments.mockResolvedValue(new Map());
  mocks.citations.mockResolvedValue(new Map());
  mocks.wallet.mockResolvedValue({ lovelace: 100_000_000n, utxoCount: 2, tokens: [
    { unit: GVTT, quantity: 1_000_000_000n, ticker: "GVTT", name: "Test Token", decimals: 6, source: "registry" },
    { unit: OTHER_TOKEN, quantity: 1_000n, ticker: null, name: null, decimals: 0, source: "none" },
  ] });
  mocks.guard.mockResolvedValue([]);
  mocks.script.mockReturnValue({ address: TREASURY, scriptCbor: "00" });
  mocks.provider.mockReturnValue({});
  mocks.build.mockResolvedValue({
    unsignedTxHex: "84a0", txHash: "f".repeat(64),
    outputs: [{ address: ALICE, assets: [{ unit: "lovelace", quantity: 2_500_000n }, { unit: GVTT, quantity: 10_000_000n }] }],
    totalByUnit: new Map([["lovelace", 2_500_000n], [GVTT, 10_000_000n]]),
    anchorsCarried: [],
  });
  mocks.withTx.mockImplementation(async (_row: unknown, fn: (tx: { id: string }) => Promise<unknown>) => fn({ id: "tx-1" }));
  mocks.insertPayouts.mockResolvedValue(undefined);
  mocks.dueAnchors.mockResolvedValue([]);
  mocks.recordAnchors.mockResolvedValue(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("build-payout API", () => {
  describe("prologue", () => {
    it("requires a session", async () => {
      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await POST(request(body()), context)).status).toBe(401);
      expect(mocks.context).not.toHaveBeenCalled();
    });

    it("refuses a cross-site request before reading anything", async () => {
      expect((await POST(request(body(), { origin: "https://evil.test" }), context)).status).toBe(403);
      expect(mocks.session).not.toHaveBeenCalled();
      expect(mocks.context).not.toHaveBeenCalled();
    });

    it("rejects malformed bodies before touching the database", async () => {
      expect((await POST(request(body({ taskIds: [] })), context)).status).toBe(400);
      expect((await POST(request(body({ taskIds: ["nope"] })), context)).status).toBe(400);
      expect((await POST(request(body({ treasuryId: "nope" })), context)).status).toBe(400);
      expect((await POST(request(body({ path: "sideways" })), context)).status).toBe(400);
      expect((await POST(request(body({ connections: { ADA: 5 } })), context)).status).toBe(400);
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.noPending).not.toHaveBeenCalled();
    });

    it("surfaces a pending transaction as a conflict, from the early check and from the insert", async () => {
      mocks.noPending.mockRejectedValue(new ConflictError(MSG.pendingTxExists));
      let response = await POST(request(body()), context);
      expect(response.status).toBe(409);
      expect(mocks.tasks).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();

      mocks.noPending.mockResolvedValue(undefined);
      mocks.withTx.mockRejectedValue(new ConflictError(MSG.pendingTxExists));
      response = await POST(request(body()), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: MSG.pendingTxExists, conflict: true });
      expect(mocks.queue).not.toHaveBeenCalled();
    });
  });

  describe("who may build", () => {
    it("refuses a member who is neither base signer nor lead of every selected workgroup", async () => {
      mocks.context.mockResolvedValue(buildContext({ role: "member", isSigner: false }));
      mocks.tasks.mockResolvedValue([task(), taskB()]);
      const response = await POST(request(body({ taskIds: [TASK_A, TASK_B] })), context);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only signers of this treasury, or leads of all selected workgroups, can build payouts" });
      expect(mocks.leads).toHaveBeenCalledWith("admin", [WG_A, WG_B]);
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.withTx).not.toHaveBeenCalled();
    });

    it("lets a lead of every selected workgroup build", async () => {
      mocks.session.mockResolvedValue({ wallet: "lead" });
      mocks.context.mockResolvedValue(buildContext({ role: "member", isSigner: false }));
      mocks.leads.mockResolvedValue(true);
      const response = await POST(request(body()), context);
      expect(response.status).toBe(200);
      expect(mocks.leads).toHaveBeenCalledWith("lead", [WG_A]);
      expect(mocks.withTx).toHaveBeenCalledWith(expect.objectContaining({ created_by: "lead" }), expect.any(Function));
    });

    it("never consults the leads for a base signer; refuses an admin who does not sign", async () => {
      mocks.context.mockResolvedValue(buildContext({ role: "member", isSigner: true }));
      expect((await POST(request(body()), context)).status).toBe(200);
      expect(mocks.leads).not.toHaveBeenCalled();
      mocks.context.mockResolvedValue(buildContext({ role: "admin", isSigner: false }));
      mocks.leads.mockResolvedValue(false);
      expect((await POST(request(body()), context)).status).toBe(403);
    });
  });

  describe("spending paths", () => {
    it("never offers the recovery path for a payout", async () => {
      // A clawback treasury whose lock date has passed offers recovery for payments only.
      mocks.context.mockResolvedValue(buildContext({}, {
        template: "clawback", lock_slot: 12345, lock_until: "2026-01-01T00:00:00Z",
        recovery_script_type: "any", recovery_required: 1,
      }));
      let response = await POST(request(body({ path: "recovery" })), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: MSG.recoveryPaymentsOnly });
      // A plain treasury has no such path at all.
      mocks.context.mockResolvedValue(buildContext());
      response = await POST(request(body({ path: "recovery" })), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: MSG.pathNotOffered });
      expect(mocks.noPending).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    });

    it("refuses a lock-until treasury before its date and builds from the lock slot after it", async () => {
      mocks.context.mockResolvedValue(buildContext({}, {
        template: "lock_until", lock_slot: 99_000_000, lock_until: "2027-01-01T00:00:00Z",
      }));
      const response = await POST(request(body()), context);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/^This treasury is locked until /);
      expect(mocks.noPending).not.toHaveBeenCalled();

      mocks.context.mockResolvedValue(buildContext({}, {
        template: "lock_until", lock_slot: 12345, lock_until: "2026-01-01T00:00:00Z",
      }));
      expect((await POST(request(body()), context)).status).toBe(200);
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ validFromSlot: 12345 }));
      expect(mocks.withTx).toHaveBeenCalledWith(expect.objectContaining({ spending_path: "base" }), expect.any(Function));
    });
  });

  describe("task refusals", () => {
    it("refuses archived tasks (400) and tasks of archived workgroups (409) outright", async () => {
      mocks.tasks.mockResolvedValue([task(), taskB({ archived_at: "2026-08-01T00:00:00Z" })]);
      let response = await POST(request(body({ taskIds: [TASK_A, TASK_B] })), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Restore archived tasks before creating payouts" });

      mocks.tasks.mockResolvedValue([task(), taskB({ workgroups: { community_id: "community", name: "Ops", archived_at: "2026-08-01T00:00:00Z" } })]);
      response = await POST(request(body({ taskIds: [TASK_A, TASK_B] })), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "Restore archived workgroups before creating payouts" });
      expect(mocks.wallet).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    });

    it("lists every reason a task cannot be paid without building", async () => {
      const ids = Array.from({ length: 7 }, (_, i) => `60000000-0000-4000-8000-00000000001${i}`);
      mocks.tasks.mockResolvedValue([
        task({ id: ids[0], title: "T1", pay_state: "none" }),
        task({ id: ids[1], title: "T2" }),
        task({ id: ids[2], title: "T3", task_assignees: [assignee(ALICE), assignee(null, 1, "bob"), assignee(null, 2)] }),
        task({ id: ids[3], title: "T4", amounts: {}, bounty_lovelace: null }),
        taskB({ id: ids[4], title: "T5" }),
        // Foreign id ids[5] is omitted: loadTasksForBuild scopes by community.
        task({ id: ids[6], title: "T7", amounts: { ADA: "1", FOO: "3" } }),
      ]);
      mocks.livePayouts.mockResolvedValue(new Set([ids[1]]));
      // Workgroup B pays from another wallet since the start of the year.
      mocks.assignments.mockResolvedValue(new Map([[WG_B, [{ treasury_id: OTHER_TREASURY_ID, starts_on: "2026-01-01" }]]]));
      const response = await POST(request(body({ taskIds: ids })), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Some tasks are not payable",
        problems: [
          `${ids[5]}: task not found or not in this community`,
          "T1: not payable (state: none)",
          "T2: already in a payout transaction",
          "T3: @bob has no wallet linked",
          "T3: assignee #3 has no wallet",
          "T4: no bounty set",
          'T5: workgroup "Ops" is assigned to a different wallet for 2026-05',
          "T7: No asset mapping for field(s): FOO — connect them to a wallet token on the Payday page",
        ],
      });
      expect(mocks.livePayouts).toHaveBeenCalledWith([ids[0], ids[1], ids[2], ids[3], ids[4], ids[6]]);
      expect(mocks.guard).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.withTx).not.toHaveBeenCalled();
    });

    it("routes each task by its own budget period: a task from before a wallet change still builds here", async () => {
      // Workgroup A moves to another wallet from Q3; the May task (Q2 of a quarterly
      // workgroup) is still paid from this treasury, the unset one (today, Q3) is not.
      mocks.assignments.mockResolvedValue(new Map([[WG_A, [
        { treasury_id: null, starts_on: "2026-01-01" },
        { treasury_id: OTHER_TREASURY_ID, starts_on: "2026-07-01" },
      ]]]));
      mocks.tasks.mockResolvedValue([task({ id: TASK_B, number: 8, title: "Old task", budget_month: "2026-05-01" }), task()]);
      let response = await POST(request(body({ taskIds: [TASK_B, TASK_A] })), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Some tasks are not payable",
        problems: ['Fix login: workgroup "Dev" is assigned to a different wallet for 2026-Q3'],
      });

      mocks.tasks.mockResolvedValue([task({ id: TASK_B, number: 8, title: "Old task", budget_month: "2026-05-01" })]);
      response = await POST(request(body({ taskIds: [TASK_B] })), context);
      expect(response.status).toBe(200);
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
        recipients: [expect.objectContaining({ tasks: [expect.objectContaining({ taskNumber: 8, budgetPeriod: "2026-Q2" })] })],
      }));
      // Quarter-aligned month, already set: nothing to stamp.
      expect(mocks.stampMonth).not.toHaveBeenCalled();
    });

    it("refuses an assignee wallet on the other network, after the spending check and before building", async () => {
      mocks.tasks.mockResolvedValue([task({ task_assignees: [assignee(ALICE), assignee(MAINNET, 1)] })]);
      const response = await POST(request(body()), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Some assignee wallets are on a different network",
        problems: [`Tasks #7: ${MAINNET} is not a preprod address`],
      });
      expect(mocks.guard).toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.withTx).not.toHaveBeenCalled();
    });

    it("reports bad token connections and lets a good one override the auto-match", async () => {
      let response = await POST(request(body({ connections: { ada: GVTT, GVTT: "c".repeat(60), FOO: GVTT } })), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Some tasks are not payable",
        problems: ["ada: ADA is built in and cannot be reconnected", "GVTT: connected token is not held by this wallet"],
      });
      expect(mocks.build).not.toHaveBeenCalled();

      // A manual pick for the field (any case) replaces the ticker match and is persisted
      // under the batch's own spelling: one registry row per field.
      response = await POST(request(body({ connections: { gvtt: OTHER_TOKEN } })), context);
      expect(response.status).toBe(200);
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
        recipients: [expect.objectContaining({ tasks: [expect.objectContaining({
          amounts: [{ unit: "lovelace", quantity: 2_500_000n }, { unit: OTHER_TOKEN, quantity: 10n }],
        })] })],
      }));
      expect(mocks.upsertMappings).toHaveBeenLastCalledWith("community", [
        { fieldName: "GVTT", unit: OTHER_TOKEN, decimals: 0 },
      ]);

      // A token the wallet lacks is reported under that spelling too.
      response = await POST(request(body({ connections: { gvtt: "c".repeat(60) } })), context);
      expect(await response.json()).toMatchObject({ problems: ["GVTT: connected token is not held by this wallet"] });
    });
  });

  describe("the spending check", () => {
    it("checks every task's amounts times its assignees against the workgroup budgets and stores warnings on the row", async () => {
      mocks.tasks.mockResolvedValue([task({ task_assignees: [assignee(ALICE), assignee(CAROL, 1)] }), taskB()]);
      const problem = { code: "over_budget", ownerKey: `w:${WG_A}`, ownerName: "Dev", period: "2026-Q3", unit: "lovelace" };
      mocks.guard.mockResolvedValue([problem]);
      const response = await POST(request(body({ taskIds: [TASK_A, TASK_B] })), context);
      expect(response.status).toBe(200);
      expect(mocks.sources).toHaveBeenCalledWith([`w:${WG_A}`, `w:${WG_B}`]);
      expect(mocks.guard).toHaveBeenCalledExactlyOnceWith("community", [
        { ownerKey: `w:${WG_A}`, ownerType: "workgroup", ownerId: WG_A, ownerName: "Dev", periodMonth: "2026-07", unit: "lovelace", amount: 5_000_000n, ticker: "ADA", decimals: 6 },
        { ownerKey: `w:${WG_A}`, ownerType: "workgroup", ownerId: WG_A, ownerName: "Dev", periodMonth: "2026-07", unit: GVTT, amount: 20_000_000n, ticker: "GVTT", decimals: 6 },
        { ownerKey: `w:${WG_B}`, ownerType: "workgroup", ownerId: WG_B, ownerName: "Ops", periodMonth: "2026-05", unit: "lovelace", amount: 1_000_000n, ticker: "ADA", decimals: 6 },
      ], { setups: new Map(), plans: [] });
      expect(mocks.withTx).toHaveBeenCalledWith(expect.objectContaining({ spend_problems: [problem] }), expect.any(Function));
    });

    it("refuses the build when the community chose refuse mode", async () => {
      mocks.guard.mockRejectedValue(new BadRequestError(SPEND_CHECK_FAILED, { problems: ["Dev has no budget for 2026-Q3."] }));
      const response = await POST(request(body()), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "This spend does not fit the voted budgets",
        problems: ["Dev has no budget for 2026-Q3."],
      });
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.withTx).not.toHaveBeenCalled();
      expect(mocks.queue).not.toHaveBeenCalled();
    });
  });

  describe("citations and anchors", () => {
    it("cites the proposal that created a task and the one that set its period's budget", async () => {
      const H_TASK = "ab".repeat(32);
      const H_BUDGET = "cd".repeat(32);
      mocks.tasks.mockResolvedValue([task({ proposal_id: TASK_PROPOSAL }), taskB()]);
      mocks.sources.mockResolvedValue({
        setups: new Map([[`w:${WG_A}`, [{
          id: "s1", owner_key: `w:${WG_A}`, starts_on: "2026-01-01", mode: "recurring", cadence: "quarterly",
          amounts: [{ unit: "lovelace", amount: "100000000", asset_label: "ADA", decimals: 6 }], proposal_id: BUDGET_PROPOSAL,
        }]]]),
        plans: [],
      });
      mocks.citations.mockResolvedValue(new Map([
        [TASK_PROPOSAL, { id: TASK_PROPOSAL, number: 5, content_hash: H_TASK }],
        [BUDGET_PROPOSAL, { id: BUDGET_PROPOSAL, number: 2, content_hash: H_BUDGET }],
      ]));
      const response = await POST(request(body({ taskIds: [TASK_A, TASK_B] })), context);
      expect(response.status).toBe(200);
      expect(mocks.citations).toHaveBeenCalledWith([TASK_PROPOSAL, BUDGET_PROPOSAL]);
      // Sorted by number on the task entry; the task in the workgroup without a budget cites nothing.
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
        recipients: [
          expect.objectContaining({ contributorWallet: ALICE, tasks: [expect.objectContaining({
            taskNumber: 7, citations: [{ number: 2, contentHash: H_BUDGET }, { number: 5, contentHash: H_TASK }],
          })] }),
          expect.objectContaining({ contributorWallet: BOB, tasks: [expect.objectContaining({ taskNumber: 8, citations: [] })] }),
        ],
      }));
    });

    it("hands the community's due anchors to the builder and links the ones it carried, inside the row insert", async () => {
      const due = [
        { proposalId: "p1", number: 1, step: "proposed", entry: [1, "proposed", "a".repeat(64), "b".repeat(64)] },
        { proposalId: "p2", number: 2, step: "opened", entry: [2, "opened", "c".repeat(64)] },
      ];
      mocks.dueAnchors.mockResolvedValue(due);
      mocks.build.mockResolvedValue({ ...(await mocks.build()), anchorsCarried: [due[0]] });
      const order: string[] = [];
      mocks.withTx.mockImplementation(async (_row: unknown, fn: (tx: { id: string }) => Promise<unknown>) => {
        order.push("insert");
        return fn({ id: "tx-1" });
      });
      mocks.recordAnchors.mockImplementation(async () => { order.push("anchors"); return 1; });
      const response = await POST(request(body()), context);
      expect(response.status).toBe(200);
      expect(mocks.dueAnchors).toHaveBeenCalledWith("community");
      expect(mocks.build).toHaveBeenLastCalledWith(expect.objectContaining({ anchors: due }));
      expect(mocks.recordAnchors).toHaveBeenCalledExactlyOnceWith("tx-1", [due[0]]);
      expect(order).toEqual(["insert", "anchors"]);
      // Nothing due: the builder gets an empty list and nothing is linked.
      mocks.dueAnchors.mockResolvedValue([]);
      mocks.build.mockResolvedValue({ ...(await mocks.build()), anchorsCarried: [] });
      await POST(request(body()), context);
      expect(mocks.recordAnchors).toHaveBeenLastCalledWith("tx-1", []);
    });
  });

  describe("happy path", () => {
    it("builds one tx for two tasks, writes the payout rows, stamps the unset month, queues the tasks and answers with the built tx", async () => {
      mocks.tasks.mockResolvedValue([task(), taskB()]);
      mocks.build.mockResolvedValue({
        unsignedTxHex: "84a0", txHash: "f".repeat(64),
        outputs: [
          { address: ALICE, assets: [{ unit: "lovelace", quantity: 2_500_000n }, { unit: GVTT, quantity: 10_000_000n }] },
          { address: BOB, assets: [{ unit: "lovelace", quantity: 1_000_000n }] },
        ],
        totalByUnit: new Map([["lovelace", 3_500_000n], [GVTT, 10_000_000n]]),
        anchorsCarried: [],
      });
      const response = await POST(request(body({ taskIds: [TASK_A, TASK_B] })), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        txId: "tx-1", txHash: "f".repeat(64),
        totalByUnit: { lovelace: "3500000", [GVTT]: "10000000" },
        outputs: [
          { address: ALICE, assets: [{ unit: "lovelace", quantity: "2500000" }, { unit: GVTT, quantity: "10000000" }] },
          { address: BOB, assets: [{ unit: "lovelace", quantity: "1000000" }] },
        ],
      });
      expect(mocks.context).toHaveBeenCalledWith(TREASURY_ID, "admin");
      expect(mocks.noPending).toHaveBeenCalledWith(TREASURY_ID);
      expect(mocks.tasks).toHaveBeenCalledWith([TASK_A, TASK_B], "community");
      expect(mocks.setups).toHaveBeenCalledWith([WG_A, WG_B]);
      expect(mocks.assignments).toHaveBeenCalledWith([WG_A, WG_B]);
      expect(mocks.wallet).toHaveBeenCalledWith(0, TREASURY);
      expect(mocks.script).toHaveBeenCalledWith(expect.objectContaining({ id: TREASURY_ID }), []);
      expect(mocks.build).toHaveBeenCalledWith({
        treasuryAddress: TREASURY, scriptCbor: "00", communitySlug: "guild", network: 0, provider: {},
        recipients: [
          { contributorWallet: ALICE, tasks: [{
            taskId: TASK_A, taskNumber: 7, workgroupName: "Dev", budgetPeriod: "2026-Q3",
            amounts: [{ unit: "lovelace", quantity: 2_500_000n }, { unit: GVTT, quantity: 10_000_000n }], citations: [],
          }] },
          { contributorWallet: BOB, tasks: [{
            taskId: TASK_B, taskNumber: 8, workgroupName: "Ops", budgetPeriod: "2026-05",
            amounts: [{ unit: "lovelace", quantity: 1_000_000n }], citations: [],
          }] },
        ],
        unitDisplay: new Map([["lovelace", { ticker: "ADA", decimals: 6 }], [GVTT, { ticker: "GVTT", decimals: 6 }]]),
        anchors: [], validFromSlot: null,
      });
      // The auto-matched token mapping is persisted for later displays.
      expect(mocks.upsertMappings).toHaveBeenCalledWith("community", [{ fieldName: "GVTT", unit: GVTT, decimals: 6 }]);
      expect(mocks.withTx).toHaveBeenCalledWith({
        treasury_id: TREASURY_ID, kind: "payout", spending_path: "base", tx_cbor: "84a0", tx_hash: "f".repeat(64),
        description: "Payout: 2 tasks, 2 payments, 2 contributors (ADA, GVTT)", created_by: "admin", spend_problems: [],
      }, expect.any(Function));
      expect(mocks.insertPayouts).toHaveBeenCalledExactlyOnceWith([
        { transaction_id: "tx-1", task_id: TASK_A, contributor_wallet: ALICE, unit: "lovelace", amount: "2500000" },
        { transaction_id: "tx-1", task_id: TASK_A, contributor_wallet: ALICE, unit: GVTT, amount: "10000000" },
        { transaction_id: "tx-1", task_id: TASK_B, contributor_wallet: BOB, unit: "lovelace", amount: "1000000" },
      ]);
      // Only the unset task is stamped, with the quarter's first month.
      expect(mocks.stampMonth).toHaveBeenCalledExactlyOnceWith([TASK_A], "2026-07");
      expect(mocks.queue).toHaveBeenCalledExactlyOnceWith("tx-1", [TASK_A, TASK_B]);
    });

    it("pays every assignee the full amounts, one output per wallet, and a shared wallet once", async () => {
      mocks.tasks.mockResolvedValue([
        task({ task_assignees: [assignee(ALICE), assignee(CAROL, 1)] }),
        taskB({ task_assignees: [assignee(CAROL)] }),
      ]);
      const response = await POST(request(body({ taskIds: [TASK_A, TASK_B] })), context);
      expect(response.status).toBe(200);
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
        recipients: [
          expect.objectContaining({ contributorWallet: ALICE, tasks: [expect.objectContaining({ taskId: TASK_A })] }),
          expect.objectContaining({ contributorWallet: CAROL, tasks: [
            expect.objectContaining({ taskId: TASK_A }), expect.objectContaining({ taskId: TASK_B }),
          ] }),
        ],
      }));
      expect(mocks.withTx).toHaveBeenCalledWith(expect.objectContaining({
        description: "Payout: 2 tasks, 3 payments, 2 contributors (ADA, GVTT)",
      }), expect.any(Function));
      expect(mocks.insertPayouts).toHaveBeenCalledWith([
        expect.objectContaining({ task_id: TASK_A, contributor_wallet: ALICE, unit: "lovelace" }),
        expect.objectContaining({ task_id: TASK_A, contributor_wallet: ALICE, unit: GVTT }),
        expect.objectContaining({ task_id: TASK_A, contributor_wallet: CAROL, unit: "lovelace" }),
        expect.objectContaining({ task_id: TASK_A, contributor_wallet: CAROL, unit: GVTT }),
        expect.objectContaining({ task_id: TASK_B, contributor_wallet: CAROL, unit: "lovelace" }),
      ]);
    });

    it("falls back to bounty_lovelace for a task without amounts", async () => {
      mocks.tasks.mockResolvedValue([task({ amounts: null, bounty_lovelace: "4000000" })]);
      const response = await POST(request(body()), context);
      expect(response.status).toBe(200);
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
        recipients: [expect.objectContaining({ tasks: [expect.objectContaining({ amounts: [{ unit: "lovelace", quantity: 4_000_000n }] })] })],
      }));
      expect(mocks.upsertMappings).toHaveBeenCalledWith("community", []);
    });

    it("answers the builder's refusal of the payout itself with a 400 and its text, writing nothing", async () => {
      mocks.tasks.mockResolvedValue([task()]);
      mocks.build.mockRejectedValue(new Error("Insufficient treasury funds: short 3 ADA (incl. fee/min-UTxO headroom)"));
      const response = await POST(request(body()), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "Insufficient treasury funds: short 3 ADA (incl. fee/min-UTxO headroom)" });
      expect(mocks.upsertMappings).not.toHaveBeenCalled();
      expect(mocks.withTx).not.toHaveBeenCalled();
      // Anything else the builder throws stays a server error.
      mocks.build.mockRejectedValue(new Error("wasm panic"));
      expect((await POST(request(body()), context)).status).toBe(500);
    });
  });
});

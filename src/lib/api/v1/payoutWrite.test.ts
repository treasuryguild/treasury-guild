import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { BadRequestError, ConflictError, ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  treasuries: vi.fn(),
  workgroups: vi.fn(),
  listTasks: vi.fn(),
  byNumbers: vi.fn(),
  plan: vi.fn(),
  persist: vi.fn(),
  findByDraft: vi.fn(),
  labels: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/treasuries", () => ({ listCommunityTreasuries: mocks.treasuries }));
vi.mock("@/lib/db/workgroups", () => ({ listCommunityWorkgroups: mocks.workgroups }));
vi.mock("@/lib/db/tasks", () => ({ listCommunityTasks: mocks.listTasks, tasksByNumbers: mocks.byNumbers }));
vi.mock("@/lib/payout/build", () => ({ planPayout: mocks.plan, persistPayout: mocks.persist }));
vi.mock("@/lib/db/transactions", () => ({ findTransactionByDraft: mocks.findByDraft }));
vi.mock("@/lib/db/payments", () => ({ loadMemberLabels: mocks.labels }));

import { confirmDraft } from "./drafts";
import { callEndpoint } from "./endpoint";
import { previewPayout } from "./payoutWrite";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["payouts:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1 };
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };
const treasury = (id: string, name: string) => ({
  id, name, address: `addr_${id}`, network: 0, required: 2, script_type: "atLeast", template: "plain", lock_until: null,
  recovery_script_type: null, recovery_required: null, cosigner_kind: null,
  treasury_signers: [
    { wallet_address: "addr_a", display_name: "Ann", signer_group: "base" },
    { wallet_address: "addr_b", display_name: null, signer_group: "base" },
  ],
});
const MAIN = treasury("t-main", "Main");
const OPS = treasury("t-ops", "Ops");
const readyTask = (id: string, number: number, workgroup_id = "wg-dev") => ({
  id, number, workgroup_id, archived_at: null, amounts: { ADA: "50" }, bounty_lovelace: null,
  task_assignees: [{ id: "a", source: "manual", gh_login: null, wallet_address: "addr_x", position: 0, contributors: null }],
});
const plan = (quantity = 50_000_000n, problems: unknown[] = []) => ({
  treasuryId: "t-main",
  ctx: { treasury: MAIN, signers: MAIN.treasury_signers },
  path: "base",
  tasks: [{ id: "k1", number: 12, title: "Fix login", workgroups: { name: "Development" } }],
  periods: new Map([["k1", { month: "2026-10", code: "2026-10" }]]),
  recipients: [{ contributorWallet: "addr_x", tasks: [{ taskId: "k1", taskNumber: 12, amounts: [{ unit: "lovelace", quantity }] }] }],
  payments: 1,
  unitDisplay: new Map([["lovelace", { ticker: "ADA", decimals: 6 }]]),
  spendProblems: problems,
  built: { totalByUnit: new Map([["lovelace", quantity]]), txHash: "h".repeat(64), unsignedTxHex: "00", outputs: [] },
  carried: [],
  mappings: [],
});

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.CRON_SECRET = "cron-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("admin");
  mocks.treasuries.mockResolvedValue([MAIN]);
  mocks.workgroups.mockResolvedValue([
    { id: "wg-dev", name: "Development", kind: "native", archived_at: null, treasury_id: "t-main" },
    { id: "wg-ops", name: "Operations", kind: "native", archived_at: null, treasury_id: "t-ops" },
  ]);
  mocks.listTasks.mockResolvedValue({ tasks: [readyTask("k1", 12)], total: 1 });
  mocks.byNumbers.mockResolvedValue([{ id: "k1", number: 12, workgroup_id: "wg-dev" }]);
  mocks.plan.mockResolvedValue(plan());
  mocks.persist.mockResolvedValue({ id: "tx-1", tx_hash: "h".repeat(64), spending_path: "base" });
  mocks.findByDraft.mockResolvedValue(null);
  mocks.labels.mockResolvedValue(new Map([["addr_x", "Xi"]]));
});

const preview = (input: Record<string, unknown> = {}) => callEndpoint(previewPayout, caller, { community: "signius", ...input });
const confirm = (draftToken: string) => callEndpoint(confirmDraft, caller, { draftToken });

describe("payout_preview", () => {
  it("plans every ready task from the only treasury, writing nothing", async () => {
    const res = await preview();
    expect(mocks.listTasks).toHaveBeenCalledWith("c1", expect.objectContaining({ payState: "payable", includeArchived: false }));
    expect(mocks.plan).toHaveBeenCalledExactlyOnceWith({ treasuryId: "t-main", taskIds: ["k1"] }, "addr_w");
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      action: "payout_create",
      summary: "Prepare a payout of 1 task to 1 recipient from Main: 50 ADA",
      details: {
        treasury: "Main", requiredSignatures: 2,
        tasks: [{ number: 12, title: "Fix login", workgroup: "Development", budgetPeriod: "2026-10" }],
        recipients: [{ name: "Xi", wallet: "addr_x", tasks: [12], amounts: [{ token: "ADA", amount: "50" }] }],
        total: [{ token: "ADA", amount: "50" }],
      },
    });
    expect(res.effects.join(" ")).toContain("signers sign it in the app");
    expect(res.problems).toBeUndefined();
  });

  it("leaves out tasks that are not ready, and shows the budget problems", async () => {
    mocks.listTasks.mockResolvedValue({
      tasks: [readyTask("k1", 12), { ...readyTask("k2", 13), task_assignees: [{ id: "b", source: "github", gh_login: "bo", wallet_address: null, position: 0, contributors: null }] }],
      total: 2,
    });
    mocks.plan.mockResolvedValue(plan(50_000_000n, [{ code: "no_budget", ownerName: "Development", period: "Oct 2026" }]));
    const res = await preview();
    expect(mocks.plan).toHaveBeenCalledWith({ treasuryId: "t-main", taskIds: ["k1"] }, "addr_w");
    expect(res.problems).toEqual(["Development has no budget for Oct 2026."]);
  });

  it("picks the treasury the tasks are routed to, and asks when that is not one", async () => {
    mocks.treasuries.mockResolvedValue([MAIN, OPS]);
    await preview({ tasks: [12] });
    expect(mocks.plan).toHaveBeenCalledWith({ treasuryId: "t-main", taskIds: ["k1"] }, "addr_w");
    mocks.byNumbers.mockResolvedValue([{ id: "k1", number: 12, workgroup_id: "wg-dev" }, { id: "k9", number: 19, workgroup_id: "wg-ops" }]);
    await expect(preview({ tasks: [12, 19] })).rejects.toThrow("routed to different treasuries. Treasuries: Main, Ops");
    await preview({ tasks: [12, 19], treasury: "ops" });
    expect(mocks.plan).toHaveBeenLastCalledWith({ treasuryId: "t-ops", taskIds: ["k1", "k9"] }, "addr_w");
  });

  it("paying everything ready from one treasury leaves out what another pays", async () => {
    mocks.treasuries.mockResolvedValue([MAIN, OPS]);
    mocks.listTasks.mockResolvedValue({ tasks: [readyTask("k1", 12), readyTask("k9", 19, "wg-ops")], total: 2 });
    await preview({ treasury: "Main" });
    expect(mocks.plan).toHaveBeenCalledWith({ treasuryId: "t-main", taskIds: ["k1"] }, "addr_w");
  });

  it("refuses unknown task numbers, nothing to pay, and the app's own refusals", async () => {
    await expect(preview({ tasks: [12, 99] })).rejects.toThrow("No task #99");
    mocks.listTasks.mockResolvedValue({ tasks: [], total: 0 });
    await expect(preview()).rejects.toThrow("No task is ready to pay from Main");
    mocks.listTasks.mockResolvedValue({ tasks: [readyTask("k1", 12)], total: 1 });
    mocks.plan.mockRejectedValue(new ConflictError("A pending transaction already exists for this treasury"));
    await expect(preview()).rejects.toThrow("pending transaction already exists");
  });

  it("needs payouts:write", async () => {
    await expect(callEndpoint(previewPayout, { ...caller, scopes: ["tasks:write"] }, { community: "signius" }))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.plan).not.toHaveBeenCalled();
  });
});

describe("draft_confirm on a payout", () => {
  it("stores exactly the previewed payout as the pending transaction, keyed by the draft", async () => {
    const { draftToken } = await preview();
    const res = await confirm(draftToken);
    expect(mocks.plan).toHaveBeenLastCalledWith({ treasuryId: "t-main", taskIds: ["k1"] }, "addr_w");
    expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ treasuryId: "t-main" }), "addr_w", { agentDraftId: expect.stringMatching(/^[0-9a-f]{32}$/) },
    );
    expect(res).toEqual({
      action: "payout_create", community: { slug: "signius", name: "Signius" }, created: true, txId: "tx-1",
      txHash: "h".repeat(64), treasury: "Main", requiredSignatures: 2, url: "http://localhost:3000/c/signius/tx/tx-1",
    });
  });

  it("answers a repeat with the transaction already made, building nothing", async () => {
    const { draftToken } = await preview();
    mocks.plan.mockClear();
    mocks.findByDraft.mockResolvedValue({ id: "tx-1", tx_hash: "h".repeat(64), treasury_id: "t-main", spending_path: "base" });
    expect(await confirm(draftToken)).toMatchObject({ created: false, txId: "tx-1" });
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("counts the signatures of the stored path, the same on a repeat (a co-signer treasury)", async () => {
    const cosigned = {
      ...MAIN, template: "cosigner", cosigner_kind: "app",
      treasury_signers: [...MAIN.treasury_signers, { wallet_address: "addr_co", display_name: "Co-signer", signer_group: "cosigner" }],
    };
    mocks.treasuries.mockResolvedValue([cosigned]);
    mocks.plan.mockResolvedValue({ ...plan(), ctx: { treasury: cosigned, signers: cosigned.treasury_signers }, path: "cosigned" });
    mocks.persist.mockResolvedValue({ id: "tx-1", tx_hash: "h".repeat(64), spending_path: "cosigned" });
    const { draftToken } = await preview();
    const first = await confirm(draftToken);
    expect(first).toMatchObject({ created: true, requiredSignatures: 3 });

    mocks.findByDraft.mockResolvedValue({ id: "tx-1", tx_hash: "h".repeat(64), treasury_id: "t-main", spending_path: "cosigned" });
    expect(await confirm(draftToken)).toMatchObject({ created: false, requiredSignatures: 3 });
  });

  it("refuses a payout that changed since the preview", async () => {
    const { draftToken } = await preview();
    mocks.plan.mockResolvedValue(plan(60_000_000n));
    await expect(confirm(draftToken)).rejects.toThrow("changed since the preview");
    mocks.plan.mockResolvedValue(plan(50_000_000n, [{ code: "no_budget", ownerName: "Development", period: "Oct 2026" }]));
    await expect(confirm(draftToken)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("answers the confirmation that lost a race with the winner's transaction", async () => {
    const { draftToken } = await preview();
    mocks.persist.mockRejectedValue(new ConflictError("A pending transaction already exists for this treasury"));
    mocks.findByDraft.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "tx-1", tx_hash: "h".repeat(64), treasury_id: "t-main", spending_path: "base" });
    expect(await confirm(draftToken)).toMatchObject({ created: false, txId: "tx-1" });
  });

  it("passes on another pending transaction's 409, and refuses a token from another connection", async () => {
    const { draftToken } = await preview();
    mocks.persist.mockRejectedValue(new ConflictError("A pending transaction already exists for this treasury"));
    await expect(confirm(draftToken)).rejects.toThrow("pending transaction already exists");
    await expect(callEndpoint(confirmDraft, { ...caller, clientId: "c2" }, { draftToken })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(confirm("nope")).rejects.toBeInstanceOf(BadRequestError);
  });
});

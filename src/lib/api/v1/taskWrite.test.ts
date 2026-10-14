import { decodeJwt } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { sha256Hex } from "@/lib/auth/crypto";
import { BadRequestError, ConflictError, ForbiddenError } from "@/lib/errors";
import { canonicalJson } from "@/lib/governance/rules";
import { mintDraftToken } from "@/lib/mcp/draftToken";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  manager: vi.fn(),
  workgroups: vi.fn(),
  setups: vi.fn(),
  byNumber: vi.fn(),
  byId: vi.fn(),
  column: vi.fn(),
  findByDraft: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role, requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", () => ({ listCommunityWorkgroups: mocks.workgroups }));
vi.mock("@/lib/db/budgetSetups", () => ({ loadBudgetSetupsForWorkgroups: mocks.setups }));
vi.mock("@/lib/db/tasks", () => ({
  loadTaskByNumber: mocks.byNumber,
  loadEditableTask: mocks.byId,
  firstOpenColumn: mocks.column,
  findTaskByDraft: mocks.findByDraft,
  insertNativeTask: mocks.insert,
  updateNativeTaskFields: mocks.update,
}));

import { confirmDraft } from "./drafts";
import { callEndpoint } from "./endpoint";
import { previewTaskSave } from "./taskWrite";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["tasks:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1 };
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };
const BOARD = { id: "wg-1", name: "Design", kind: "native", archived_at: null, treasury_id: null };
const task = (patch: Record<string, unknown> = {}) => ({
  id: "t-12", number: 12, title: "Logo", body: null, amounts: { ADA: "50" }, bounty_lovelace: 50_000_000,
  budget_month: null, source: "native", pay_state: "none", archived_at: null, community_id: "c1", workgroup_id: "wg-1", ...patch,
});

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.CRON_SECRET = "cron-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("member");
  mocks.manager.mockResolvedValue(undefined);
  mocks.workgroups.mockResolvedValue([BOARD]);
  mocks.setups.mockResolvedValue(new Map());
  mocks.column.mockResolvedValue({ id: "col-todo", name: "To Do" });
  mocks.findByDraft.mockResolvedValue(null);
  mocks.insert.mockResolvedValue({ id: "t-13", number: 13 });
  mocks.byNumber.mockResolvedValue(task());
  mocks.byId.mockResolvedValue(task());
  mocks.update.mockResolvedValue(true);
});

const preview = (input: Record<string, unknown>) => callEndpoint(previewTaskSave, caller, { community: "signius", ...input });
const confirm = (draftToken: string) => callEndpoint(confirmDraft, caller, { draftToken });

/** A task_save draft signed for this caller; the fingerprint is the request's own unless given. */
async function draftFor(request: Record<string, unknown>, fingerprint = sha256Hex(canonicalJson(request))): Promise<string> {
  const { token } = await mintDraftToken(caller, { action: "task_save", community: "signius", request, fingerprint, rulesHash: "" });
  return token;
}
const requestOf = (draftToken: string) => decodeJwt(draftToken).req as Record<string, unknown>;
const fingerprintOf = (draftToken: string) => decodeJwt(draftToken).fp as string;
const INVALID_DRAFT = "This draft is not valid: preview it again";

describe("task_preview: create", () => {
  it("previews a task in the board's first open column, not payable, with the reward validated", async () => {
    const res = await preview({ workgroup: "design", title: "Poster", body: "A3", reward: { ADA: "25", HOSKY: "1000" }, budgetMonth: "2026-11" });
    expect(mocks.manager).toHaveBeenCalledWith("c1", "wg-1", "addr_w", expect.any(String));
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      action: "task_save",
      summary: 'Create the task "Poster" on Design',
      details: { change: "create", workgroup: "Design", column: "To Do", title: "Poster", body: "A3", reward: { ADA: "25", HOSKY: "1000" }, budgetMonth: "2026-11" },
    });
  });

  it("moves the budget month to its quarter when the workgroup is budgeted by quarter", async () => {
    mocks.setups.mockResolvedValue(new Map([["wg-1", [{ starts_on: "2026-01-01", cadence: "quarterly" }]]]));
    const res = await preview({ workgroup: "Design", title: "Poster", budgetMonth: "2026-11" });
    expect(res.details).toMatchObject({ budgetMonth: "2026-10" });
  });

  it("refuses a GitHub board, an archived one, a bad reward and a non-manager", async () => {
    mocks.workgroups.mockResolvedValue([{ ...BOARD, kind: "github" }]);
    await expect(preview({ workgroup: "Design", title: "Poster" })).rejects.toThrow("GitHub board");
    mocks.workgroups.mockResolvedValue([{ ...BOARD, archived_at: "2026-01-01" }]);
    await expect(preview({ workgroup: "Design", title: "Poster" })).rejects.toBeInstanceOf(ConflictError);
    mocks.workgroups.mockResolvedValue([BOARD]);
    await expect(preview({ workgroup: "Design", title: "Poster", reward: { ADA: "lots" } })).rejects.toBeInstanceOf(BadRequestError);
    await expect(preview({ title: "Poster" })).rejects.toThrow("give workgroup and title");
    mocks.manager.mockRejectedValue(new ForbiddenError("Only admins and the workgroup's leads can change its tasks"));
    await expect(preview({ workgroup: "Design", title: "Poster" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates it once, keyed by the draft", async () => {
    const { draftToken } = await preview({ workgroup: "Design", title: "Poster", reward: { ADA: "25" } });
    const res = await confirm(draftToken);
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith({
      title: "Poster", body: null, amounts: { ADA: "25" }, bounty_lovelace: "25000000", budget_month: null,
      workgroup_id: "wg-1", column_id: "col-todo", agent_draft_id: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(res).toMatchObject({ action: "task_save", created: true, change: "created", number: 13, url: "http://localhost:3000/c/signius/boards/wg-1" });

    mocks.findByDraft.mockResolvedValue({ id: "t-13", number: 13 });
    expect(await confirm(draftToken)).toMatchObject({ created: false, number: 13 });
    expect(mocks.insert).toHaveBeenCalledOnce();
  });

  it("refuses when the board's columns changed since the preview", async () => {
    const { draftToken } = await preview({ workgroup: "Design", title: "Poster" });
    mocks.column.mockResolvedValue({ id: "col-new", name: "Backlog" });
    await expect(confirm(draftToken)).rejects.toThrow("columns changed");
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers from the draft's row when a concurrent confirm inserted it first", async () => {
    const { draftToken } = await preview({ workgroup: "Design", title: "Poster" });
    // The insert lost the agent_draft_id race (null); the re-read finds the winner's row.
    mocks.insert.mockResolvedValue(null);
    mocks.findByDraft.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "t-13", number: 13 });
    const res = await confirm(draftToken);
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.findByDraft).toHaveBeenCalledTimes(2);
    expect(mocks.findByDraft.mock.calls[1]).toEqual(mocks.findByDraft.mock.calls[0]);
    expect(res).toMatchObject({ action: "task_save", created: false, change: "created", number: 13, title: "Poster", workgroup: "Design" });
  });

  it("refuses with a conflict when the insert finds nothing and the draft has no row either", async () => {
    const { draftToken } = await preview({ workgroup: "Design", title: "Poster" });
    mocks.insert.mockResolvedValue(null);
    const err = await confirm(draftToken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toHaveProperty("message", "The task could not be created. Preview it again.");
    expect(mocks.findByDraft).toHaveBeenCalledTimes(2);
  });

  it("refuses when the workgroup is gone by the confirm", async () => {
    const { draftToken } = await preview({ workgroup: "Design", title: "Poster" });
    mocks.workgroups.mockResolvedValue([]);
    const err = await confirm(draftToken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toHaveProperty("message", "The task's workgroup is gone");
    expect(mocks.findByDraft).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("task_preview: draft validity", () => {
  it("refuses a create or an edit whose request no longer matches its fingerprint", async () => {
    const created = (await preview({ workgroup: "Design", title: "Poster" })).draftToken;
    const forgedCreate = await draftFor(
      { ...requestOf(created), fields: { ...(requestOf(created).fields as object), amounts: { ADA: "9999" } } },
      fingerprintOf(created),
    );
    const edited = (await preview({ task: 12, title: "Logo v2" })).draftToken;
    const forgedEdit = await draftFor({ ...requestOf(edited), taskId: "t-other" }, fingerprintOf(edited));
    for (const forged of [forgedCreate, forgedEdit]) {
      const err = await confirm(forged).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestError);
      expect(err).toHaveProperty("message", INVALID_DRAFT);
    }
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.byId).not.toHaveBeenCalled();
  });

  it("refuses a well-signed request of no known shape", async () => {
    const shapes: Record<string, unknown>[] = [
      { mode: "delete", taskId: "t-12" },
      { mode: "create", workgroupId: "wg-1", fields: { title: "Poster" } },
      { mode: "update", taskId: "t-12", before: { title: "Logo" } },
    ];
    for (const request of shapes) {
      const err = await confirm(await draftFor(request)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestError);
      expect(err).toHaveProperty("message", INVALID_DRAFT);
    }
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("task_preview: edit", () => {
  it("shows before and after, and saves only while the task is still unpaid", async () => {
    const res = await preview({ task: 12, title: "Logo v2", reward: { ADA: "75" } });
    expect(res.details).toMatchObject({
      change: "update", number: 12,
      before: { title: "Logo", reward: { ADA: "50" } },
      after: { title: "Logo v2", reward: { ADA: "75" } },
    });
    const done = await confirm(res.draftToken);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("t-12", {
      title: "Logo v2", body: null, amounts: { ADA: "75" }, bounty_lovelace: "75000000", budget_month: null,
    });
    expect(done).toMatchObject({ created: true, change: "updated", number: 12, title: "Logo v2" });
  });

  it("refuses a payable, GitHub or archived task, and an edit that changes nothing", async () => {
    mocks.byNumber.mockResolvedValue(task({ pay_state: "payable" }));
    await expect(preview({ task: 12, title: "X" })).rejects.toThrow("is payable");
    mocks.byNumber.mockResolvedValue(task({ source: "github" }));
    await expect(preview({ task: 12, title: "X" })).rejects.toThrow("comes from GitHub");
    mocks.byNumber.mockResolvedValue(task({ archived_at: "2026-01-01" }));
    await expect(preview({ task: 12, title: "X" })).rejects.toThrow("is archived");
    mocks.byNumber.mockResolvedValue(task());
    await expect(preview({ task: 12, title: "Logo" })).rejects.toThrow("Nothing to change");
    mocks.byNumber.mockResolvedValue(null);
    await expect(preview({ task: 99, title: "X" })).rejects.toThrow("No task #99");
  });

  it("answers a repeat as done, and refuses a task that moved on", async () => {
    const { draftToken } = await preview({ task: 12, title: "Logo v2" });
    mocks.byId.mockResolvedValue(task({ title: "Logo v2" }));
    expect(await confirm(draftToken)).toMatchObject({ created: false });
    mocks.byId.mockResolvedValue(task({ title: "Someone else's title" }));
    await expect(confirm(draftToken)).rejects.toThrow("changed since the preview");
    // Made payable between the check and the write: the conditional update finds nothing.
    mocks.byId.mockResolvedValue(task());
    mocks.update.mockResolvedValue(false);
    await expect(confirm(draftToken)).rejects.toThrow("moved on");
  });

  it("refuses when the task, or its workgroup, is gone by the confirm", async () => {
    const { draftToken } = await preview({ task: 12, title: "Logo v2" });
    mocks.byId.mockResolvedValue(null);
    await expect(confirm(draftToken)).rejects.toThrow("The task is gone");
    // Moved to another community counts as gone here.
    mocks.byId.mockResolvedValue(task({ community_id: "c2" }));
    await expect(confirm(draftToken)).rejects.toThrow("The task is gone");
    mocks.byId.mockResolvedValue(task());
    mocks.workgroups.mockResolvedValue([]);
    const err = await confirm(draftToken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toHaveProperty("message", "The task's workgroup is gone");
    expect(mocks.byId).toHaveBeenCalledWith("t-12");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { PgCode } from "@/lib/constants";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

import {
  findTaskByDraft, firstOpenColumn, insertNativeTask, loadEditableTask, loadTaskByNumber, releaseOrphanedQueuedTasks, taskNumberMap, taskNumbers,
  tasksByNumbers, updateNativeTaskFields,
} from "./tasks";

const DRAFT = "d0000000-0000-4000-8000-000000000001";
const refusal = (code: string, message: string) => ({ data: null, error: new PostgrestError({ message, code, details: "", hint: "" }) });

/** A query builder that records its chain and resolves to `result`. */
function recordQuery(result: { data?: unknown; error: PostgrestError | null }) {
  const calls: unknown[][] = [];
  const query: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko),
  };
  for (const method of ["select", "update", "eq", "is", "in", "order", "limit", "maybeSingle"]) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  }
  mocks.from.mockReturnValue(query);
  return calls;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("releaseOrphanedQueuedTasks", () => {
  it("runs release_orphaned_queued_tasks and returns how many it released", async () => {
    mocks.rpc.mockResolvedValue({ data: 3, error: null });
    expect(await releaseOrphanedQueuedTasks()).toBe(3);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("release_orphaned_queued_tasks");
  });

  it("reads no answer as none released", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await releaseOrphanedQueuedTasks()).toBe(0);
  });

  it("throws when the database refuses", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new PostgrestError({ message: "deadlock detected", code: PgCode.DeadlockDetected, details: "", hint: "" }) });
    await expect(releaseOrphanedQueuedTasks()).rejects.toThrow("deadlock detected");
  });
});

describe("insertNativeTask", () => {
  const ROW = {
    workgroup_id: "wg-1", column_id: "col-1", agent_draft_id: DRAFT,
    title: "Write docs", body: null, amounts: { ADA: "5" }, bounty_lovelace: "5000000", budget_month: null,
  };
  let insert: ReturnType<typeof vi.fn>;
  const answer = (res: unknown) => {
    insert = vi.fn(() => ({ select: () => ({ single: async () => res }) }));
    mocks.from.mockReturnValue({ insert });
  };

  it("inserts a native task, neither payable nor audited, keyed by the draft", async () => {
    answer({ data: { id: "t-1", number: 7 }, error: null });
    expect(await insertNativeTask(ROW)).toEqual({ id: "t-1", number: 7 });
    expect(mocks.from).toHaveBeenCalledWith("tasks");
    expect(insert).toHaveBeenCalledExactlyOnceWith({ ...ROW, source: "native", pay_state: "none", audited: false });
  });

  it("answers null when the draft already made a task (unique agent_draft_id)", async () => {
    answer(refusal(PgCode.UniqueViolation, "duplicate key value violates unique constraint \"tasks_agent_draft_uq\""));
    expect(await insertNativeTask(ROW)).toBeNull();
  });

  it("throws any other failure", async () => {
    answer(refusal("42501", "permission denied"));
    await expect(insertNativeTask(ROW)).rejects.toThrow();
  });
});

describe("findTaskByDraft", () => {
  it("looks the task up by agent_draft_id, null when the draft made none", async () => {
    let found: unknown = { id: "t-1", number: 7 };
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: found, error: null }) }));
    mocks.from.mockReturnValue({ select: () => ({ eq }) });
    expect(await findTaskByDraft(DRAFT)).toEqual({ id: "t-1", number: 7 });
    expect(eq).toHaveBeenCalledWith("agent_draft_id", DRAFT);
    found = null;
    expect(await findTaskByDraft(DRAFT)).toBeNull();
  });
});

describe("loadTaskByNumber / loadEditableTask", () => {
  const TASK = { id: "t-1", number: 7, title: "Docs", source: "native", pay_state: "none", community_id: "comm-1", workgroup_id: "wg-1" };

  it("loads the community's task #N, scoped to the community", async () => {
    const calls = recordQuery({ data: TASK, error: null });
    expect(await loadTaskByNumber("comm-1", 7)).toEqual(TASK);
    expect(mocks.from).toHaveBeenCalledWith("tasks");
    expect(calls).toContainEqual(["eq", "community_id", "comm-1"]);
    expect(calls).toContainEqual(["eq", "number", 7]);
    expect(calls).toContainEqual(["maybeSingle"]);
  });

  it("answers null when the community has no such task", async () => {
    recordQuery({ data: null, error: null });
    expect(await loadTaskByNumber("comm-1", 99)).toBeNull();
  });

  it("loads a task by id, null when it is gone", async () => {
    const calls = recordQuery({ data: TASK, error: null });
    expect(await loadEditableTask("t-1")).toEqual(TASK);
    expect(calls).toContainEqual(["eq", "id", "t-1"]);
    recordQuery({ data: null, error: null });
    expect(await loadEditableTask("t-x")).toBeNull();
  });

  it("throws when the read fails", async () => {
    recordQuery(refusal("42501", "permission denied"));
    await expect(loadTaskByNumber("comm-1", 7)).rejects.toThrow("load task by number: permission denied");
  });
});

describe("firstOpenColumn", () => {
  it("takes the board's first column that is neither payable nor paid", async () => {
    const calls = recordQuery({ data: [{ id: "col-1", name: "Backlog" }], error: null });
    expect(await firstOpenColumn("wg-1")).toEqual({ id: "col-1", name: "Backlog" });
    expect(mocks.from).toHaveBeenCalledWith("board_columns");
    expect(calls).toContainEqual(["eq", "workgroup_id", "wg-1"]);
    expect(calls).toContainEqual(["eq", "marks_payable", false]);
    expect(calls).toContainEqual(["eq", "marks_paid", false]);
    expect(calls).toContainEqual(["order", "position"]);
    expect(calls).toContainEqual(["limit", 1]);
  });

  it("answers null for a board with no open column", async () => {
    recordQuery({ data: [], error: null });
    expect(await firstOpenColumn("wg-1")).toBeNull();
  });
});

describe("updateNativeTaskFields", () => {
  const FIELDS = { title: "Docs v2", body: null, amounts: { ADA: "6" }, bounty_lovelace: "6000000", budget_month: "2026-10-01" };

  it("updates only a native, unarchived task still at pay_state none, in the update itself", async () => {
    const calls = recordQuery({ data: [{ id: "t-1" }], error: null });
    expect(await updateNativeTaskFields("t-1", FIELDS)).toBe(true);
    expect(mocks.from).toHaveBeenCalledWith("tasks");
    expect(calls).toContainEqual(["update", FIELDS]);
    expect(calls).toContainEqual(["eq", "id", "t-1"]);
    expect(calls).toContainEqual(["eq", "source", "native"]);
    expect(calls).toContainEqual(["eq", "pay_state", "none"]);
    expect(calls).toContainEqual(["is", "archived_at", null]);
  });

  it("answers false when no row matched (the task moved on meanwhile)", async () => {
    recordQuery({ data: [], error: null });
    expect(await updateNativeTaskFields("t-1", FIELDS)).toBe(false);
  });

  it("throws when the update fails", async () => {
    recordQuery(refusal("42501", "permission denied"));
    await expect(updateNativeTaskFields("t-1", FIELDS)).rejects.toThrow("update native task: permission denied");
  });
});

describe("taskNumberMap / taskNumbers", () => {
  it("reads nothing for no tasks", async () => {
    expect(await taskNumberMap([])).toEqual(new Map());
    expect(await taskNumbers([])).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("asks once per distinct id and maps id to number", async () => {
    const calls = recordQuery({ data: [{ id: "t-1", number: 7 }, { id: "t-2", number: 9 }], error: null });
    expect(await taskNumberMap(["t-1", "t-2", "t-1"])).toEqual(new Map([["t-1", 7], ["t-2", 9]]));
    expect(calls).toContainEqual(["in", "id", ["t-1", "t-2"]]);
  });

  it("keeps the given order and leaves out tasks that are gone", async () => {
    // The database answers in its own order, without the deleted t-2.
    recordQuery({ data: [{ id: "t-3", number: 12 }, { id: "t-1", number: 7 }], error: null });
    expect(await taskNumbers(["t-1", "t-2", "t-3"])).toEqual([7, 12]);
  });
});

describe("tasksByNumbers", () => {
  it("reads nothing for no numbers", async () => {
    expect(await tasksByNumbers("comm-1", [])).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("loads the community's tasks with these numbers", async () => {
    const found = [{ id: "t-1", number: 7, workgroup_id: "wg-1" }];
    const calls = recordQuery({ data: found, error: null });
    expect(await tasksByNumbers("comm-1", [7, 8])).toEqual(found);
    expect(calls).toContainEqual(["eq", "community_id", "comm-1"]);
    expect(calls).toContainEqual(["in", "number", [7, 8]]);
  });
});

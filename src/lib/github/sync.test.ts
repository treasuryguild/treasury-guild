import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ active: vi.fn(), client: vi.fn(), fetchIssues: vi.fn() }));
vi.mock("@/lib/db/workgroups", () => ({ workgroupIsActive: mocks.active }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: mocks.client }));
vi.mock("./projectsV2", () => ({ fetchRepoIssuesWithProjectFields: mocks.fetchIssues }));
import { fullSyncRepo, syncGithubIssue, upsertProjectLink, type RepoLink } from "./sync";

const repo: RepoLink = { id: 1, installation_id: 1, full_name: "guild/repo", workgroup_id: "group-1", payable_label: "audited", import_status: "In review", paid_status: "Paid" };
beforeEach(() => { vi.resetAllMocks(); mocks.active.mockResolvedValue(false); });
describe("archived GitHub workgroups", () => {
  it("skips webhook writes", async () => {
    expect(await syncGithubIssue(repo, { repoId: 1, issueNumber: 1, nodeId: "node", title: "Issue", body: null, url: "https://github.com/guild/repo/issues/1", labels: ["audited"] }, true)).toBe("skip");
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("skips cron/manual sweeps before fetching GitHub data", async () => {
    expect(await fullSyncRepo(repo)).toEqual({ synced: 0, deleted: 0 });
    expect(mocks.fetchIssues).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("does not discover new project links while archived", async () => {
    await upsertProjectLink("project", 1, "group-1");
    expect(mocks.client).not.toHaveBeenCalled();
  });
});

// The sync's reads go through maybe() / rows(): a failed read throws instead
// of looking like "no rows", which would insert duplicates or delete tasks
// whose payout rows could not be seen.
describe("failed database reads", () => {
  interface Op { table: string; op: "select" | "insert" | "update" | "delete" | "upsert"; columns?: string; filters: [string, unknown][] }
  type Answer = { data: unknown; error: { message: string } | null };
  const ok = (data: unknown): Answer => ({ data, error: null });
  const broken: Answer = { data: null, error: { message: "connection reset" } };
  let ops: Op[];
  let answer: (op: Op) => Answer;

  function builder(table: string) {
    const op: Op = { table, op: "select", filters: [] };
    const record = (k: string, v: unknown) => { op.filters.push([k, v]); return chain; };
    const write = (kind: Op["op"]) => () => { op.op = kind; return chain; };
    const chain = {
      // A select after a write (insert().select("id")) reads the written row back.
      select: (columns: string) => { if (op.op === "select") op.columns = columns; return chain; },
      insert: write("insert"), update: write("update"), delete: write("delete"), upsert: write("upsert"),
      eq: record, in: record,
      limit: () => chain, maybeSingle: () => chain, single: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        ops.push(op);
        return Promise.resolve(answer(op)).then(resolve, reject);
      },
    };
    return chain;
  }

  const issue = { repoId: 1, issueNumber: 7, nodeId: "node", title: "Issue", body: null, url: "https://github.com/guild/repo/issues/7", labels: ["audited"] };
  const writes = () => ops.filter((o) => o.op !== "select");
  const deletes = () => ops.filter((o) => o.op === "delete");
  const is = (op: Op, table: string, kind: Op["op"], columns?: string) =>
    op.table === table && op.op === kind && (columns === undefined || op.columns === columns);

  beforeEach(() => {
    ops = [];
    answer = () => ok(null);
    mocks.active.mockResolvedValue(true);
    mocks.client.mockReturnValue({ from: builder });
    mocks.fetchIssues.mockResolvedValue([]);
  });

  describe("syncGithubIssue", () => {
    it("aborts when the task cannot be read, instead of inserting it as new", async () => {
      answer = (op) => (is(op, "tasks", "select") ? broken : ok(null));
      await expect(syncGithubIssue(repo, issue, true)).rejects.toThrow("sync: load task: connection reset");
      expect(writes()).toEqual([]);
    });

    it("aborts when the task cannot be read, instead of skipping a task that left the filter", async () => {
      answer = (op) => (is(op, "tasks", "select") ? broken : ok(null));
      await expect(syncGithubIssue(repo, issue, false)).rejects.toThrow("sync: load task");
      expect(writes()).toEqual([]);
    });

    it("does not delete a task whose payout rows could not be checked", async () => {
      answer = (op) => {
        if (is(op, "tasks", "select")) return ok({ id: "task-7", pay_state: "payable" });
        if (is(op, "payouts", "select")) return broken;
        return ok(null);
      };
      await expect(syncGithubIssue(repo, issue, false)).rejects.toThrow("sync: check task payouts: connection reset");
      expect(deletes()).toEqual([]);
    });

    it("deletes an unpaid task that left the filter only when the read shows no payout rows", async () => {
      let payout: Answer = ok({ id: "po-1" });
      answer = (op) => {
        if (is(op, "tasks", "select")) return ok({ id: "task-7", pay_state: "payable" });
        if (is(op, "payouts", "select")) return payout;
        return ok(null);
      };
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(await syncGithubIssue(repo, issue, false)).toBe("skip");
        expect(deletes()).toEqual([]);
        expect(warned).toHaveBeenCalledTimes(1);
      } finally {
        warned.mockRestore();
      }

      payout = ok(null);
      expect(await syncGithubIssue(repo, issue, false)).toBe("delete");
      expect(deletes()).toEqual([expect.objectContaining({ table: "tasks", filters: [["id", "task-7"]] })]);
    });

    it("reports a delete that failed", async () => {
      answer = (op) => {
        if (is(op, "tasks", "select")) return ok({ id: "task-7", pay_state: "none" });
        if (is(op, "tasks", "delete")) return broken;
        return ok(null);
      };
      await expect(syncGithubIssue(repo, issue, false)).rejects.toThrow("sync: delete task: connection reset");
    });
  });

  describe("fullSyncRepo", () => {
    const REPO_TASKS = "gh_issue_number, gh_project_item_node_id";
    const CANDIDATES = "id, gh_issue_number";
    const stale = [{ id: "task-1", gh_issue_number: 1 }, { id: "task-2", gh_issue_number: 2 }];

    it("aborts when the repo's tasks cannot be read: nothing synced, deleted or stamped", async () => {
      answer = (op) => (is(op, "tasks", "select", REPO_TASKS) ? broken : ok([]));
      await expect(fullSyncRepo(repo)).rejects.toThrow("sync: load repo tasks: connection reset");
      expect(writes()).toEqual([]);
    });

    it("aborts when the deletion candidates cannot be read", async () => {
      answer = (op) => (is(op, "tasks", "select", CANDIDATES) ? broken : ok([]));
      await expect(fullSyncRepo(repo)).rejects.toThrow("sync: load deletion candidates: connection reset");
      expect(writes()).toEqual([]);
    });

    it("deletes no stale task when their payout rows cannot be read", async () => {
      answer = (op) => {
        if (is(op, "tasks", "select", CANDIDATES)) return ok(stale);
        if (is(op, "payouts", "select")) return broken;
        return ok([]);
      };
      await expect(fullSyncRepo(repo)).rejects.toThrow("sync: check stale task payouts: connection reset");
      expect(deletes()).toEqual([]);
      // The sweep did not finish, so its cursor is not moved either.
      expect(writes()).toEqual([]);
      const guard = ops.find((o) => is(o, "payouts", "select"));
      expect(guard?.filters).toEqual([["task_id", ["task-1", "task-2"]]]);
    });

    it("deletes the stale tasks a successful read shows to have no payout rows, and keeps the others", async () => {
      answer = (op) => {
        if (is(op, "tasks", "select", CANDIDATES)) return ok(stale);
        if (is(op, "payouts", "select")) return ok([{ task_id: "task-1" }]);
        return ok([]);
      };
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(await fullSyncRepo(repo)).toEqual({ synced: 0, deleted: 1 });
      } finally {
        warned.mockRestore();
      }
      expect(deletes()).toEqual([expect.objectContaining({ table: "tasks", filters: [["id", ["task-2"]]] })]);
      expect(ops.some((o) => is(o, "github_repos", "update"))).toBe(true);
    });

    it("reports a stale-task delete that failed instead of counting it", async () => {
      answer = (op) => {
        if (is(op, "tasks", "select", CANDIDATES)) return ok(stale);
        if (is(op, "tasks", "delete")) return broken;
        return ok([]);
      };
      await expect(fullSyncRepo(repo)).rejects.toThrow("sync: delete stale tasks: connection reset");
      expect(ops.some((o) => is(o, "github_repos", "update"))).toBe(false);
    });

    it("aborts on a failed task read for an issue before the deletion pass", async () => {
      mocks.fetchIssues.mockResolvedValue([{
        number: 7, nodeId: "node", title: "Issue", body: null, url: "https://github.com/guild/repo/issues/7", state: "OPEN",
        labels: ["audited"], assignees: [],
        projectItems: [{ projectId: "proj-1", itemNodeId: "item-1", fields: { status: "In review", numbers: { ADA: 50 } } }],
      }]);
      // The per-issue read filters on the issue number; the repo-wide ones do not.
      answer = (op) => (is(op, "tasks", "select", "id, pay_state") ? broken : ok([]));
      await expect(fullSyncRepo(repo)).rejects.toThrow("sync: load task: connection reset");
      expect(writes()).toEqual([]);
      expect(ops.some((o) => is(o, "tasks", "select", CANDIDATES))).toBe(false);
    });
  });
});

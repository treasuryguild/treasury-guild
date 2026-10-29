import { describe, expect, it } from "vitest";
import { toMemberOptions } from "./boardTypes";

describe("toMemberOptions", () => {
  it("flattens contributor profiles", () => {
    expect(
      toMemberOptions([
        { wallet_address: "addr1a", contributors: { handle: "ada", github_username: "adal" } },
        { wallet_address: "addr1b", contributors: null },
      ]),
    ).toEqual([
      { wallet: "addr1a", handle: "ada", githubUsername: "adal" },
      { wallet: "addr1b", handle: null, githubUsername: null },
    ]);
  });
});
import {
  amountRowsFromTask,
  amountsFromRows,
  canDropTask,
  DEFAULT_BOARD_COLUMNS,
  groupTasksByGhStatus,
  isTaskDraggable,
  mergeLiveBoard,
  rewardFromRows,
  rewardRows,
  type BoardTask,
  type LiveBoardItem,
  type LiveProjectBoard,
} from "./boardTypes";

function task(overrides: Partial<BoardTask>): BoardTask {
  return {
    id: "t1",
    number: 1,
    title: "Task",
    body: null,
    source: "github",
    column_id: null,
    task_assignees: [],
    bounty_lovelace: null,
    amounts: null,
    pay_state: "none",
    archived_at: null,
    budget_month: null,
    paid_tx_hash: null,
    chain_number: null,
    gh_url: null,
    gh_status: null,
    gh_labels: null,
    gh_node_id: null,
    gh_repo_id: null,
    gh_issue_number: null,
    ...overrides,
  };
}

function liveItem(overrides: Partial<LiveBoardItem>): LiveBoardItem {
  return {
    itemNodeId: "PVTI_1",
    kind: "issue",
    contentNodeId: "I_1",
    number: 1,
    title: "Issue",
    url: "https://github.com/o/r/issues/1",
    state: "OPEN",
    status: null,
    numbers: {},
    labels: [],
    assigneeLogins: [],
    repoId: 100,
    repoFullName: "o/r",
    ...overrides,
  };
}

function liveBoard(overrides: Partial<LiveProjectBoard>): LiveProjectBoard {
  return {
    projectId: "PVT_1",
    title: "Roadmap",
    url: "https://github.com/orgs/o/projects/1",
    statusOptions: [],
    items: [],
    truncated: false,
    ...overrides,
  };
}

describe("DEFAULT_BOARD_COLUMNS", () => {
  it("has one payable and one paid column, Paid last", () => {
    expect(DEFAULT_BOARD_COLUMNS.filter((c) => c.marks_payable).map((c) => c.name)).toEqual([
      "Audited",
    ]);
    expect(DEFAULT_BOARD_COLUMNS.filter((c) => c.marks_paid).map((c) => c.name)).toEqual([
      "Paid",
    ]);
    expect(DEFAULT_BOARD_COLUMNS.map((c) => c.position)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("isTaskDraggable / canDropTask", () => {
  const paidColumn = { marks_paid: true };
  const column = { marks_paid: false };

  it("lets open, payable and queued tasks move between ordinary columns", () => {
    for (const pay_state of ["none", "payable", "queued"]) {
      expect(isTaskDraggable(task({ pay_state }))).toBe(true);
      expect(canDropTask(task({ pay_state }), column)).toBe(true);
    }
  });

  it("pins paid, reconciled and archived tasks", () => {
    expect(isTaskDraggable(task({ pay_state: "paid" }))).toBe(false);
    expect(isTaskDraggable(task({ pay_state: "reconciled" }))).toBe(false);
    expect(isTaskDraggable(task({ archived_at: "2026-09-01T00:00:00Z" }))).toBe(false);
    expect(canDropTask(task({ pay_state: "paid" }), column)).toBe(false);
  });

  it("never accepts a drop into the Paid column", () => {
    expect(canDropTask(task({ pay_state: "payable" }), paidColumn)).toBe(false);
    expect(canDropTask(task({ pay_state: "none" }), paidColumn)).toBe(false);
  });
});

describe("groupTasksByGhStatus", () => {
  it("groups by status in first-seen order, null group last", () => {
    const groups = groupTasksByGhStatus([
      task({ id: "a", gh_status: "In review" }),
      task({ id: "b", gh_status: null }),
      task({ id: "c", gh_status: "Done" }),
      task({ id: "d", gh_status: "In review" }),
    ]);
    expect(groups.map((g) => g.status)).toEqual(["In review", "Done", null]);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["a", "d"]);
    expect(groups[2]!.tasks.map((t) => t.id)).toEqual(["b"]);
  });

  it("returns no groups for an empty board", () => {
    expect(groupTasksByGhStatus([])).toEqual([]);
  });

  it("omits the null group when every task has a status", () => {
    const groups = groupTasksByGhStatus([task({ gh_status: "Done" })]);
    expect(groups.map((g) => g.status)).toEqual(["Done"]);
  });
});

describe("mergeLiveBoard", () => {
  it("keeps statusOptions order including empty columns", () => {
    const merged = mergeLiveBoard(
      liveBoard({
        statusOptions: ["Backlog", "In review", "Done"],
        items: [liveItem({ itemNodeId: "a", status: "Done" })],
      }),
      [],
    );
    expect(merged.columns.map((c) => c.name)).toEqual([
      "Backlog",
      "In review",
      "Done",
    ]);
    expect(merged.columns[0]!.items).toEqual([]);
    expect(merged.columns[2]!.items).toHaveLength(1);
  });

  it("collects null and unknown statuses in a trailing No status column", () => {
    const merged = mergeLiveBoard(
      liveBoard({
        statusOptions: ["Done"],
        items: [
          liveItem({ itemNodeId: "a", status: null }),
          liveItem({ itemNodeId: "b", status: "Renamed column" }),
        ],
      }),
      [],
    );
    expect(merged.columns.map((c) => c.name)).toEqual(["Done", "No status"]);
    expect(merged.columns[1]!.items.map((i) => i.itemNodeId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("omits the No status column when every item has a known status", () => {
    const merged = mergeLiveBoard(
      liveBoard({
        statusOptions: ["Done"],
        items: [liveItem({ status: "Done" })],
      }),
      [],
    );
    expect(merged.columns.map((c) => c.name)).toEqual(["Done"]);
  });

  it("matches tasks by issue node id first", () => {
    const t = task({ id: "match", gh_node_id: "I_1" });
    const merged = mergeLiveBoard(
      liveBoard({
        statusOptions: ["Done"],
        items: [liveItem({ status: "Done", contentNodeId: "I_1" })],
      }),
      [t],
    );
    expect(merged.columns[0]!.items[0]!.task?.id).toBe("match");
  });

  it("falls back to repo id + issue number", () => {
    const t = task({
      id: "match",
      gh_node_id: "I_other",
      gh_repo_id: 100,
      gh_issue_number: 7,
    });
    const merged = mergeLiveBoard(
      liveBoard({
        statusOptions: ["Done"],
        items: [
          liveItem({
            status: "Done",
            contentNodeId: "I_1",
            repoId: 100,
            number: 7,
          }),
        ],
      }),
      [t],
    );
    expect(merged.columns[0]!.items[0]!.task?.id).toBe("match");
  });

  it("never matches native tasks or non-issue items", () => {
    const native = task({ id: "n", source: "native", gh_node_id: "I_1" });
    const merged = mergeLiveBoard(
      liveBoard({
        statusOptions: ["Done"],
        items: [
          liveItem({ itemNodeId: "a", status: "Done", contentNodeId: "I_1" }),
          liveItem({
            itemNodeId: "b",
            status: "Done",
            kind: "draft",
            contentNodeId: null,
            url: null,
            number: null,
          }),
        ],
      }),
      [native],
    );
    const items = merged.columns[0]!.items;
    expect(items[0]!.task).toBeNull();
    expect(items[1]!.task).toBeNull();
    expect(items[1]!.draft).toBe(true);
  });

  it("passes live number fields through as amounts", () => {
    const merged = mergeLiveBoard(
      liveBoard({
        statusOptions: ["Done"],
        items: [
          liveItem({ status: "Done", numbers: { ADA: 25, AGIX: 100 } }),
        ],
      }),
      [],
    );
    expect(merged.columns[0]!.items[0]!.amounts).toEqual({ ADA: 25, AGIX: 100 });
  });
});

describe("amountRowsFromTask", () => {
  it("prefers amounts entries over the legacy bounty", () => {
    expect(
      amountRowsFromTask({
        amounts: { ADA: "7", AGIX: "10" },
        bounty_lovelace: 7_000_000,
      }),
    ).toEqual([
      { ticker: "ADA", amount: "7" },
      { ticker: "AGIX", amount: "10" },
    ]);
  });

  it("falls back to bounty_lovelace as an ADA row", () => {
    expect(
      amountRowsFromTask({ amounts: null, bounty_lovelace: 1_500_000 }),
    ).toEqual([{ ticker: "ADA", amount: "1.5" }]);
  });

  it("returns no rows when there is no bounty at all", () => {
    expect(amountRowsFromTask({ amounts: null, bounty_lovelace: null })).toEqual(
      [],
    );
    expect(amountRowsFromTask({ amounts: {}, bounty_lovelace: null })).toEqual(
      [],
    );
  });
});

describe("amountsFromRows", () => {
  it("round-trips with amountRowsFromTask", () => {
    const amounts = { ADA: "7", AGIX: "10.5" };
    expect(
      amountsFromRows(amountRowsFromTask({ amounts, bounty_lovelace: null })),
    ).toEqual(amounts);
  });

  it("drops blank rows and returns null when nothing is left", () => {
    expect(amountsFromRows([{ ticker: "", amount: "" }])).toBeNull();
    expect(amountsFromRows([])).toBeNull();
    expect(
      amountsFromRows([
        { ticker: "ADA", amount: "3" },
        { ticker: "", amount: "" },
      ]),
    ).toEqual({ ADA: "3" });
  });

  it("rejects duplicate tickers case-insensitively", () => {
    expect(() =>
      amountsFromRows([
        { ticker: "ADA", amount: "1" },
        { ticker: "ada", amount: "2" },
      ]),
    ).toThrow(/Duplicate/);
  });

  it("rejects malformed, zero, and negative amounts", () => {
    expect(() => amountsFromRows([{ ticker: "AGIX", amount: "abc" }])).toThrow(
      /Invalid amount/,
    );
    expect(() => amountsFromRows([{ ticker: "AGIX", amount: "0" }])).toThrow(
      /Invalid amount/,
    );
    expect(() => amountsFromRows([{ ticker: "AGIX", amount: "-2" }])).toThrow(
      /Invalid amount/,
    );
    expect(() => amountsFromRows([{ ticker: "", amount: "5" }])).toThrow(
      /ticker/,
    );
  });

  it("rejects ADA with more than 6 decimal places", () => {
    expect(() =>
      amountsFromRows([{ ticker: "ADA", amount: "1.1234567" }]),
    ).toThrow(/6 decimal/);
    expect(amountsFromRows([{ ticker: "ADA", amount: "1.123456" }])).toEqual({
      ADA: "1.123456",
    });
  });
});

describe("rewardRows", () => {
  it("starts a new reward with no rows", () => {
    expect(rewardRows(null)).toEqual([]);
    expect(rewardRows(undefined)).toEqual([]);
  });

  it("turns stored amounts into rows, in order", () => {
    expect(rewardRows({ AGIX: "10.5", ADA: "5" })).toEqual([
      { ticker: "AGIX", amount: "10.5" },
      { ticker: "ADA", amount: "5" },
    ]);
  });

  it("has no rows for a stored but empty reward", () => {
    expect(rewardRows({})).toEqual([]);
  });
});

describe("rewardFromRows", () => {
  it("returns the amounts per attendee", () => {
    expect(
      rewardFromRows([
        { ticker: "ADA", amount: "5" },
        { ticker: " AGIX ", amount: " 10.5 " },
        { ticker: "", amount: "" },
      ]),
    ).toEqual({ ADA: "5", AGIX: "10.5" });
  });

  it("round-trips with rewardRows", () => {
    const amounts = { ADA: "2.5", HOSKY: "1000" };
    expect(rewardFromRows(rewardRows(amounts))).toEqual(amounts);
  });

  it("asks for a reward when nothing is set", () => {
    expect(() => rewardFromRows([])).toThrow("Set a reward per attendee");
    expect(() => rewardFromRows([{ ticker: "", amount: "" }])).toThrow("Set a reward per attendee");
    expect(() => rewardFromRows([{ ticker: "  ", amount: " " }])).toThrow("Set a reward per attendee");
  });

  it("passes on what is wrong with an invalid row", () => {
    expect(() => rewardFromRows([{ ticker: "AGIX", amount: "abc" }])).toThrow("Invalid amount for AGIX");
    expect(() => rewardFromRows([{ ticker: "AGIX", amount: "0" }])).toThrow("Invalid amount for AGIX");
    expect(() => rewardFromRows([{ ticker: "", amount: "5" }])).toThrow("Every amount needs a token ticker");
    expect(() => rewardFromRows([{ ticker: "ADA", amount: "1" }, { ticker: "ada", amount: "2" }])).toThrow("Duplicate ticker ada");
    expect(() => rewardFromRows([{ ticker: "ADA", amount: "0.1234567" }])).toThrow("ADA supports at most 6 decimal places");
  });
});

import { describe, expect, it } from "vitest";
import type { TaskAssignee } from "@/lib/db/types";
import {
  assigneeLabel,
  assigneeProblems,
  assigneeWallets,
  contributorLabel,
  describeAssignees,
  everyAssigneeHasWallet,
  sortedAssignees,
} from "./assignees";

const ADDR = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";

function row(over: Partial<TaskAssignee>): TaskAssignee {
  return {
    id: "a",
    source: "manual",
    gh_login: null,
    wallet_address: null,
    position: 0,
    contributors: null,
    ...over,
  };
}

describe("assigneeWallets / everyAssigneeHasWallet", () => {
  it("orders by position and de-duplicates wallets", () => {
    const rows = [
      row({ id: "b", wallet_address: "addr1bob", position: 1 }),
      row({ id: "a", wallet_address: "addr1alice", position: 0 }),
      row({ id: "c", wallet_address: "addr1bob", position: 2, source: "github", gh_login: "bob" }),
    ];
    expect(sortedAssignees(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(assigneeWallets(rows)).toEqual(["addr1alice", "addr1bob"]);
    expect(everyAssigneeHasWallet(rows)).toBe(true);
  });

  it("requires at least one assignee and no unlinked ones", () => {
    expect(everyAssigneeHasWallet([])).toBe(false);
    expect(everyAssigneeHasWallet(null)).toBe(false);
    expect(
      everyAssigneeHasWallet([
        row({ wallet_address: "addr1alice" }),
        row({ id: "b", source: "github", gh_login: "carol", position: 1 }),
      ]),
    ).toBe(false);
    expect(assigneeWallets(undefined)).toEqual([]);
  });
});

describe("assigneeProblems", () => {
  it("is empty for a fully linked task", () => {
    expect(assigneeProblems("Fix bug", [row({ wallet_address: "addr1alice" })])).toEqual([]);
  });

  it("names the login or position of every unlinked assignee", () => {
    expect(
      assigneeProblems("Fix bug", [
        row({ id: "1", source: "github", gh_login: "carol", position: 1 }),
        row({ id: "2", wallet_address: "addr1alice", position: 0 }),
        row({ id: "3", position: 2 }),
      ]),
    ).toEqual([
      "Fix bug: @carol has no wallet linked",
      "Fix bug: assignee #3 has no wallet",
    ]);
    expect(assigneeProblems("Fix bug", [])).toEqual(["Fix bug: no assignees"]);
  });
});

describe("labels", () => {
  it("prefers handle, then GitHub name, then a short address", () => {
    expect(contributorLabel({ wallet: ADDR, handle: "ada", githubUsername: "adal" })).toBe("ada (@adal)");
    expect(contributorLabel({ wallet: ADDR, handle: "ada", githubUsername: null })).toBe("ada");
    expect(contributorLabel({ wallet: ADDR, handle: null, githubUsername: "adal" })).toBe("@adal");
    expect(contributorLabel({ wallet: ADDR, handle: null, githubUsername: null })).toBe(
      "addr_test1…wgshl2",
    );
  });

  it("labels assignee rows from the issue login or the contributor profile", () => {
    expect(assigneeLabel(row({ source: "github", gh_login: "carol" }))).toBe("@carol");
    expect(
      assigneeLabel(
        row({
          source: "github",
          gh_login: "carol",
          wallet_address: ADDR,
          contributors: { handle: "Carol", github_username: "carol" },
        }),
      ),
    ).toBe("Carol (@carol)");
    expect(
      assigneeLabel(row({ wallet_address: ADDR, contributors: { handle: null, github_username: "adal" } })),
    ).toBe("@adal");
    expect(assigneeLabel(row({ wallet_address: ADDR }))).toBe("addr_test1…wgshl2");
    expect(assigneeLabel(row({}))).toBe("unassigned");
  });

  it("joins labels in position order", () => {
    expect(
      describeAssignees([
        row({ id: "b", source: "github", gh_login: "bob", position: 1 }),
        row({ id: "a", wallet_address: ADDR, position: 0, contributors: { handle: "ada", github_username: null } }),
      ]),
    ).toBe("ada, @bob");
  });
});

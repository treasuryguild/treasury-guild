import { describe, expect, it } from "vitest";
import { assigneeSummaries, budgetMonthOf, displayQuantity, matchMembers, signingRule, taskReward } from "./shape";

describe("signing rule", () => {
  const plain = {
    template: "plain" as const, script_type: "atLeast" as const, required: 2,
    recovery_script_type: null, recovery_required: null, lock_until: null, cosigner_kind: null,
  };
  const signers = (n: number, group: "base" | "recovery" | "cosigner" = "base") =>
    Array.from({ length: n }, (_, i) => ({ wallet_address: `${group}${i}`, signer_group: group }));

  it("names the threshold of each script type", () => {
    expect(signingRule(plain, signers(3))).toBe("2 of 3 signers");
    expect(signingRule({ ...plain, script_type: "all" }, signers(3))).toBe("all 3 signers");
    expect(signingRule({ ...plain, script_type: "any" }, signers(1))).toBe("any 1 of 1 signer");
  });

  it("names what each template adds", () => {
    const lock = "2027-03-01T00:00:00.000Z";
    expect(signingRule({ ...plain, template: "clawback", recovery_script_type: "any", recovery_required: 1, lock_until: lock },
      [...signers(3), ...signers(2, "recovery")])).toBe("2 of 3 signers; from 2027-03-01T00:00:00.000Z also any 1 of 2 recovery signers");
    expect(signingRule({ ...plain, template: "lock_until", lock_until: lock }, signers(3))).toBe("2 of 3 signers, locked until 2027-03-01T00:00:00.000Z");
    expect(signingRule({ ...plain, template: "cosigner", cosigner_kind: "app" }, [...signers(3), ...signers(1, "cosigner")]))
      .toBe("2 of 3 signers plus the co-signer, or all 3 signers together");
  });
});

describe("displayQuantity", () => {
  it("is exact and ungrouped", () => {
    expect(displayQuantity(12_345_678_901_234_567n, 6)).toBe("12345678901.234567");
    expect(displayQuantity("1500000", 6)).toBe("1.5");
    expect(displayQuantity("-250", 2)).toBe("-2.5");
    expect(displayQuantity("42", 0)).toBe("42");
  });
});

describe("taskReward", () => {
  it("reads amounts, else the legacy ADA bounty", () => {
    expect(taskReward({ amounts: { ADA: "100", HOSKY: "5000" }, bounty_lovelace: null })).toEqual({ ADA: "100", HOSKY: "5000" });
    expect(taskReward({ amounts: null, bounty_lovelace: 2_500_000 })).toEqual({ ADA: "2.5" });
    expect(taskReward({ amounts: null, bounty_lovelace: null })).toEqual({});
  });
});

describe("assigneeSummaries", () => {
  it("names assignees in stored order, as the board does", () => {
    expect(assigneeSummaries([
      { id: "2", source: "manual", gh_login: null, gh_user_id: null, wallet_address: "addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz", position: 1, contributors: null },
      { id: "1", source: "github", gh_login: "alice", gh_user_id: 1, wallet_address: null, position: 0, contributors: { handle: "Alice", github_username: "alice" } },
    ])).toEqual([
      { name: "Alice (@alice)", wallet: null },
      { name: "addr_test1…zzzzzz", wallet: "addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz" },
    ]);
  });
});

describe("budgetMonthOf", () => {
  it("reads the month of a day-1 date", () => {
    expect(budgetMonthOf("2026-07-01")).toBe("2026-07");
    expect(budgetMonthOf(null)).toBeNull();
  });
});

describe("matchMembers", () => {
  const ann = { wallet: "addr_ann", handle: "Ann", githubUsername: "ann-gh" };
  const bob = { wallet: "addr_bob", handle: null, githubUsername: "Bob" };
  const ann2 = { wallet: "addr_ann2", handle: "ann", githubUsername: null };
  // Someone whose handle is another member's GitHub login.
  const ghost = { wallet: "addr_ghost", handle: "bob", githubUsername: null };
  const members = [ann, bob, ann2, ghost];

  it("prefers the wallet, then the handle, then the GitHub login", () => {
    expect(matchMembers("addr_bob", members)).toEqual([bob]);
    expect(matchMembers("bob", members)).toEqual([ghost]);
    expect(matchMembers("@bob", members)).toEqual([bob]);
    expect(matchMembers(" ann-gh ", members)).toEqual([ann]);
  });

  it("answers every member a name fits, and nobody for an unknown or empty name", () => {
    expect(matchMembers("ANN", members)).toEqual([ann, ann2]);
    expect(matchMembers("carol", members)).toEqual([]);
    expect(matchMembers("  ", members)).toEqual([]);
  });
});

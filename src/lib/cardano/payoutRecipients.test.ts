import { describe, expect, it } from "vitest";
import {
  countPayments,
  groupByRecipient,
  recipientsOffNetwork,
  type RecipientTaskInput,
} from "./payoutRecipients";
import { planPayoutOutputs } from "./payoutOutputs";

const TOKEN = `${"a".repeat(56)}484f534b59`;

function task(over: Partial<RecipientTaskInput> & { id: string; number: number }): RecipientTaskInput {
  return {
    workgroups: { name: "Dev" },
    task_assignees: [],
    ...over,
  };
}

const assignee = (wallet: string | null, position = 0) => ({ wallet_address: wallet, position });

/** Every task in the default month unless overridden. */
const periods = (over: Record<string, string> = {}) =>
  new Map(
    ["A", "B"].map((id) => [id, { code: over[id] ?? "2026-09" }]),
  );

describe("groupByRecipient", () => {
  it("pays every assignee the full task amounts and aggregates per wallet", () => {
    const amounts = new Map([
      ["A", new Map([["lovelace", 10_000_000n], [TOKEN, 5n]])],
      ["B", new Map([["lovelace", 2_000_000n]])],
    ]);
    const recipients = groupByRecipient(
      [
        task({ id: "A", number: 1, task_assignees: [assignee("addr1alice"), assignee("addr1bob", 1)] }),
        task({ id: "B", number: 2, workgroups: { name: "Ops" }, task_assignees: [assignee("addr1bob")] }),
      ],
      amounts,
      periods({ B: "2026-Q4" }),
    );

    expect(recipients.map((r) => r.contributorWallet)).toEqual(["addr1alice", "addr1bob"]);
    expect(recipients[0]!.tasks.map((t) => t.taskNumber)).toEqual([1]);
    expect(recipients[1]!.tasks.map((t) => t.taskNumber)).toEqual([1, 2]);
    // Identical amounts for each assignee of task 1.
    expect(recipients[0]!.tasks[0]!.amounts).toEqual(recipients[1]!.tasks[0]!.amounts);
    // The period code is carried verbatim — month or quarter.
    expect(recipients[1]!.tasks[1]).toMatchObject({ workgroupName: "Ops", budgetPeriod: "2026-Q4" });
    expect(recipients[0]!.tasks[0]!.budgetPeriod).toBe("2026-09");
    expect(countPayments(recipients)).toBe(3);

    // The treasury pays the bounty once per assignee.
    const { totalByUnit, outputs } = planPayoutOutputs(recipients);
    expect(outputs).toHaveLength(2);
    expect(totalByUnit.get("lovelace")).toBe(22_000_000n);
    expect(totalByUnit.get(TOKEN)).toBe(10n);
  });

  it("orders recipients by first appearance so output indexes are stable", () => {
    const amounts = new Map([["A", new Map([["lovelace", 1n]])], ["B", new Map([["lovelace", 1n]])]]);
    const recipients = groupByRecipient(
      [
        task({ id: "A", number: 1, task_assignees: [assignee("addr1zed", 1), assignee("addr1amy", 0)] }),
        task({ id: "B", number: 2, task_assignees: [assignee("addr1bob")] }),
      ],
      amounts,
      periods(),
    );
    expect(recipients.map((r) => r.contributorWallet)).toEqual(["addr1amy", "addr1zed", "addr1bob"]);
  });

  it("refuses tasks without assignee wallets, amounts or a period (validation must run first)", () => {
    const amounts = new Map([["A", new Map([["lovelace", 1n]])]]);
    const one = [task({ id: "A", number: 1, task_assignees: [assignee("addr1a")] })];
    expect(() =>
      groupByRecipient([task({ id: "A", number: 1, task_assignees: [assignee(null)] })], amounts, periods()),
    ).toThrow(/no assignee wallets/);
    expect(() => groupByRecipient(one, new Map(), periods())).toThrow(/no resolved amounts/);
    expect(() => groupByRecipient(one, amounts, new Map())).toThrow(/no budget period/);
  });
});

describe("recipientsOffNetwork", () => {
  const amounts = new Map([["A", new Map([["lovelace", 1n]])], ["B", new Map([["lovelace", 1n]])]]);
  const recipients = groupByRecipient(
    [
      task({ id: "A", number: 7, task_assignees: [assignee("addr1mainnet"), assignee("addr_test1preprod", 1)] }),
      task({ id: "B", number: 8, task_assignees: [assignee("addr_test1preprod")] }),
    ],
    amounts,
    periods(),
  );

  it("names the wallets (and their tasks) that are not on the treasury's network", () => {
    expect(recipientsOffNetwork(recipients, 1)).toEqual([
      { wallet: "addr_test1preprod", taskNumbers: [7, 8] },
    ]);
    expect(recipientsOffNetwork(recipients, 0)).toEqual([
      { wallet: "addr1mainnet", taskNumbers: [7] },
    ]);
  });

  it("is empty when every recipient matches", () => {
    const only = groupByRecipient(
      [task({ id: "A", number: 1, task_assignees: [assignee("addr1alice")] })],
      new Map([["A", new Map([["lovelace", 1n]])]]),
      periods(),
    );
    expect(recipientsOffNetwork(only, 1)).toEqual([]);
  });
});

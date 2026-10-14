import { describe, expect, it } from "vitest";
import { planOutputs, planPayoutOutputs, type TaskPayment } from "./payoutOutputs";
import { minLovelaceForOutput } from "./utxoSelect";

const TOKEN = `${"a".repeat(56)}484f534b59`;

function task(
  taskNumber: number,
  amounts: TaskPayment["amounts"],
): TaskPayment {
  return {
    taskId: `t${taskNumber}`,
    taskNumber,
    workgroupName: "Dev",
    budgetPeriod: "2026-09",
    amounts,
    citations: [],
  };
}

describe("planPayoutOutputs", () => {
  it("aggregates a contributor's tasks per unit into one output", () => {
    const { outputs, totalByUnit } = planPayoutOutputs([
      {
        contributorWallet: "addr1alice",
        tasks: [
          task(1, [{ unit: "lovelace", quantity: 5_000_000n }]),
          task(2, [
            { unit: "lovelace", quantity: 3_000_000n },
            { unit: TOKEN, quantity: 10n },
          ]),
        ],
      },
    ]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.address).toBe("addr1alice");
    expect(outputs[0]?.assets).toEqual([
      { unit: "lovelace", quantity: 8_000_000n },
      { unit: TOKEN, quantity: 10n },
    ]);
    expect(totalByUnit.get("lovelace")).toBe(8_000_000n);
    expect(totalByUnit.get(TOKEN)).toBe(10n);
  });

  it("bumps lovelace to the min-UTxO for token-only outputs", () => {
    const { outputs } = planPayoutOutputs([
      {
        contributorWallet: "addr1bob",
        tasks: [task(3, [{ unit: TOKEN, quantity: 1n }])],
      },
    ]);
    const expectedMin = minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 5 });
    expect(outputs[0]?.assets[0]).toEqual({ unit: "lovelace", quantity: expectedMin });
    expect(expectedMin).toBeGreaterThan(0n);
  });

  it("ignores non-positive quantities and bumps an ADA-only output to min-UTxO", () => {
    const { outputs } = planPayoutOutputs([
      {
        contributorWallet: "addr1zero",
        tasks: [task(4, [{ unit: "lovelace", quantity: 0n }])],
      },
    ]);
    const adaOnlyMin = minLovelaceForOutput({ policies: 0, assets: 0, totalNameBytes: 0 });
    expect(outputs[0]?.assets).toEqual([{ unit: "lovelace", quantity: adaOnlyMin }]);
  });
});

describe("planOutputs", () => {
  const OTHER = `${"b".repeat(56)}41474958`; // another policy, 4-byte name
  const SIBLING = `${"a".repeat(56)}4d494e`; // TOKEN's policy, 3-byte name
  const ADA_MIN = minLovelaceForOutput({ policies: 0, assets: 0, totalNameBytes: 0 });

  it("is empty for no recipients", () => {
    const plan = planOutputs([]);
    expect(plan.outputs).toEqual([]);
    expect(plan.totalByUnit.size).toBe(0);
  });

  it("keeps recipient order and never merges two entries for one address", () => {
    const { outputs, totalByUnit } = planOutputs([
      { address: "addr1bob", amounts: [{ unit: "lovelace", quantity: 3_000_000n }] },
      { address: "addr1alice", amounts: [{ unit: "lovelace", quantity: 4_000_000n }] },
      { address: "addr1bob", amounts: [{ unit: "lovelace", quantity: 5_000_000n }] },
    ]);
    expect(outputs.map((o) => o.address)).toEqual(["addr1bob", "addr1alice", "addr1bob"]);
    expect(outputs.map((o) => o.assets[0]?.quantity)).toEqual([3_000_000n, 4_000_000n, 5_000_000n]);
    expect(totalByUnit.get("lovelace")).toBe(12_000_000n);
  });

  it("sums repeated units within a recipient and puts lovelace first", () => {
    const { outputs } = planOutputs([
      {
        address: "addr1alice",
        amounts: [
          { unit: TOKEN, quantity: 4n },
          { unit: "lovelace", quantity: 2_000_000n },
          { unit: TOKEN, quantity: 6n },
          { unit: "lovelace", quantity: 3_000_000n },
        ],
      },
    ]);
    expect(outputs[0]?.assets).toEqual([
      { unit: "lovelace", quantity: 5_000_000n },
      { unit: TOKEN, quantity: 10n },
    ]);
  });

  it("raises explicit lovelace below the min-UTxO to it, and leaves more alone", () => {
    const tokenMin = minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 5 });
    const { outputs } = planOutputs([
      { address: "addr1low", amounts: [{ unit: "lovelace", quantity: 1n }, { unit: TOKEN, quantity: 1n }] },
      { address: "addr1exact", amounts: [{ unit: "lovelace", quantity: tokenMin }, { unit: TOKEN, quantity: 1n }] },
      { address: "addr1high", amounts: [{ unit: "lovelace", quantity: tokenMin + 1n }, { unit: TOKEN, quantity: 1n }] },
    ]);
    expect(outputs.map((o) => o.assets[0]?.quantity)).toEqual([tokenMin, tokenMin, tokenMin + 1n]);
  });

  it("sizes the min-UTxO by distinct policies, assets and name bytes", () => {
    const { outputs } = planOutputs([
      {
        address: "addr1bundle",
        amounts: [
          { unit: TOKEN, quantity: 1n },
          { unit: SIBLING, quantity: 2n },
          { unit: OTHER, quantity: 3n },
        ],
      },
    ]);
    const expected = minLovelaceForOutput({ policies: 2, assets: 3, totalNameBytes: 5 + 3 + 4 });
    expect(outputs[0]?.assets).toEqual([
      { unit: "lovelace", quantity: expected },
      { unit: TOKEN, quantity: 1n },
      { unit: SIBLING, quantity: 2n },
      { unit: OTHER, quantity: 3n },
    ]);
    expect(expected).toBeGreaterThan(minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 5 }));
  });

  it("drops zero and negative quantities, which then count for nothing", () => {
    const { outputs, totalByUnit } = planOutputs([
      {
        address: "addr1alice",
        amounts: [
          { unit: TOKEN, quantity: 0n },
          { unit: OTHER, quantity: -5n },
          { unit: "lovelace", quantity: -1_000_000n },
          { unit: "lovelace", quantity: 9_000_000n },
        ],
      },
    ]);
    // No token survives, so the output is ADA-only and the negative did not net against the 9 ADA.
    expect(outputs[0]?.assets).toEqual([{ unit: "lovelace", quantity: 9_000_000n }]);
    expect([...totalByUnit.keys()]).toEqual(["lovelace"]);
  });

  it("gives a recipient with no amounts a min-UTxO output rather than refusing", () => {
    const { outputs } = planOutputs([{ address: "addr1empty", amounts: [] }]);
    expect(outputs).toEqual([{ address: "addr1empty", assets: [{ unit: "lovelace", quantity: ADA_MIN }] }]);
  });

  it("totals what the outputs carry, min-UTxO bumps included", () => {
    const tokenMin = minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 5 });
    const otherMin = minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 4 });
    const { outputs, totalByUnit } = planOutputs([
      { address: "addr1alice", amounts: [{ unit: TOKEN, quantity: 7n }] },
      { address: "addr1bob", amounts: [{ unit: "lovelace", quantity: 10_000_000n }, { unit: TOKEN, quantity: 3n }] },
      { address: "addr1carol", amounts: [{ unit: OTHER, quantity: 1n }] },
    ]);
    expect(totalByUnit.get("lovelace")).toBe(tokenMin + 10_000_000n + otherMin);
    expect(totalByUnit.get(TOKEN)).toBe(10n);
    expect(totalByUnit.get(OTHER)).toBe(1n);
    for (const unit of totalByUnit.keys()) {
      const sum = outputs.flatMap((o) => o.assets).filter((a) => a.unit === unit).reduce((s, a) => s + a.quantity, 0n);
      expect(totalByUnit.get(unit)).toBe(sum);
    }
  });

  it("plans the same outputs as planPayoutOutputs for flattened task amounts", () => {
    const viaTasks = planPayoutOutputs([
      {
        contributorWallet: "addr1alice",
        tasks: [task(1, [{ unit: "lovelace", quantity: 5_000_000n }]), task(2, [{ unit: TOKEN, quantity: 10n }])],
      },
    ]);
    const direct = planOutputs([
      { address: "addr1alice", amounts: [{ unit: "lovelace", quantity: 5_000_000n }, { unit: TOKEN, quantity: 10n }] },
    ]);
    expect(direct.outputs).toEqual(viaTasks.outputs);
    expect([...direct.totalByUnit]).toEqual([...viaTasks.totalByUnit]);
  });
});

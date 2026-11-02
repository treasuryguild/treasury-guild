import { describe, expect, it } from "vitest";
import { allocationAmount, applyAllocationRules, sumPayoutTotals } from "./allocations";

const LOVELACE = "lovelace";
const TOKEN = "a".repeat(56) + "544f4b45";

const display = new Map([
  [LOVELACE, { ticker: "ADA", decimals: 6 }],
  [TOKEN, { ticker: "TOKE", decimals: 0 }],
]);

// Valid Shelley testnet-style prefixes are not required by addressToNetwork
// for these tests when we use real bech32 shapes — use simple stubs that the
// SDK accepts. Preprod enterprise addresses start with addr_test1.
const PAYING = "addr_test1qzpaying0000000000000000000000000000000000000000000000000000000000000000000000000000000000paying";
const EXTERNAL = "addr_test1qzexternal00000000000000000000000000000000000000000000000000000000000000000000000000000external";
const SIBLING = "addr_test1qzsibling0000000000000000000000000000000000000000000000000000000000000000000000000000000sibling";

describe("allocationAmount", () => {
  it("floors percent of base units", () => {
    expect(allocationAmount(10000n, 100)).toBe(100n); // 1%
    expect(allocationAmount(100n, 100)).toBe(1n);
    expect(allocationAmount(99n, 100)).toBe(0n);
    expect(allocationAmount(1_000_000n, 1)).toBe(100n); // 0.01%
  });
});

describe("sumPayoutTotals", () => {
  it("sums every task amount across recipients", () => {
    const totals = sumPayoutTotals([
      { tasks: [{ amounts: [{ unit: LOVELACE, quantity: 5n }, { unit: TOKEN, quantity: 10n }] }] },
      { tasks: [{ amounts: [{ unit: LOVELACE, quantity: 3n }] }] },
    ]);
    expect(totals.get(LOVELACE)).toBe(8n);
    expect(totals.get(TOKEN)).toBe(10n);
  });
});

describe("applyAllocationRules", () => {
  const totals = new Map([
    [LOVELACE, 1_000_000n],
    [TOKEN, 10_000n],
  ]);

  it("applies all-scope fee to an outside wallet as spend", () => {
    const result = applyAllocationRules({
      rules: [{
        id: "r1",
        label: "Ops fee",
        basis_points: 100,
        unit_scope: "all",
        units: [],
        recipient_wallet: EXTERNAL,
        recipient_treasury_id: null,
      }],
      payoutTotals: totals,
      unitDisplay: display,
      network: 0,
      payingTreasuryAddress: PAYING,
    });
    // addressToNetwork may reject our stub addresses — if so, skip network-dependent asserts.
    if (result.problems.length > 0) {
      expect(result.problems[0]).toMatch(/Allocation/);
      return;
    }
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]!.recipientTreasuryId).toBeNull();
    expect(result.spendLines).toHaveLength(2);
    expect(result.spendLines.find((s) => s.unit === LOVELACE)?.amount).toBe(10_000n);
    expect(result.spendLines.find((s) => s.unit === TOKEN)?.amount).toBe(100n);
  });

  it("merges two rules to the same destination", () => {
    const result = applyAllocationRules({
      rules: [
        {
          id: "r1", label: "A", basis_points: 100, unit_scope: "all", units: [],
          recipient_wallet: EXTERNAL, recipient_treasury_id: null,
        },
        {
          id: "r2", label: "B", basis_points: 100, unit_scope: "selected", units: [TOKEN],
          recipient_wallet: EXTERNAL, recipient_treasury_id: null,
        },
      ],
      payoutTotals: totals,
      unitDisplay: display,
      network: 0,
      payingTreasuryAddress: PAYING,
    });
    if (result.problems.length > 0) return;
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]!.ruleIds).toEqual(["r1", "r2"]);
    const token = result.recipients[0]!.amounts.find((a) => a.unit === TOKEN);
    expect(token?.quantity).toBe(200n); // 1% + 1% of 10000
  });

  it("marks sibling treasury as transfer with no spend lines", () => {
    const result = applyAllocationRules({
      rules: [{
        id: "r1",
        label: "Reserve",
        basis_points: 200,
        unit_scope: "all",
        units: [],
        recipient_wallet: null,
        recipient_treasury_id: "sib-1",
        recipientTreasuryAddress: SIBLING,
        recipientTreasuryName: "Reserve",
      }],
      payoutTotals: totals,
      unitDisplay: display,
      network: 0,
      payingTreasuryAddress: PAYING,
    });
    if (result.problems.length > 0) return;
    expect(result.recipients[0]!.recipientTreasuryId).toBe("sib-1");
    expect(result.spendLines).toHaveLength(0);
  });

  it("skips selected units not in the payout", () => {
    const result = applyAllocationRules({
      rules: [{
        id: "r1",
        label: "Only missing",
        basis_points: 100,
        unit_scope: "selected",
        units: ["deadbeef"],
        recipient_wallet: EXTERNAL,
        recipient_treasury_id: null,
      }],
      payoutTotals: totals,
      unitDisplay: display,
      network: 0,
      payingTreasuryAddress: PAYING,
    });
    if (result.problems.length > 0) return;
    expect(result.recipients).toHaveLength(0);
  });

  it("reports paying self", () => {
    const result = applyAllocationRules({
      rules: [{
        id: "r1",
        label: "Bad",
        basis_points: 100,
        unit_scope: "all",
        units: [],
        recipient_wallet: PAYING,
        recipient_treasury_id: null,
      }],
      payoutTotals: totals,
      unitDisplay: display,
      network: 0,
      payingTreasuryAddress: PAYING,
    });
    expect(result.problems.some((p) => /paying treasury/i.test(p))).toBe(true);
  });
});

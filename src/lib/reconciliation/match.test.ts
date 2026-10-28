import { describe, expect, it } from "vitest";
import { LOVELACE } from "@/lib/assets";
import { scoreRefundMatches, type RefundMatchPayout } from "./match";

const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const TOKEN = `${"a".repeat(56)}47565454`;

function payout(patch: Partial<RefundMatchPayout> & Pick<RefundMatchPayout, "id">): RefundMatchPayout {
  return {
    task_id: "task-1",
    contributor_wallet: ALICE,
    unit: LOVELACE,
    amount: "5000000",
    taskTitle: "Fix login",
    ...patch,
  };
}

describe("scoreRefundMatches", () => {
  it("scores a refund from the paid wallet with the exact amount highest", () => {
    const ranked = scoreRefundMatches(
      [payout({ id: "p-exact" }), payout({ id: "p-other", contributor_wallet: BOB })],
      { from_addresses: [ALICE], amount_lovelace: "5000000" },
    );
    expect(ranked.map((s) => [s.payoutId, s.score])).toEqual([
      ["p-exact", 150],
      ["p-other", 50],
    ]);
  });

  it("adds a partial-refund score when the paid amount is larger", () => {
    const ranked = scoreRefundMatches(
      [payout({ id: "p-partial", amount: "10000000" })],
      { from_addresses: [ALICE], amount_lovelace: "3000000" },
    );
    expect(ranked).toEqual([expect.objectContaining({ payoutId: "p-partial", score: 110 })]);
  });

  it("matches a native-token refund by unit", () => {
    const ranked = scoreRefundMatches(
      [
        payout({ id: "p-ada" }),
        payout({ id: "p-token", unit: TOKEN, amount: "42" }),
      ],
      { from_addresses: [], amount_lovelace: "0", assets: { [TOKEN]: "42" } },
    );
    expect(ranked).toEqual([expect.objectContaining({ payoutId: "p-token", score: 50 })]);
  });

  it("drops zero-score rows and keeps the top ten by score", () => {
    // Wrong wallet and a different unit → nothing to score.
    expect(scoreRefundMatches(
      [payout({ id: "p-miss", contributor_wallet: BOB, unit: TOKEN, amount: "9" })],
      { from_addresses: [ALICE], amount_lovelace: "5000000" },
    )).toEqual([]);

    const many = Array.from({ length: 12 }, (_, i) =>
      payout({ id: `p-${i}`, contributor_wallet: ALICE, amount: String(1_000_000 + i) }),
    );
    const top = scoreRefundMatches(many, {
      from_addresses: [ALICE],
      amount_lovelace: "1000005",
    });
    expect(top).toHaveLength(10);
    expect(top[0]).toMatchObject({ payoutId: "p-5", score: 150 });
    expect(top.every((s) => s.score >= top[top.length - 1]!.score)).toBe(true);
  });
});


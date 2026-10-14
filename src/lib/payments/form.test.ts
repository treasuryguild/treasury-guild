import { describe, expect, it } from "vitest";
import type { BudgetSummary } from "@/lib/api/types";
import {
  budgetLines, draftProblems, draftToRequest, draftTotals, newRecipient, overBalance, walletTokens, type DraftToken,
} from "./form";

const GVTT = `${"a".repeat(56)}47565454`;
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const OUTSIDE = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const TREASURY = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";
const MAINNET = "addr1vx46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2c4u8cnp";

const tokens: DraftToken[] = [
  { unit: "lovelace", ticker: "ADA", decimals: 6, held: 10_000_000n },
  { unit: GVTT, ticker: "GVTT", decimals: 6, held: 5_000_000n },
];
const ctx = { treasuryAddress: TREASURY, network: 0 as const };

describe("payment form", () => {
  it("lists ADA first from the wallet and turns rows into the request", () => {
    expect(walletTokens({ lovelace: "42", utxoCount: 1, tokens: [
      { unit: GVTT, quantity: "7", ticker: "GVTT", name: "Test Token", decimals: 6, source: "registry" },
    ] })).toEqual(tokens.map((t, i) => ({ ...t, held: i === 0 ? 42n : 7n })));
    expect(walletTokens(null)).toEqual([]);
    expect(draftToRequest([
      { ...newRecipient(0), address: ` ${ALICE} `, amounts: { lovelace: " 2.5 ", [GVTT]: "" } },
    ])).toEqual([{ address: ALICE, amounts: { lovelace: "2.5" } }]);
  });

  it("sums well-formed amounts exactly and flags totals over the balance", () => {
    const rows = [
      { ...newRecipient(0), address: ALICE, amounts: { lovelace: "2.5", [GVTT]: "4.000001" } },
      { ...newRecipient(1), address: OUTSIDE, amounts: { lovelace: "8", [GVTT]: "x", "unknown": "1" } },
      { ...newRecipient(2), address: OUTSIDE, amounts: { [GVTT]: "1.0000001" } },
    ];
    const totals = draftTotals(rows, tokens);
    expect(totals).toEqual(new Map([["lovelace", 10_500_000n], [GVTT, 4_000_001n]]));
    expect(overBalance(totals, tokens)).toEqual(["ADA"]);
  });

  it("reports what stops the build, row by row", () => {
    expect(draftProblems([
      { ...newRecipient(0), address: "", amounts: {} },
      { ...newRecipient(1), address: "not-an-address", amounts: { lovelace: "1" } },
      { ...newRecipient(2), address: MAINNET, amounts: { lovelace: "1" } },
      { ...newRecipient(3), address: TREASURY, amounts: { lovelace: "1" } },
      { ...newRecipient(4), address: ALICE, amounts: { lovelace: "" } },
      { ...newRecipient(5), address: ALICE, amounts: { lovelace: "abc" } },
      { ...newRecipient(6), address: ALICE, amounts: { [GVTT]: "0" } },
      { ...newRecipient(7), address: ALICE, amounts: { [GVTT]: "1.0000001" } },
      { ...newRecipient(8), address: OUTSIDE, amounts: { lovelace: "1", [GVTT]: "" } },
      { ...newRecipient(9), address: OUTSIDE, amounts: { [`${"b".repeat(56)}4f54484552`]: "3" } },
    ], tokens, ctx)).toEqual([
      "Recipient 1: choose who to pay",
      "Recipient 2: not a valid Cardano address",
      "Recipient 3: address is on a different network",
      "Recipient 4: this is the paying treasury itself",
      "Recipient 5: enter an amount",
      "Recipient 6: enter a plain number for ADA",
      "Recipient 6: enter an amount",
      "Recipient 7: GVTT amount must be greater than zero",
      "Recipient 7: enter an amount",
      "Recipient 8: GVTT allows at most 6 decimal places",
      "Recipient 8: enter an amount",
      `Recipient 10: the paying treasury holds no ${"b".repeat(12)}… to pay 3 of it`,
      "Recipient 10: enter an amount",
    ]);
  });

  it("shows the treasury's budgets with the balance after this payment", () => {
    const budget = (overrides: Partial<BudgetSummary>): BudgetSummary => ({
      id: "b", budgetMonth: "2026-09", ownerType: "treasury", ownerId: "main", ownerName: "Treasury: Main", treasuryId: "main",
      workgroupKind: null, cadence: "monthly", unit: "lovelace", assetLabel: "ADA", decimals: 6, amount: "10000000",
      spent: "4000000", balance: "6000000", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z",
      periodLabel: "September 2026", ...overrides,
    });
    const lines = budgetLines([
      budget({}),
      budget({ id: "t", unit: GVTT, assetLabel: "GVTT", amount: "100", spent: "0", balance: "100" }),
      budget({ id: "w", ownerType: "workgroup", ownerId: "wg", ownerName: "Dev", treasuryId: null }),
      budget({ id: "o", ownerId: "other", ownerName: "Treasury: Other" }),
    ], "main", new Map([["lovelace", 7_000_000n]]));
    expect(lines).toEqual([
      { unit: "lovelace", ticker: "ADA", decimals: 6, periodLabel: "September 2026", amount: 10_000_000n, spent: 4_000_000n, adding: 7_000_000n, after: -1_000_000n },
      { unit: GVTT, ticker: "GVTT", decimals: 6, periodLabel: "September 2026", amount: 100n, spent: 0n, adding: 0n, after: 100n },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { MAX_PAYOUT_CONTRIBUTORS } from "@/lib/constants";
import { paymentTotals, resolvePaymentRecipients, type PaymentRecipientContext } from "./recipients";

const GVTT = `${"a".repeat(56)}47565454`;
const TREASURY = "addr_test1treasury";
const DEV = "addr_test1dev";
const ALICE = "addr_test1alice";
const OUTSIDE = "addr_test1outside";

const ctx: PaymentRecipientContext = {
  network: 0,
  treasuryAddress: TREASURY,
  siblingTreasuries: [{ id: "dev", name: "Dev wallet", address: DEV }],
  members: new Map([[ALICE, "alice (@alice)"], ["addr_test1bob", null]]),
  tokens: new Map([[GVTT, { ticker: "GVTT", decimals: 6 }]]),
};

describe("resolvePaymentRecipients", () => {
  it("scales amounts exactly, labels members and treasuries, and merges rows for one address", () => {
    const { recipients, problems } = resolvePaymentRecipients([
      { address: ALICE, amounts: { lovelace: "2.5", [GVTT]: "10" } },
      { address: OUTSIDE, amounts: { [GVTT]: "0.000001", lovelace: "" } },
      { address: `${ALICE} `, amounts: { lovelace: "1" } },
      { address: DEV, amounts: { lovelace: "100" } },
    ], ctx);
    expect(problems).toEqual([]);
    expect(recipients).toEqual([
      { address: ALICE, treasuryId: null, label: "alice (@alice)", amounts: [
        { unit: "lovelace", quantity: 3_500_000n }, { unit: GVTT, quantity: 10_000_000n },
      ] },
      { address: OUTSIDE, treasuryId: null, label: null, amounts: [{ unit: GVTT, quantity: 1n }] },
      { address: DEV, treasuryId: "dev", label: "Dev wallet", amounts: [{ unit: "lovelace", quantity: 100_000_000n }] },
    ]);
    expect(paymentTotals(recipients)).toEqual(new Map([["lovelace", 103_500_000n], [GVTT, 10_000_001n]]));
  });

  it("reports every problem by name and never pays the treasury itself", () => {
    const { recipients, problems } = resolvePaymentRecipients([
      { address: TREASURY, amounts: { lovelace: "1" } },
      { address: "addr1mainnet", amounts: { lovelace: "1" } },
      { address: ALICE, amounts: { [`${"b".repeat(56)}00`]: "1" } },
      { address: OUTSIDE, amounts: { lovelace: "1.2345678" } },
      { address: DEV, amounts: { [GVTT]: "0" } },
      { address: "addr_test1bob", amounts: { lovelace: "" } },
      { address: "addr_test1carol", amounts: { lovelace: "abc" } },
    ], ctx);
    expect(recipients).toEqual([]);
    expect(problems).toHaveLength(7);
    expect(problems[0]).toContain("this is the paying treasury itself");
    expect(problems[1]).toContain("address is on a different network");
    expect(problems[2]).toMatch(/^alice \(@alice\): token .* is not held by this treasury$/);
    expect(problems[3]).toContain('invalid ADA amount "1.2345678"');
    expect(problems[4]).toBe("Dev wallet: GVTT amount must be greater than zero");
    expect(problems[5]).toContain("no amount entered");
    expect(problems[6]).toContain('invalid ADA amount "abc"');
  });

  it("caps the number of distinct recipients", () => {
    const inputs = Array.from({ length: MAX_PAYOUT_CONTRIBUTORS + 1 }, (_, i) => ({
      address: `addr_test1r${i}`, amounts: { lovelace: "1" },
    }));
    const { recipients, problems } = resolvePaymentRecipients(inputs, ctx);
    expect(recipients).toHaveLength(MAX_PAYOUT_CONTRIBUTORS + 1);
    expect(problems).toEqual([`At most ${MAX_PAYOUT_CONTRIBUTORS} recipients per payment (${MAX_PAYOUT_CONTRIBUTORS + 1} given)`]);
  });
});

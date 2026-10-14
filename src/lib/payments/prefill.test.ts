import { describe, expect, it } from "vitest";
import { isPaymentPrefill, parsePaymentPrefill, paymentPrefillQuery, type PaymentPrefill } from "./prefill";

const TREASURY = "40000000-0000-0000-0000-000000000002";
const PROPOSAL = "60000000-0000-0000-0000-000000000001";
const GVTT = `${"a".repeat(56)}47565454`;
const prefill: PaymentPrefill = { treasuryId: TREASURY, month: "2026-10", proposalId: PROPOSAL, amounts: { lovelace: "2500", [GVTT]: "10.5" } };

describe("payment prefill", () => {
  it("round-trips through the query string", () => {
    const query = paymentPrefillQuery(prefill);
    expect(query).toBe(`to=${TREASURY}&month=2026-10&proposal=${PROPOSAL}&amounts=${encodeURIComponent(`lovelace:2500,${GVTT}:10.5`)}`);
    expect(parsePaymentPrefill(Object.fromEntries(new URLSearchParams(query)))).toEqual(prefill);
    expect(parsePaymentPrefill(Object.fromEntries(new URLSearchParams(paymentPrefillQuery({ ...prefill, amounts: {} })))))
      .toEqual({ ...prefill, amounts: {} });
  });

  it("fills nothing from a missing, malformed or tampered link", () => {
    expect(parsePaymentPrefill({})).toBeNull();
    expect(parsePaymentPrefill({ to: TREASURY, month: "2026-10" })).toBeNull();
    expect(parsePaymentPrefill({ to: "main", month: "2026-10", proposal: PROPOSAL })).toBeNull();
    expect(parsePaymentPrefill({ to: TREASURY, month: "2026-13", proposal: PROPOSAL })).toBeNull();
    expect(parsePaymentPrefill({ to: TREASURY, month: "2026-10", proposal: PROPOSAL, amounts: "lovelace:abc" })).toBeNull();
    expect(parsePaymentPrefill({ to: TREASURY, month: "2026-10", proposal: PROPOSAL, amounts: "ADA:1" })).toBeNull();
    expect(parsePaymentPrefill({ to: [TREASURY], month: "2026-10", proposal: PROPOSAL })).toBeNull();
  });

  it("tells a prefill from the bare string the docs test passes to every route", () => {
    expect(isPaymentPrefill(prefill)).toBe(true);
    expect(isPaymentPrefill("abc")).toBe(false);
    expect(isPaymentPrefill(undefined)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { paymentDescription, paymentRecipientSummary, payoutDescription } from "./txDescription";

describe("transaction descriptions", () => {
  it("summarises a payout", () => {
    expect(payoutDescription({ tasks: 3, payments: 4, contributors: 2, tickers: ["ADA", "GVTT"] }))
      .toBe("Payout: 3 tasks, 4 payments, 2 contributors (ADA, GVTT)");
  });

  it("summarises a payment, naming transfers only when every recipient is a treasury", () => {
    expect(paymentDescription({ memo: "Hosting", recipients: 1, transfers: 0, tickers: ["ADA"] }))
      .toBe("Payment: Hosting, 1 recipient (ADA)");
    expect(paymentDescription({ memo: null, recipients: 3, transfers: 1, tickers: ["ADA"] }))
      .toBe("Payment: 3 recipients (ADA)");
    expect(paymentDescription({ memo: null, recipients: 1, transfers: 1, tickers: ["GVTT"] }))
      .toBe("Payment: 1 treasury transfer (GVTT)");
  });
});

describe("paymentRecipientSummary", () => {
  it("counts recipients, singular and plural", () => {
    expect(paymentRecipientSummary({ recipients: 1, transfers: 0 })).toBe("1 recipient");
    expect(paymentRecipientSummary({ recipients: 3, transfers: 0 })).toBe("3 recipients");
  });

  it("speaks of treasury transfers only when every recipient is a sibling treasury", () => {
    expect(paymentRecipientSummary({ recipients: 1, transfers: 1 })).toBe("1 treasury transfer");
    expect(paymentRecipientSummary({ recipients: 2, transfers: 2 })).toBe("2 treasury transfers");
    // A mixed payment is described by all its recipients, transfers included.
    expect(paymentRecipientSummary({ recipients: 3, transfers: 2 })).toBe("3 recipients");
    expect(paymentRecipientSummary({ recipients: 2, transfers: 1 })).toBe("2 recipients");
  });

  it("is the recipient part of a payment's description", () => {
    const p = { recipients: 2, transfers: 2 };
    expect(paymentDescription({ memo: null, tickers: ["ADA"], ...p })).toBe(`Payment: ${paymentRecipientSummary(p)} (ADA)`);
  });
});

import { describe, expect, it } from "vitest";
import { StakeAction } from "@/lib/constants";
import {
  displayTxDescription,
  paymentDescription,
  paymentRecipientSummary,
  payoutDescription,
  poolIdsNeedingTicker,
  stakeDescription,
  stakePoolLabel,
} from "./txDescription";

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

describe("stakeDescription", () => {
  it("prefers the pool ticker over the pool id in the title", () => {
    expect(
      stakeDescription(StakeAction.RegisterAndDelegate, {
        poolId: "pool1abc",
        poolTicker: "NUTS",
      }),
    ).toBe("Stake: register and delegate to NUTS");
    expect(
      stakeDescription(StakeAction.Delegate, { poolId: "pool1abc", poolTicker: "NUTS" }),
    ).toBe("Stake: delegate to NUTS");
  });

  it("falls back to the pool id when no ticker is known", () => {
    expect(stakeDescription(StakeAction.Delegate, { poolId: "pool1abc" }))
      .toBe("Stake: delegate to pool1abc");
    expect(stakePoolLabel({ poolId: "pool1abc", poolTicker: "  " })).toBe("pool1abc");
  });
});

describe("displayTxDescription", () => {
  it("rewrites a stake title from governance_action / ticker map", () => {
    expect(
      displayTxDescription({
        description: "Stake: register and delegate to pool1abc",
        governance_action: {
          kind: "stake",
          action: StakeAction.RegisterAndDelegate,
          poolId: "pool1abc",
          poolTicker: "NUTS",
        },
      }),
    ).toBe("Stake: register and delegate to NUTS");
    expect(
      displayTxDescription(
        {
          description: "Stake: delegate to pool1abc",
          governance_action: {
            kind: "stake",
            action: StakeAction.Delegate,
            poolId: "pool1abc",
          },
        },
        new Map([["pool1abc", "NUTS"]]),
      ),
    ).toBe("Stake: delegate to NUTS");
  });

  it("leaves non-stake descriptions alone", () => {
    expect(displayTxDescription({ description: "Payout: 1 task", governance_action: null }))
      .toBe("Payout: 1 task");
  });

  it("lists pool ids that still need a ticker", () => {
    expect(
      poolIdsNeedingTicker([
        {
          governance_action: {
            kind: "stake",
            action: StakeAction.Delegate,
            poolId: "pool1abc",
          },
        },
        {
          governance_action: {
            kind: "stake",
            action: StakeAction.Delegate,
            poolId: "pool1xyz",
            poolTicker: "XYZ",
          },
        },
      ]),
    ).toEqual(["pool1abc"]);
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

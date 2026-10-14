import { describe, expect, it } from "vitest";
import type { FundingCommitmentRow } from "@/lib/db/types";
import { describeCommitment, formatFundingAmount, fundingTokenOptions } from "./display";

const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";

function commitment(overrides: Partial<FundingCommitmentRow>): FundingCommitmentRow {
  return {
    id: "c", source_id: "s", community_id: "com", name: "C", url: null, note: null, kind: "one_off", cadence: null,
    starts_on: null, ends_on: null, amounts: [], created_by: "a", created_at: "", updated_at: "", ...overrides,
  };
}

describe("fundingTokenOptions", () => {
  it("lists ADA, the registry, wallet tokens and tokens already planned, once each", () => {
    const options = fundingTokenOptions(
      [{ fieldName: "GVTT", unit: "aa".repeat(30), decimals: 6 }],
      [{ unit: AGIX, ticker: "AGIX", decimals: 8 }, { unit: "aa".repeat(30), ticker: "Other", decimals: 0 }],
      [commitment({ amounts: [{ unit: "bb".repeat(30), amount: "1", asset_label: "SNEK", decimals: 0 }] })],
      [],
    );
    expect(options.map((o) => o.ticker)).toEqual(["ADA", "GVTT", "AGIX", "SNEK"]);
    expect(formatFundingAmount(AGIX, "21180072389063", options)).toBe("211,800.72389063 AGIX");
  });
});

describe("describeCommitment", () => {
  it("says what kind of commitment it is and when", () => {
    expect(describeCommitment(commitment({}), [])).toBe("One-off");
    expect(describeCommitment(commitment({ starts_on: "2026-05-01" }), [])).toMatch(/^One-off, expected /);
    expect(describeCommitment(commitment({ kind: "recurring", cadence: "monthly", starts_on: "2026-01-01" }), []))
      .toMatch(/^Monthly from .*, no end date$/);
    expect(describeCommitment(commitment({ kind: "schedule", cadence: "monthly" }), [])).toBe("Monthly schedule, no periods yet");
    expect(describeCommitment(commitment({ kind: "schedule", cadence: "monthly" }), [
      { commitment_id: "c", starts_on: "2021-07-01", amounts: [] },
      { commitment_id: "c", starts_on: "2022-04-01", amounts: [] },
    ])).toMatch(/^Monthly schedule, .+ – .+$/);
  });
});

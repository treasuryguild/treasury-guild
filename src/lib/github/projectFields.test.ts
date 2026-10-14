import { describe, expect, it } from "vitest";
import { extractProjectFields, matchStatusOption } from "./projectFields";

describe("matchStatusOption", () => {
  const options = [
    { id: "o1", name: "In review" },
    { id: "o2", name: "Paid" },
  ];

  it("matches case-insensitively and returns the option with GitHub's spelling", () => {
    expect(matchStatusOption(options, "paid")).toEqual({ id: "o2", name: "Paid" });
    expect(matchStatusOption(options, "  PAID ")).toEqual({ id: "o2", name: "Paid" });
  });

  it("returns null for a missing option or a blank (disabled) name", () => {
    expect(matchStatusOption(options, "Done")).toBeNull();
    expect(matchStatusOption(options, "")).toBeNull();
    expect(matchStatusOption([], "Paid")).toBeNull();
  });
});

describe("extractProjectFields", () => {
  it("extracts the Status single-select and all positive number fields", () => {
    const { status, numbers } = extractProjectFields([
      { name: "In review", field: { name: "Status" } },
      { number: 7, field: { name: "ADA" } },
      { number: 10, field: { name: "AGIX" } },
      { number: 30, field: { name: "MINS" } },
    ]);
    expect(status).toBe("In review");
    expect(numbers).toEqual({ ADA: 7, AGIX: 10, MINS: 30 });
  });

  it("ignores zero-value numbers, other select fields, and empty nodes", () => {
    const { status, numbers } = extractProjectFields([
      // GraphQL returns {} for field-value types the fragments don't match
      {},
      { number: 0, field: { name: "ADA" } },
      { name: "High", field: { name: "Priority" } },
      { number: 2.5, field: { name: "AGIX" } },
    ]);
    expect(status).toBeNull();
    expect(numbers).toEqual({ AGIX: 2.5 });
  });

  it("returns null status and no numbers for an empty list", () => {
    expect(extractProjectFields([])).toEqual({ status: null, numbers: {} });
  });
});

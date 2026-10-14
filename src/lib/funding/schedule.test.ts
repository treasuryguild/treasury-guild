import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { amountColumns, buildSchedule, readScheduleCsv, suggestDateColumn, type ScheduleMapping } from "./schedule";

const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
const GVTT = "fe12059162068d4302ae76efd385153a08ee82aed46a0a6f4238ce6a5465737420546f6b656e";
const agix = (index: number) => ({ index, unit: AGIX, ticker: "AGIX", decimals: 8 });

// The SNET release plan for two communities, as a funder shares it.
const SNET = `month,sc_allocation,ambassador_allocation
2021-07-01,225000,75000
2021-08-01,221625,73875
2021-09-01,218300.625,72766.875
2021-10-01,215026.115625,71675.371875
2021-11-01,211800.72389063,70600.24129688
2021-12-01,208623.71303227,69541.23767742
2022-01-01,205494.35733678,68498.11911226
2022-02-01,202411.94197673,67470.64732558
2022-03-01,199375.76284708,66458.58761569
2022-04-01,196385.12640437,65461.70880146
`;

const mapping = (overrides: Partial<ScheduleMapping>): ScheduleMapping => ({
  dateColumn: 0, startMonth: null, cadence: "monthly", columns: [agix(1)], ...overrides,
});

describe("reading the table", () => {
  it("finds the date column and the amount columns", () => {
    const table = readScheduleCsv(SNET);
    expect(table.issues).toEqual([]);
    expect(table.headers).toEqual(["month", "sc_allocation", "ambassador_allocation"]);
    expect(suggestDateColumn(table)).toBe(0);
    expect(amountColumns(table, 0)).toEqual([1, 2]);
  });

  it("suggests a date column by name or by its contents, or none", () => {
    expect(suggestDateColumn(readScheduleCsv("amount,Release Date\n5,2026-01-01"))).toBe(1);
    expect(suggestDateColumn(readScheduleCsv("when,amount\n01.02.2026,5\n01.03.2026,6"))).toBe(0);
    expect(suggestDateColumn(readScheduleCsv("amount,bonus\n5,1\n6,2"))).toBeNull();
  });
});

describe("buildSchedule", () => {
  it("scales one chosen column exactly and skips the others", () => {
    const sc = buildSchedule(readScheduleCsv(SNET), mapping({}));
    expect(sc.issues).toEqual([]);
    expect(sc.periods).toHaveLength(10);
    expect(sc.periods[4]).toEqual({ month: "2021-11", amounts: [{ unit: AGIX, amount: "211800.72389063", quantity: "21180072389063" }] });
    expect(sc.totals).toEqual({ [AGIX]: "210404336611286" });
    const amb = buildSchedule(readScheduleCsv(SNET), mapping({ columns: [agix(2)] }));
    expect(amb.periods[0]!.amounts[0]!.quantity).toBe("7500000000000");
  });

  it("maps several columns to several tokens in one schedule", () => {
    const table = readScheduleCsv("release_date,gvtt,ada\n2026-01-01,225,75\n2026-02-01,221.625,\n");
    const built = buildSchedule(table, mapping({
      columns: [{ index: 1, unit: GVTT, ticker: "GVTT", decimals: 6 }, { index: 2, unit: "lovelace", ticker: "ADA", decimals: 6 }],
    }));
    expect(built.periods).toEqual([
      { month: "2026-01", amounts: [{ unit: GVTT, amount: "225", quantity: "225000000" }, { unit: "lovelace", amount: "75", quantity: "75000000" }] },
      { month: "2026-02", amounts: [{ unit: GVTT, amount: "221.625", quantity: "221625000" }] },
    ]);
  });

  it("counts periods from a start month when there is no date column", () => {
    const table = readScheduleCsv("allocation\n100\n90\n80\n");
    const built = buildSchedule(table, mapping({ dateColumn: null, startMonth: "2026-01", cadence: "quarterly", columns: [agix(0)] }));
    expect(built.periods.map((p) => p.month)).toEqual(["2026-01", "2026-04", "2026-07"]);
    expect(buildSchedule(table, mapping({ dateColumn: null, startMonth: null, columns: [agix(0)] })).issues[0]!.message).toContain("first row");
    expect(buildSchedule(table, mapping({ dateColumn: null, startMonth: "2026-02", cadence: "quarterly", columns: [agix(0)] })).issues)
      .toHaveLength(1);
  });

  it("reports what cannot be used, by line", () => {
    const table = readScheduleCsv("period,amount\n2021-07,10\n2021-07-15,5\nsoon,1\n2021-10,1;5\n2021-11,\"1,5\"\n");
    const built = buildSchedule(table, mapping({ columns: [agix(1)] }));
    expect(built.issues.map((i) => [i.line, i.message.slice(0, 18)])).toEqual([
      [3, "2021-07 is already"],
      [4, "\"soon\" is not a da"],
      [5, "\"1;5\" in amount is"],
      [6, "\"1,5\" in amount ha"],
    ]);
    expect(buildSchedule(readScheduleCsv(SNET), mapping({ columns: [{ ...agix(1), decimals: 6 }] })).issues.map((i) => i.line))
      .toEqual([6, 7, 8, 9, 10, 11]);
    expect(buildSchedule(readScheduleCsv(SNET), mapping({ columns: [agix(1), agix(2)] })).issues[0]!.message).toContain("both mapped to AGIX");
    expect(buildSchedule(readScheduleCsv(SNET), mapping({ columns: [] })).issues[0]!.message).toContain("at least one");
  });

  it("reads the Signius sample release plan", () => {
    const table = readScheduleCsv(readFileSync("supabase/seeds/signius_funding_schedule.csv", "utf8"));
    const date = suggestDateColumn(table);
    expect(table.headers[date!]).toBe("release_date");
    const built = buildSchedule(table, mapping({
      dateColumn: date,
      columns: [{ index: 1, unit: GVTT, ticker: "GVTT", decimals: 6 }, { index: 2, unit: "lovelace", ticker: "ADA", decimals: 6 }],
    }));
    expect(built.issues).toEqual([]);
    expect(built.periods.map((p) => p.month)).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`));
    expect(built.periods[3]!.amounts[0]).toEqual({ unit: GVTT, amount: "215.026116", quantity: "215026116" });
  });
});

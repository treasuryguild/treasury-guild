// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduleCsvImport } from "./ScheduleCsvImport";

const GVTT = "fe12059162068d4302ae76efd385153a08ee82aed46a0a6f4238ce6a5465737420546f6b656e";
const options = [
  { unit: "lovelace", ticker: "ADA", decimals: 6 },
  { unit: GVTT, ticker: "GVTT", decimals: 6 },
];
const SAMPLE = readFileSync("supabase/seeds/signius_funding_schedule.csv", "utf8");

afterEach(cleanup);

describe("ScheduleCsvImport", () => {
  it("picks the date column, maps columns to tokens and hands over the periods", async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    render(<ScheduleCsvImport cadence="monthly" options={options} onUse={onUse} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule CSV text" }), { target: { value: SAMPLE } });

    expect((screen.getByRole("combobox", { name: "Date column" }) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("release_date");
    // signius_ada names ADA alone; two columns name GVTT, so both wait for a choice.
    expect((screen.getByRole("combobox", { name: "Token for signius_ada" }) as HTMLSelectElement).value).toBe("lovelace");
    expect((screen.getByRole("combobox", { name: "Token for signius_gvtt" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "Token for sister_community_gvtt" }) as HTMLSelectElement).value).toBe("");

    await user.selectOptions(screen.getByRole("combobox", { name: "Token for signius_gvtt" }), GVTT);
    expect(screen.getByRole("table", { name: "Import preview" }).textContent).toContain("221.625");
    expect(screen.getByText(/12 periods/).textContent).toContain("2,488.020477 GVTT");

    await user.click(screen.getByRole("button", { name: "Use these amounts" }));
    const [periods, units] = onUse.mock.calls[0]!;
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ month: "2026-01", amounts: [
      { unit: GVTT, amount: "225", quantity: "225000000" },
      { unit: "lovelace", amount: "75", quantity: "75000000" },
    ] });
    expect(units).toEqual([GVTT, "lovelace"]);
  });

  it("counts rows from a start month when the file has no date column", async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    render(<ScheduleCsvImport cadence="monthly" options={options} onUse={onUse} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule CSV text" }), { target: { value: "ada\n10\n9\n" } });
    await user.selectOptions(screen.getByRole("combobox", { name: "Date column" }), "none");
    await user.selectOptions(screen.getByRole("combobox", { name: "Token for ada" }), "lovelace");
    expect(screen.getByText(/month of the first row/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("First row's month"), { target: { value: "2026-03" } });
    await user.click(screen.getByRole("button", { name: "Use these amounts" }));
    expect(onUse.mock.calls[0]![0].map((p: { month: string }) => p.month)).toEqual(["2026-03", "2026-04"]);
  });
});

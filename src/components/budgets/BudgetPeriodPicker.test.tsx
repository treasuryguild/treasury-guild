// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BudgetPeriodPicker, type BudgetView } from "./BudgetPeriodPicker";

afterEach(cleanup);

function Picker() {
  const [month, setMonth] = useState("2026-11");
  const [view, setView] = useState<BudgetView>("month");
  return <>
    <BudgetPeriodPicker month={month} view={view} onChange={(month, view) => { setMonth(month); setView(view); }} />
    <output>{view}:{month}</output>
  </>;
}

/** The Dashboard's use: no recurring view, all time offered. */
function AllTimePicker() {
  const [month, setMonth] = useState("2026-11");
  const [view, setView] = useState<"month" | "quarter" | "all">("month");
  return <>
    <BudgetPeriodPicker month={month} view={view} recurring={false} allTime
      onChange={(month, view) => { setMonth(month); setView(view); }} />
    <output>{view}:{month}</output>
  </>;
}

describe("budget period picker", () => {
  it("selects a quarter and navigates across year boundaries", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Budget plan" }), "quarter");
    expect(screen.getByText("quarter:2026-10")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Budget quarter" }) as HTMLSelectElement).value).toBe("10");
    await user.click(screen.getByRole("button", { name: "Next quarter" }));
    expect(screen.getByText("quarter:2027-01")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Previous quarter" }));
    expect(screen.getByText("quarter:2026-10")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Budget quarter" }), "04");
    expect(screen.getByText("quarter:2026-04")).toBeTruthy();
  });

  it("edits the year and rejects incomplete input", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Budget plan" }), "quarter");
    const year = screen.getByRole("spinbutton", { name: "Budget year" });
    await user.clear(year); await user.type(year, "2028{Enter}");
    expect(screen.getByText("quarter:2028-10")).toBeTruthy();
    await user.clear(year); await user.tab();
    expect((year as HTMLInputElement).value).toBe("2028");
    await user.selectOptions(screen.getByRole("combobox", { name: "Budget plan" }), "recurring");
    expect(screen.queryByRole("spinbutton", { name: "Budget year" })).toBeNull();
  });

  it("offers all time only when asked, without a period to pick, and keeps the month for the way back", async () => {
    const user = userEvent.setup();
    render(<Picker />);
    expect(screen.queryByRole("option", { name: "All time" })).toBeNull();
    cleanup();
    render(<AllTimePicker />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Budget plan" }), "all");
    expect(screen.getByText("all:2026-11")).toBeTruthy();
    expect(screen.queryByLabelText("Budget month")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next month" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Recurring defaults" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Budget plan" }), "month");
    expect(screen.getByText("month:2026-11")).toBeTruthy();
    expect(screen.getByLabelText("Budget month")).toBeTruthy();
  });
});

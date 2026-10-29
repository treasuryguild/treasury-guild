// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BudgetSetupContext, BudgetView } from "@/lib/budgetSetups";
import type { BudgetSummary } from "@/lib/api/types";
import type { TreasurySummary } from "@/lib/db/types";
import { apiFetch } from "@/lib/api/client";
import type * as ApiClientModule from "@/lib/api/client";
import { BudgetWorksheet } from "./BudgetWorksheet";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...await importOriginal<typeof ApiClientModule>(),
  apiFetch: vi.fn(),
}));
vi.mock("@/hooks/useWalletAssets", () => ({
  useWalletAssets: () => ({ data: null, loading: false, error: null }),
}));

function budget(id: string, changes: Partial<BudgetSummary> = {}): BudgetSummary {
  return {
    id, ownerType: "workgroup", ownerId: id, ownerName: id, treasuryId: null, workgroupKind: "native", budgetMonth: "2026-09",
    unit: "lovelace", assetLabel: "ADA", decimals: 6, cadence: "monthly",
    amount: "100000000", spent: "0", balance: "100000000",
    periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
    periodLabel: "September 2026", ...changes,
  };
}

const props = () => ({
  communityId: "community", month: "2026-09", view: "month" as BudgetView, title: "September 2026",
  budgets: [budget("design"), budget("engineering")],
  setups: ["design", "engineering"].map((id): BudgetSetupContext => ({
    ownerType: "workgroup", ownerId: id, ownerName: id, workgroupId: id, workgroupKind: "native", treasuryId: null,
    revision: 0, legacyConflict: false,
    timeline: [{ id: id + "-setup", starts_on: "2026-01-01", mode: "monthly", cadence: "monthly", amounts: [] }],
    plans: [], legacy: [], history: [],
  })),
  workgroups: [
    { id: "design", name: "Design", kind: "native", treasury_id: null, archived_at: null as string | null },
    { id: "engineering", name: "Engineering", kind: "native", treasury_id: null, archived_at: null as string | null },
  ],
  treasuries: [] as TreasurySummary[], assets: [], isAdmin: true, ledWorkgroupIds: new Set<string>(),
  onDirtyChange: vi.fn(), onBusyChange: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined),
});

it("keeps archived budget history visible and read-only for admins", () => {
  const input = props();
  input.workgroups[0]!.archived_at = "2026-09-09T00:00:00Z";
  render(<BudgetWorksheet {...input} />);
  expect(screen.getByText("Design (Archived)")).toBeTruthy();
  expect((screen.getByLabelText("Design ADA budget amount") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Engineering ADA budget amount") as HTMLInputElement).disabled).toBe(false);
});

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("treasury budgets", () => {
  it("lists a treasury as its own card that only admins edit, saving with the treasury owner", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, revision: 1 });
    const input = props();
    input.treasuries = [{
      id: "main", name: "Main", address: "addr_main", required: 1, script_type: "atLeast",
      template: "plain", lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null, archived_at: null, stake_credential_hash: null,
      treasury_signers: [{ signer_group: "base" }],
    }];
    input.setups.push({
      ownerType: "treasury", ownerId: "main", ownerName: "Main", workgroupId: null, workgroupKind: null, treasuryId: "main",
      revision: 0, legacyConflict: false, plans: [], legacy: [], history: [],
      timeline: [{ id: "main-setup", starts_on: "2026-01-01", mode: "monthly", cadence: "monthly", amounts: [] }],
    });
    input.budgets.push(budget("main", { ownerType: "treasury", ownerName: "Treasury: Main", treasuryId: "main", workgroupKind: null }));
    const view = render(<BudgetWorksheet {...input} />);
    const card = screen.getByRole("rowgroup", { name: "Main" });
    expect(card.textContent).toContain("Treasury");
    expect(screen.queryByRole("button", { name: "Reset budgets for Main" })).toBeNull();
    expect(screen.getByText("3 of 3 projects")).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Main ADA budget amount" });
    await user.clear(field); await user.type(field, "500");
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: {
      treasuryId: "main", budgetMonth: "2026-09", budgetCadence: "monthly",
      mode: "monthly", startsOn: "2026-09", expectedRevision: 0, confirmTransition: false, reason: "",
      budgets: [{ unit: "lovelace", cadence: "monthly", amount: "500000000" }],
    } }));
    // A workgroup lead who is not an admin sees the treasury read-only.
    view.rerender(<BudgetWorksheet {...input} isAdmin={false} ledWorkgroupIds={new Set(["design"])} />);
    expect((screen.getByRole("textbox", { name: "Main ADA budget amount" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Design ADA budget amount" }) as HTMLInputElement).disabled).toBe(false);
  });
});

describe("budget reset integration", () => {
  it("shows reset only to admins on active workgroups and protects staged edits", async () => {
    const user = userEvent.setup();
    const input = props();
    input.workgroups[1]!.archived_at = "2026-09-09T00:00:00Z";
    const view = render(<BudgetWorksheet {...input} />);
    expect(screen.queryByRole("button", { name: "Reset budgets for Engineering" })).toBeNull();
    await user.clear(screen.getByLabelText("Design ADA budget amount"));
    await user.type(screen.getByLabelText("Design ADA budget amount"), "150");
    expect((screen.getByRole("button", { name: "Reset budgets for Design" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<BudgetWorksheet {...input} isAdmin={false} ledWorkgroupIds={new Set(["design"])} />);
    expect(screen.queryByRole("button", { name: "Reset budgets for Design" })).toBeNull();
  });

  it("refreshes a reset to no setup while keeping other projects' edits", async () => {
    const user = userEvent.setup();
    const input = props();
    const view = render(<BudgetWorksheet {...input} />);
    input.onRefresh.mockImplementation(async () => {
      input.budgets = input.budgets.filter((b) => b.ownerId !== "design");
      input.setups = input.setups.map((s) => s.ownerId === "design"
        ? { ...s, revision: 1, timeline: [], plans: [], legacy: [], history: [] } : s);
      view.rerender(<BudgetWorksheet {...input} />);
    });
    await user.clear(screen.getByLabelText("Engineering ADA budget amount"));
    await user.type(screen.getByLabelText("Engineering ADA budget amount"), "250");
    vi.mocked(apiFetch).mockResolvedValueOnce({ revision: 0, hasBudgets: true, blockedReason: null })
      .mockResolvedValueOnce({ revision: 1 });
    await user.click(screen.getByRole("button", { name: "Reset budgets for Design" }));
    await user.type(await screen.findByLabelText("Reason for resetting budgets"), "Wrong setup");
    await user.type(screen.getByLabelText("Type Design to confirm budget reset"), "Design");
    await user.click(screen.getByRole("button", { name: "Reset all budgets" }));
    await waitFor(() => expect(input.onRefresh).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("Design ADA budget amount")).toBeNull();
    expect(screen.getByText("No setup")).toBeTruthy();
    expect((screen.getByLabelText("Engineering ADA budget amount") as HTMLInputElement).value).toBe("250");
    expect(screen.getByText("1 project with unsaved changes")).toBeTruthy();
  });
});

describe("budget worksheet interactions", () => {
  it("edits across projects with Enter and saves changes hidden by a search", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true });
    render(<BudgetWorksheet {...props()} />);
    const first = screen.getByRole("textbox", { name: "Design ADA budget amount" });
    const second = screen.getByRole("textbox", { name: "Engineering ADA budget amount" });
    await user.clear(first); await user.type(first, "150{Enter}");
    expect(document.activeElement).toBe(second);
    await user.clear(second); await user.type(second, "250");
    await user.type(screen.getByRole("searchbox"), "Design");
    expect(screen.getByText(/Includes 1 project hidden/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: {
      workgroupId: "design", budgetMonth: "2026-09", budgetCadence: "monthly",
      mode: "monthly", startsOn: "2026-09", expectedRevision: 0, confirmTransition: false, reason: "",
      budgets: [{ unit: "lovelace", cadence: "monthly", amount: "150000000" }],
    } });
    expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: {
      workgroupId: "engineering", budgetMonth: "2026-09", budgetCadence: "monthly",
      mode: "monthly", startsOn: "2026-09", expectedRevision: 0, confirmTransition: false, reason: "",
      budgets: [{ unit: "lovelace", cadence: "monthly", amount: "250000000" }],
    } });
  });

  it("blocks the whole save when an amount is invalid", async () => {
    const user = userEvent.setup();
    render(<BudgetWorksheet {...props()} />);
    await user.type(screen.getByRole("textbox", { name: "Design ADA budget amount" }), "x");
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Fix the highlighted amounts/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Design ADA budget amount" }).getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps failed drafts and retries only the project that failed", async () => {
    const user = userEvent.setup();
    let failEngineering = true;
    vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
      const body = init?.body as { workgroupId: string };
      if (body.workgroupId === "engineering" && failEngineering) throw new Error("Network unavailable");
      return { ok: true, revision: 1 };
    });
    // A refresh failure must not cause successful projects to be resubmitted.
    render(<BudgetWorksheet {...props()} onRefresh={vi.fn().mockRejectedValue(new Error("Offline"))} />);
    for (const name of ["Design", "Engineering"]) {
      const input = screen.getByRole("textbox", { name: `${name} ADA budget amount` });
      await user.clear(input); await user.type(input, "200");
    }
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await screen.findByText(/1 projects saved; 1 could not be saved/);
    expect((screen.getByRole("textbox", { name: "Engineering ADA budget amount" }) as HTMLInputElement).value).toBe("200");
    failEngineering = false;
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect((vi.mocked(apiFetch).mock.calls[2]?.[1]?.body as { workgroupId: string }).workgroupId).toBe("engineering");
    await screen.findByText("No unsaved changes");
  });

  it("undoes removal before saving and can stage deletion without a popup", async () => {
    const user = userEvent.setup();
    render(<BudgetWorksheet {...props()} />);
    await user.click(screen.getByRole("button", { name: "Remove Design ADA budget" }));
    expect(screen.getByText("Will be removed when saved")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Design ADA budget amount" }) as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Undo Design ADA change" }));
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("discarding a failed project's draft does not visually revert successful saves after a refresh failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
      if ((init?.body as { workgroupId: string }).workgroupId === "engineering") throw new Error("Offline");
      return { ok: true, revision: 1 };
    });
    render(<BudgetWorksheet {...props()} onRefresh={vi.fn().mockRejectedValue(new Error("Offline"))} />);
    for (const name of ["Design", "Engineering"]) {
      const field = screen.getByRole("textbox", { name: `${name} ADA budget amount` });
      await user.clear(field); await user.type(field, "200");
    }
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await screen.findByText(/1 projects saved; 1 could not be saved/);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect((screen.getByRole("textbox", { name: "Design ADA budget amount" }) as HTMLInputElement).value).toBe("200");
    expect((screen.getByRole("textbox", { name: "Engineering ADA budget amount" }) as HTMLInputElement).value).toBe("100");
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
  });

  it("copies forward as drafts only for editable projects in the current view", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ budgets: [
      budget("design", { budgetMonth: "2026-08", periodStart: "2026-08-01T00:00:00Z", amount: "250000000" }),
      budget("engineering", { budgetMonth: "2026-08", periodStart: "2026-08-01T00:00:00Z" }),
    ] });
    render(<BudgetWorksheet {...props()} budgets={[]} isAdmin={false} ledWorkgroupIds={new Set(["design"])} />);
    await user.click(screen.getByRole("button", { name: "Copy last month" }));
    await screen.findByText(/1 amount copied/);
    expect((screen.getByRole("textbox", { name: "Design ADA budget amount" }) as HTMLInputElement).value).toBe("250");
    expect(screen.queryByRole("textbox", { name: "Engineering ADA budget amount" })).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch).mock.calls[0]?.[1]?.body).toBeUndefined();
  });

});

function quarterProps() {
  const base = props();
  const monthly = (month: string, amount: string) => budget("design", {
    id: `design-${month}`, budgetMonth: month, amount, periodStart: `${month}-01T00:00:00Z`,
    periodEnd: `${month === "2026-09" ? "2026-10" : month === "2026-08" ? "2026-09" : "2026-08"}-01T00:00:00Z`, periodLabel: month,
  });
  base.month = "2026-07";
  base.view = "quarter";
  base.title = "Q3 2026 · Jul–Sep";
  base.budgets = [
    monthly("2026-07", "100000000"), monthly("2026-08", "200000000"), monthly("2026-09", "300000000"),
    budget("engineering", { budgetMonth: "2026-07", cadence: "quarterly", amount: "900000000",
      periodStart: "2026-07-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", periodLabel: "Q3 2026" }),
  ];
  base.setups[1]!.timeline[0] = { id: "engineering-setup", starts_on: "2026-07-01", mode: "quarterly", cadence: "quarterly", amounts: [] };
  return base;
}

describe("quarter grid", () => {
  it("shows one cell per month for a monthly project and one quarter cell for a quarterly one", () => {
    render(<BudgetWorksheet {...quarterProps()} />);
    for (const [label, value] of [["Jul 2026", "100"], ["Aug 2026", "200"], ["Sep 2026", "300"]] as const) {
      expect((screen.getByRole("textbox", { name: `Design ADA ${label} budget amount` }) as HTMLInputElement).value).toBe(value);
    }
    expect((screen.getByRole("textbox", { name: "Engineering ADA Q3 2026 budget amount" }) as HTMLInputElement).value).toBe("900");
    expect(screen.queryByText(/Change its setup to budget in this view/)).toBeNull();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Project / token", "Jul 2026", "Aug 2026", "Sep 2026", "Changes"]);
    // Each cell names its month itself, not only the column header.
    expect(screen.getAllByText("Aug 2026")).toHaveLength(2);
    expect(screen.getByText("Q3 2026 · whole quarter")).toBeTruthy();
    expect(screen.getByText(/Saved allocation · one amount per month/)).toBeTruthy();
    expect(screen.getByText(/Saved allocation · one amount per quarter/)).toBeTruthy();
  });

  it("saves the current month and the current quarter as plain plan updates mid-quarter", async () => {
    const user = userEvent.setup();
    let revision = 0;
    vi.mocked(apiFetch).mockImplementation(async () => ({ ok: true, revision: ++revision }));
    render(<BudgetWorksheet {...quarterProps()} />);
    // In September, July and August are past months (correction flow), but Q3 is still current.
    expect(screen.getByRole("textbox", { name: "Design ADA Aug 2026 budget amount" }).getAttribute("readonly")).not.toBeNull();
    const sep = screen.getByRole("textbox", { name: "Design ADA Sep 2026 budget amount" });
    await user.clear(sep); await user.type(sep, "350");
    const quarter = screen.getByRole("textbox", { name: "Engineering ADA Q3 2026 budget amount" });
    expect(quarter.getAttribute("readonly")).toBeNull();
    await user.clear(quarter); await user.type(quarter, "950");
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: {
      workgroupId: "design", budgetMonth: "2026-09", budgetCadence: "monthly", mode: "monthly", startsOn: "2026-09",
      expectedRevision: 0, confirmTransition: false, reason: "",
      budgets: [{ unit: "lovelace", cadence: "monthly", amount: "350000000" }],
    } });
    expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: {
      workgroupId: "engineering", budgetMonth: "2026-07", budgetCadence: "quarterly", mode: "quarterly", startsOn: "2026-07",
      expectedRevision: 0, confirmTransition: false, reason: "",
      budgets: [{ unit: "lovelace", cadence: "quarterly", amount: "950000000" }],
    } });
    await screen.findByText("Saved changes for 2 projects.");
  });

  it("chains two months of one project with increasing revisions", async () => {
    const user = userEvent.setup();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    let revision = 0;
    vi.mocked(apiFetch).mockImplementation(async () => ({ ok: true, revision: ++revision }));
    render(<BudgetWorksheet {...quarterProps()} />);
    for (const [label, value] of [["Jul 2026", "150"], ["Aug 2026", "250"]] as const) {
      const field = screen.getByRole("textbox", { name: `Design ADA ${label} budget amount` });
      await user.clear(field); await user.type(field, value);
    }
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const bodies = vi.mocked(apiFetch).mock.calls.map((call) => call[1]?.body as { budgetMonth: string; expectedRevision: number; startsOn: string });
    expect(bodies.map((b) => [b.budgetMonth, b.startsOn, b.expectedRevision])).toEqual([["2026-07", "2026-07", 0], ["2026-08", "2026-08", 1]]);
  });

  it("stages a removal for one month when its cell is cleared and undoes it per token", async () => {
    const user = userEvent.setup();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    render(<BudgetWorksheet {...quarterProps()} />);
    const aug = screen.getByRole("textbox", { name: "Design ADA Aug 2026 budget amount" });
    await user.clear(aug);
    expect(screen.getByText("Will be removed when saved")).toBeTruthy();
    expect((aug as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText("1 project with unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo Design ADA change" }));
    expect((aug as HTMLInputElement).value).toBe("200");
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
  });

  it("copies last quarter month by month", async () => {
    const user = userEvent.setup();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    const input = quarterProps();
    input.budgets = input.budgets.filter((b) => b.ownerId === "engineering");
    vi.mocked(apiFetch).mockResolvedValue({ budgets: [
      budget("design", { budgetMonth: "2026-04", periodStart: "2026-04-01T00:00:00Z", amount: "400000000" }),
      budget("design", { budgetMonth: "2026-06", periodStart: "2026-06-01T00:00:00Z", amount: "600000000" }),
    ] });
    render(<BudgetWorksheet {...input} />);
    await user.click(screen.getByRole("button", { name: "Copy last quarter" }));
    await screen.findByText(/2 amounts copied from Q2 2026/);
    expect(vi.mocked(apiFetch).mock.calls[0]?.[1]?.query).toEqual({ communityId: "community", month: "2026-04", view: "quarter" });
    expect((screen.getByRole("textbox", { name: "Design ADA Jul 2026 budget amount" }) as HTMLInputElement).value).toBe("400");
    expect((screen.getByRole("textbox", { name: "Design ADA Aug 2026 budget amount" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "Design ADA Sep 2026 budget amount" }) as HTMLInputElement).value).toBe("600");
  });

  it("shows a quarterly project read-only in the month view with a link to its quarter", async () => {
    const user = userEvent.setup();
    const onOpenQuarter = vi.fn();
    const input = props();
    input.budgets = [budget("design"), budget("engineering", { budgetMonth: "2026-07", cadence: "quarterly", amount: "900000000",
      periodStart: "2026-07-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", periodLabel: "Q3 2026" })];
    input.setups[1]!.timeline[0] = { id: "engineering-setup", starts_on: "2026-07-01", mode: "quarterly", cadence: "quarterly", amounts: [] };
    render(<BudgetWorksheet {...input} onOpenQuarter={onOpenQuarter} />);
    expect(screen.queryByRole("textbox", { name: "Engineering ADA budget amount" })).toBeNull();
    expect(screen.getByText("900 ADA")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit in Q3 2026" }));
    expect(onOpenQuarter).toHaveBeenCalledWith("2026-07");
  });
});

function recurringProps() {
  const base = props();
  base.budgets = [budget("design", { budgetMonth: null })];
  base.setups[0]!.timeline[0] = { id: "design-setup", starts_on: "2026-01-01", mode: "recurring", cadence: "monthly",
    amounts: [{ unit: "lovelace", amount: "100000000", asset_label: "ADA", decimals: 6 }] };
  return base;
}

describe("budget setup transitions", () => {
  it("does not silently adopt a newer revision while failed edits remain", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockRejectedValue(new Error("Budgets changed. Reload and review."));
    const base = props();
    const view = render(<BudgetWorksheet {...base} />);
    const field = screen.getByRole("textbox", { name: "Design ADA budget amount" });
    await user.clear(field); await user.type(field, "200");
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await screen.findByText(/0 projects saved; 1 could not be saved/);
    view.rerender(<BudgetWorksheet {...base} setups={base.setups.map((s) => ({ ...s, revision: 1 }))} />);
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiFetch).mock.calls[1]?.[1]?.body).toEqual(expect.objectContaining({ expectedRevision: 0 }));
  });
  it("viewing recurring amounts in a month never stages an override", () => {
    render(<BudgetWorksheet {...recurringProps()} />);
    expect((screen.getByRole("button", { name: "Save all changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it("lets a recurring edit continue from the selected month and saves only after the batch review", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, revision: 1 });
    render(<BudgetWorksheet {...recurringProps()} />);
    await user.click(screen.getByRole("textbox", { name: "Design ADA budget amount" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Project budget setup" }), "recurring");
    await user.click(screen.getByRole("button", { name: "Stage setup change" }));
    const field = screen.getByRole("textbox", { name: "Design ADA budget amount" });
    await user.clear(field); await user.type(field, "120");
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    expect(apiFetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm and save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: {
      workgroupId: "design", budgetMonth: null, budgetCadence: "monthly", mode: "recurring", startsOn: "2026-09",
      expectedRevision: 0, confirmTransition: true, reason: "",
      budgets: [{ unit: "lovelace", amount: "120000000", cadence: "monthly" }],
    } }));
  });
  it("can switch a recurring project to explicit monthly planning", async () => {
    const user = userEvent.setup(); vi.mocked(apiFetch).mockResolvedValue({ ok: true, revision: 1 });
    render(<BudgetWorksheet {...recurringProps()} />);
    await user.click(screen.getByRole("textbox", { name: "Design ADA budget amount" }));
    await user.click(screen.getByRole("button", { name: "Stage setup change" }));
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await user.click(screen.getByRole("button", { name: "Confirm and save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: expect.objectContaining({ mode: "monthly", startsOn: "2026-09", confirmTransition: true }) }));
  });
  it("offers the next quarter boundary when changing a quarterly project to monthly", async () => {
    const user = userEvent.setup(); vi.mocked(apiFetch).mockResolvedValue({ ok: true, revision: 1 });
    const base = props(); base.budgets = [];
    base.setups[0]!.timeline[0] = { id: "design-setup", starts_on: "2026-07-01", mode: "quarterly", cadence: "quarterly", amounts: [] };
    render(<BudgetWorksheet {...base} />);
    await user.click(screen.getAllByRole("button", { name: "Add budget" })[0]!);
    expect((screen.getByLabelText("Setup effective month") as HTMLInputElement).value).toBe("2026-10");
    await user.click(screen.getByRole("button", { name: "Stage setup change" }));
    const field = screen.getByRole("textbox", { name: "Design ADA budget amount" });
    expect((field as HTMLInputElement).value).toBe("");
    await user.type(field, "300");
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await user.click(screen.getByRole("button", { name: "Confirm and save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: expect.objectContaining({ mode: "monthly", startsOn: "2026-10", budgetMonth: "2026-10" }) }));
  });
  it("cancelling the setup prompt leaves budgets unchanged", async () => {
    const user = userEvent.setup(); render(<BudgetWorksheet {...recurringProps()} />);
    await user.click(screen.getAllByRole("button", { name: "Change setup" })[0]!);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("button", { name: "Save all changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it("backfills a past month before the first setup, with a reason, until that setup starts", async () => {
    const user = userEvent.setup(); vi.mocked(apiFetch).mockResolvedValue({ ok: true, revision: 1 });
    const base = props(); base.budgets = [];
    render(<BudgetWorksheet {...base} month="2025-11" title="November 2025" />);
    await user.click(screen.getAllByRole("button", { name: "Add budget" })[0]!);
    expect((screen.getByLabelText("Setup effective month") as HTMLInputElement).value).toBe("2025-11");
    expect(screen.getByRole("dialog").textContent).toContain("runs until 2026-01");
    expect((screen.getByRole("button", { name: "Stage setup change" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Budget correction reason" }), "Budget before the move");
    await user.click(screen.getByRole("button", { name: "Stage setup change" }));
    await user.type(screen.getByRole("textbox", { name: "Design ADA budget amount" }), "50");
    await user.click(screen.getByRole("button", { name: "Save all changes" }));
    await user.click(screen.getByRole("button", { name: "Confirm and save all changes" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/budgets", { body: expect.objectContaining({
      startsOn: "2025-11", reason: "Budget before the move",
    }) }));
  });
  it("refuses a quarterly backfill that would cut a quarter short", async () => {
    const user = userEvent.setup();
    const base = props(); base.budgets = [];
    base.setups[0]!.timeline[0] = { id: "design-setup", starts_on: "2026-02-01", mode: "monthly", cadence: "monthly", amounts: [] };
    render(<BudgetWorksheet {...base} month="2025-10" title="October 2025" />);
    await user.click(screen.getAllByRole("button", { name: "Add budget" })[0]!);
    await user.selectOptions(screen.getByRole("combobox", { name: "Project budget setup" }), "quarterly");
    await user.type(screen.getByRole("textbox", { name: "Budget correction reason" }), "Q4 budget");
    expect(screen.getByRole("dialog").textContent).toContain("must end at a quarter boundary");
    expect((screen.getByRole("button", { name: "Stage setup change" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("requires a reason before staging a correction for a past month", async () => {
    const user = userEvent.setup();
    const july = { budgetMonth: "2026-07", periodStart: "2026-07-01T00:00:00Z", periodEnd: "2026-08-01T00:00:00Z", periodLabel: "July 2026" };
    render(<BudgetWorksheet {...props()} month="2026-07" title="July 2026" budgets={[budget("design", july), budget("engineering", july)]} />);
    await user.click(screen.getByRole("textbox", { name: "Design ADA budget amount" }));
    expect((screen.getByRole("button", { name: "Stage setup change" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Budget correction reason" }), "Correct approved allocation");
    expect((screen.getByRole("button", { name: "Stage setup change" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

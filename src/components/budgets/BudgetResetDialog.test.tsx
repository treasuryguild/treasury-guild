// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiFetch } from "@/lib/api/client";
import type * as ApiClientModule from "@/lib/api/client";
import { BudgetResetDialog } from "./BudgetResetDialog";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...await importOriginal<typeof ApiClientModule>(), apiFetch: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.mocked(apiFetch).mockResolvedValue({ revision: 2, hasBudgets: true, blockedReason: null });
});
afterEach(cleanup);
function setup() {
  const onReset = vi.fn().mockResolvedValue(undefined);
  render(<BudgetResetDialog workgroupId="design" name="Design" expectedRevision={2} onClose={vi.fn()} onReset={onReset} />);
  return { user: userEvent.setup(), onReset };
}
it("requires a reason and the exact name before resetting every period", async () => {
  const { user, onReset } = setup();
  const name = await screen.findByLabelText("Type Design to confirm budget reset");
  const button = screen.getByRole("button", { name: "Reset all budgets" }) as HTMLButtonElement;
  await user.type(name, "design");
  await user.type(screen.getByLabelText("Reason for resetting budgets"), "Incorrect dates");
  expect(button.disabled).toBe(true);
  await user.clear(name); await user.type(name, "Design");
  vi.mocked(apiFetch).mockResolvedValueOnce({ revision: 3 });
  await user.click(button);
  expect(apiFetch).toHaveBeenLastCalledWith("/api/budgets/reset", { body: {
    workgroupId: "design", expectedRevision: 2, confirmation: "Design", reason: "Incorrect dates",
  } });
  expect(onReset).toHaveBeenCalledWith(3);
});
it("explains payment blockers without allowing reset", async () => {
  vi.mocked(apiFetch).mockResolvedValue({ revision: 2, hasBudgets: true, blockedReason: "Payment history must be retained" });
  setup();
  expect(await screen.findByText("Payment history must be retained")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Reset all budgets" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByLabelText("Reason for resetting budgets")).toBeNull();
});
it("requires reviewing a newer revision instead of silently adopting it", async () => {
  vi.mocked(apiFetch).mockResolvedValue({ revision: 3, hasBudgets: true, blockedReason: null });
  setup();
  expect(await screen.findByText(/Budgets changed since this worksheet loaded/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Reset all budgets" }) as HTMLButtonElement).disabled).toBe(true);
});
it("keeps failed resets open and checks for new blockers", async () => {
  const { user, onReset } = setup();
  await user.type(await screen.findByLabelText("Type Design to confirm budget reset"), "Design");
  await user.type(screen.getByLabelText("Reason for resetting budgets"), "Mistake");
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error("A payout was created"))
    .mockResolvedValueOnce({ revision: 2, hasBudgets: true, blockedReason: "Payment history must be retained" });
  await user.click(screen.getByRole("button", { name: "Reset all budgets" }));
  await waitFor(() => expect(screen.getByText("A payout was created")).toBeTruthy());
  expect(await screen.findByText("Payment history must be retained")).toBeTruthy();
  expect(onReset).not.toHaveBeenCalled();
});

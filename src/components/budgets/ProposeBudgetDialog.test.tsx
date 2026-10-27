// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiFetch } from "@/lib/api/client";
import type * as ApiClientModule from "@/lib/api/client";
import { DEFAULT_SETTINGS, rulesFor } from "@/lib/governance/rules";
import { ProposeBudgetDialog } from "./ProposeBudgetDialog";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...await importOriginal<typeof ApiClientModule>(), apiFetch: vi.fn(),
}));

const settings = { ...DEFAULT_SETTINGS.budget, enabled: true };

function renderDialog(onSubmit = vi.fn()) {
  render(<ProposeBudgetDialog communityId="c-1" workgroupIds={["wg-1"]} projectNames={["Design"]} settings={settings}
    busy={false} error={null} onClose={() => {}} onSubmit={onSubmit} />);
  return onSubmit;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockResolvedValue({ count: 4, eligible: 4 });
});
afterEach(cleanup);

it("submits the community default until the rules are adjusted", async () => {
  const onSubmit = renderDialog();
  const user = userEvent.setup();

  expect(screen.getByText("Consent, quorum 25%")).toBeTruthy();
  expect(screen.getByText("Adjust these rules").closest("details")?.hasAttribute("open")).toBe(false);
  expect(await screen.findByText(/about 4 voters/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Make proposal" }));
  expect(onSubmit).toHaveBeenCalledWith({ title: "Budget changes: Design", body: "", discussionUrl: null });

  fireEvent.change(screen.getByLabelText("Voting (hours)"), { target: { value: "48" } });
  expect(screen.getByText("Voting: 2 days, community default is 3 days")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Make proposal" }));
  expect(onSubmit).toHaveBeenLastCalledWith({
    title: "Budget changes: Design", body: "", discussionUrl: null,
    rules: { ...rulesFor(DEFAULT_SETTINGS.budget), votingHours: 48 },
  });

  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.queryByText(/community default is/)).toBeNull();
});

it("disables making a budget proposal nobody could vote on", async () => {
  vi.mocked(apiFetch).mockResolvedValue({ count: 0, eligible: 0 });
  const onSubmit = renderDialog();
  expect((await screen.findByRole("status")).textContent).toMatch(/Nobody can vote/);
  expect((screen.getByRole("button", { name: "Make proposal" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(apiFetch).toHaveBeenCalledWith("/api/proposals/electorate", expect.objectContaining({
    query: expect.objectContaining({ kind: "budget", communityId: "c-1", workgroupIds: "wg-1", recuseBeneficiaries: false }),
  }));
});

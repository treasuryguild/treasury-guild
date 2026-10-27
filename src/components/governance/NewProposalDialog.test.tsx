// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiFetch } from "@/lib/api/client";
import type * as ApiClientModule from "@/lib/api/client";
import { ProposalKind, TaskSource } from "@/lib/constants";
import { DEFAULT_SETTINGS, rulesFor } from "@/lib/governance/rules";
import type { GovernanceSettingsByKind } from "@/hooks/useProposals";
import { NewProposalDialog, type ProposerRoles } from "./NewProposalDialog";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...await importOriginal<typeof ApiClientModule>(), apiFetch: vi.fn(),
}));

const settings = Object.fromEntries(
  Object.values(ProposalKind).map((kind) => [kind, { ...DEFAULT_SETTINGS[kind], enabled: true }]),
) as GovernanceSettingsByKind;

const member: ProposerRoles = { isAdmin: false, ledWorkgroupIds: new Set() };

function setup(roles: ProposerRoles = member) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <NewProposalDialog communityId="c-1" kinds={["decision", "task"]} settings={settings} roles={roles}
      workgroups={[{ id: "wg-1", name: "Design", kind: TaskSource.Native, treasury_id: null, archived_at: null }]}
      members={[]} sessionWallet={null} onClose={onClose} onCreated={onCreated} />,
  );
  return { user: userEvent.setup(), onClose, onCreated };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiFetch).mockImplementation(async (path: string) =>
    path === "/api/proposals" ? { id: "p-1", number: 3 } : { count: 4, eligible: 4 });
});
afterEach(cleanup);

it("starts from the community default and leaves the rules editor collapsed", async () => {
  setup();
  expect(await screen.findByText("Majority vote above 50%, quorum 20%")).toBeTruthy();
  expect(screen.getByText("Adjust these rules").closest("details")?.hasAttribute("open")).toBe(false);
  expect(screen.queryByText(/community default is/)).toBeNull();
});

it("sends rules only after they differ, and resets back to the default", async () => {
  const { user, onCreated } = setup();
  await screen.findByText("Majority vote above 50%, quorum 20%");
  fireEvent.change(screen.getByLabelText("Voting (hours)"), { target: { value: "48" } });
  expect(screen.getByText("Voting: 2 days, community default is 5 days")).toBeTruthy();

  await user.type(screen.getByLabelText("Proposal title"), "Adopt a code of conduct");
  await user.click(screen.getByRole("button", { name: "Make proposal" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-1"));
  const body = vi.mocked(apiFetch).mock.calls.find((call) => call[0] === "/api/proposals")?.[1] as { body: { rules?: { votingHours: number } } };
  expect(body.body.rules).toEqual({ ...rulesFor(settings.decision), votingHours: 48 });

  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.queryByText(/community default is/)).toBeNull();
});

it("asks before discarding a rules change and follows a new kind until then", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { user, onClose } = setup({ isAdmin: true, ledWorkgroupIds: new Set() });
  await user.selectOptions(screen.getByLabelText("Proposal kind"), "task");
  expect(await screen.findByText("Lazy consensus, 1 objection rejects")).toBeTruthy();
  expect(screen.queryByText(/community default is/)).toBeNull();

  fireEvent.change(screen.getByLabelText("Voting (hours)"), { target: { value: "48" } });
  expect(screen.getByText("Voting: 2 days, community default is 3 days")).toBeTruthy();
  await user.selectOptions(screen.getByLabelText("Proposal kind"), "decision");
  expect(screen.getByText("Decided by: Lazy consensus, 1 objection rejects, community default is Majority vote above 50%, quorum 20%")).toBeTruthy();
  expect(screen.getByText("Voting: 2 days, community default is 5 days")).toBeTruthy();
  expect(screen.getByLabelText("Voting (hours)")).toHaveProperty("value", "48");

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm).toHaveBeenCalledWith("Discard this draft proposal?");
  expect(onClose).not.toHaveBeenCalled();
  confirm.mockRestore();
});

it("shows a member the task's community rules and does not send a change", async () => {
  const { user, onClose, onCreated } = setup();
  fireEvent.change(screen.getByLabelText("Voting (hours)"), { target: { value: "48" } });
  await user.selectOptions(screen.getByLabelText("Proposal kind"), "task");
  expect(await screen.findByText("Lazy consensus, 1 objection rejects")).toBeTruthy();
  expect(screen.queryByText("Adjust these rules")).toBeNull();
  expect(screen.queryByText(/community default is/)).toBeNull();

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();

  fireEvent.change(screen.getByLabelText("Reward 1 amount"), { target: { value: "10" } });
  await user.type(screen.getByLabelText("Task title"), "Write the guide");
  await user.click(screen.getByRole("button", { name: "Make proposal" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-1"));
  const body = vi.mocked(apiFetch).mock.calls.find((call) => call[0] === "/api/proposals")?.[1] as { body: { rules?: unknown } };
  expect(body.body.rules).toBeUndefined();
});

it("lets a lead of the board adjust that task's rules", async () => {
  const { user } = setup({ isAdmin: false, ledWorkgroupIds: new Set(["wg-1"]) });
  await user.selectOptions(screen.getByLabelText("Proposal kind"), "task");
  expect(await screen.findByText("Adjust these rules")).toBeTruthy();
});

it("counts voters for the electorate being edited", async () => {
  const { user } = setup();
  await user.selectOptions(screen.getByLabelText("Who votes"), "admins");
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/proposals/electorate", expect.objectContaining({
    query: expect.objectContaining({
      electorate: "admins", activityMonths: 12, minMemberDays: 0, recuseBeneficiaries: false,
    }),
  })));
  expect(await screen.findByText(/about 4 voters/)).toBeTruthy();
});

it("names the proposer as a beneficiary of a task assigned to them", async () => {
  const onClose = vi.fn();
  render(
    <NewProposalDialog communityId="c-1" kinds={["task"]} settings={settings} roles={member}
      workgroups={[{ id: "wg-1", name: "Design", kind: TaskSource.Native, treasury_id: null, archived_at: null }]}
      members={[]} sessionWallet="addr_me" onClose={onClose} onCreated={vi.fn()} />,
  );
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/proposals/electorate", expect.objectContaining({
    query: expect.objectContaining({ kind: "task", beneficiaries: "addr_me", recuseBeneficiaries: false }),
  })));
});

it("disables making a proposal nobody could vote on", async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ({ count: 0, eligible: 0 }));
  const { user, onCreated } = setup();
  await user.type(screen.getByLabelText("Proposal title"), "Adopt a code of conduct");
  expect((await screen.findByRole("status")).textContent).toMatch(/Nobody can vote/);
  expect((screen.getByRole("button", { name: "Make proposal" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onCreated).not.toHaveBeenCalled();
});

it("disables making a proposal whose voters would all be recused", async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ({ count: 2, eligible: 0 }));
  setup();
  expect((await screen.findByRole("status")).textContent).toMatch(/would be recused/);
  expect((screen.getByRole("button", { name: "Make proposal" }) as HTMLButtonElement).disabled).toBe(true);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BoardTask } from "@/lib/boardTypes";
import { TaskLifecycleDialog, type TaskLifecycleStatus } from "./TaskLifecycleDialog";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({ browserClient: () => ({ rpc }) }));
const task: BoardTask = {
  id: "task-1", number: 1, title: "Unwanted task", body: "Task details", source: "native", column_id: "todo",
  task_assignees: [], bounty_lovelace: null, amounts: null, pay_state: "none", archived_at: null,
  budget_month: null, paid_tx_hash: null, chain_number: null,
  gh_url: null, gh_status: null, gh_labels: null, gh_node_id: null,
  gh_repo_id: null, gh_issue_number: null,
};
const active: TaskLifecycleStatus = { archivedAt: null, canArchive: true, canDelete: false };
const archived: TaskLifecycleStatus = { archivedAt: "2026-09-11T00:00:00Z", canArchive: true, canDelete: true };
function setup(status = active) {
  rpc.mockResolvedValue({ data: status, error: null });
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<TaskLifecycleDialog task={task} onChanged={onChanged} onClose={onClose} />);
  return { user: userEvent.setup(), onChanged, onClose };
}
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("task removal", () => {
  it("offers reversible archive first and requires an explicit action", async () => {
    const { user, onChanged } = setup();
    const button = await screen.findByRole("button", { name: "Archive task" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    await user.click(button);
    expect(rpc).toHaveBeenLastCalledWith("change_task_lifecycle", {
      p_task_id: task.id, p_action: "archive", p_confirmation: "",
    });
    expect(onChanged).toHaveBeenCalledWith("archive");
  });
  it("blocks archiving tasks with pending payouts", async () => {
    const { user, onChanged } = setup({ ...active, canArchive: false });
    const button = await screen.findByRole("button", { name: "Archive task" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText(/Resolve the pending payout/)).toBeTruthy();
  });
  it("restores using current database state even when the board snapshot is stale", async () => {
    const { user, onChanged } = setup(archived);
    await user.click(await screen.findByRole("button", { name: "Restore task" }));
    expect(onChanged).toHaveBeenCalledWith("restore");
  });
  it("requires the exact title before irreversible deletion", async () => {
    const { user, onChanged } = setup(archived);
    await user.click(await screen.findByRole("button", { name: "Delete task…" }));
    const button = screen.getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
    const input = screen.getByLabelText("Type the task title to confirm deletion");
    await user.type(input, "wrong title");
    expect(button.disabled).toBe(true);
    await user.clear(input);
    await user.type(input, task.title);
    expect(button.disabled).toBe(false);
    await user.click(button);
    expect(rpc).toHaveBeenLastCalledWith("change_task_lifecycle", {
      p_task_id: task.id, p_action: "delete", p_confirmation: task.title,
    });
    expect(onChanged).toHaveBeenCalledWith("delete");
  });
  it("keeps payment history out of permanent deletion", async () => {
    setup({ ...archived, canDelete: false });
    await screen.findByRole("button", { name: "Restore task" });
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByText(/payment history and cannot/)).toBeTruthy();
  });
  it("keeps the dialog open and refreshes eligibility after a rejected operation", async () => {
    const { user, onChanged, onClose } = setup();
    await screen.findByRole("button", { name: "Archive task" });
    rpc.mockResolvedValueOnce({ error: { message: "Payout started elsewhere" } })
      .mockResolvedValueOnce({ data: { ...active, canArchive: false }, error: null });
    await user.click(screen.getByRole("button", { name: "Archive task" }));
    expect(await screen.findByText("Payout started elsewhere")).toBeTruthy();
    await screen.findByText(/Resolve the pending payout/);
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

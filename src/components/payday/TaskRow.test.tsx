// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PayableTask } from "@/lib/payday/types";
import { TaskRow } from "./TaskRow";

function task(over: Partial<PayableTask> = {}): PayableTask {
  return {
    id: "task-1", number: 7, title: "Ship it", body: null, source: "native", column_id: null,
    task_assignees: [
      { id: "a1", source: "manual", gh_login: null, gh_user_id: null, wallet_address: "addr1alice", position: 0, contributors: null },
    ],
    bounty_lovelace: null, amounts: { ADA: "10" }, pay_state: "payable", archived_at: null,
    budget_month: null, paid_tx_hash: null, chain_number: null,
    gh_url: null, gh_status: null, gh_labels: null, gh_node_id: null, gh_repo_id: null, gh_issue_number: null,
    workgroup_id: "wg1", workgroup: { name: "Core", treasury_id: null },
    ...over,
  };
}

afterEach(cleanup);

describe("TaskRow", () => {
  it("shows the task number and no Edit button without onEdit", () => {
    render(<TaskRow task={task()} selected={false} lockedByName={null} onToggle={() => {}} />);
    expect(screen.getByText("#7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit task/ })).toBeNull();
  });

  it("opens the editor without toggling the checkbox", async () => {
    const onEdit = vi.fn();
    const onToggle = vi.fn();
    render(
      <TaskRow task={task()} selected={false} lockedByName={null} onToggle={onToggle} onEdit={onEdit} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit task: Ship it" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("offers Edit on a blocked row too", () => {
    const onEdit = vi.fn();
    render(
      <TaskRow task={task({ task_assignees: [] })} selected={false} lockedByName={null} onToggle={() => {}} onEdit={onEdit} />,
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    const edit = screen.getByRole("button", { name: "Edit task: Ship it" });
    // Highlighted (primary) on a blocked row, quiet (secondary) on a ready one.
    expect(edit.className).toContain("app-button-primary");
    expect(edit.className).not.toContain("opacity-60");
  });

  it("keeps the Edit button quiet on a ready row", () => {
    render(
      <TaskRow task={task()} selected={false} lockedByName={null} onToggle={() => {}} onEdit={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Edit task: Ship it" }).className).toContain("app-button-secondary");
  });
});

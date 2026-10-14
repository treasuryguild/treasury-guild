// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BoardTask, MemberOption } from "@/lib/boardTypes";
import type { Network } from "@/lib/config";
import { TaskModal } from "./TaskModal";

const members: MemberOption[] = [
  { wallet: "addr1alice", handle: "alice", githubUsername: "alice" },
  { wallet: "addr1bob", handle: null, githubUsername: "bobby" },
];

function task(over: Partial<BoardTask>): BoardTask {
  return {
    id: "task-1", number: 1, title: "Ship it", body: null, source: "native", column_id: null,
    task_assignees: [], bounty_lovelace: null, amounts: null, pay_state: "none", archived_at: null,
    budget_month: "2026-09-01", paid_tx_hash: null, chain_number: null,
    gh_url: null, gh_status: null, gh_labels: null, gh_node_id: null, gh_repo_id: null, gh_issue_number: null,
    ...over,
  };
}

function setup(t: BoardTask, budgetSetups: { starts_on: string; cadence: "monthly" | "quarterly" }[] = []) {
  const onSave = vi.fn();
  render(
    <TaskModal task={t} members={members} tokenTickers={[]} network={0 as Network} budgetSetups={budgetSetups} onClose={() => {}} onSave={onSave} />,
  );
  return { user: userEvent.setup(), onSave };
}

afterEach(cleanup);

describe("TaskModal assignees", () => {
  it("edits wallets of GitHub assignees and keeps extra manual assignees", async () => {
    const { user, onSave } = setup(
      task({
        source: "github",
        task_assignees: [
          { id: "ga", source: "github", gh_login: "carol", wallet_address: null, position: 0, contributors: null },
          { id: "ma", source: "manual", gh_login: null, wallet_address: "addr1bob", position: 1, contributors: null },
        ],
      }),
    );
    expect(screen.getByText("@carol")).toBeTruthy();
    const carol = screen.getByLabelText("Wallet for @carol") as HTMLSelectElement;
    expect(carol.value).toBe("");
    // GitHub rows cannot be removed here; the manual one can.
    expect(screen.getAllByRole("button", { name: "Remove assignee" })).toHaveLength(1);

    await user.selectOptions(carol, "addr1alice");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      assignees: [
        { source: "github", id: "ga", wallet: "addr1alice" },
        { source: "manual", wallet: "addr1bob" },
      ],
      budget_month: "2026-09-01",
    });
  });

  it("adds several manual assignees, including a custom address, on native tasks", async () => {
    const { user, onSave } = setup(task({}));
    // An unassigned native task opens with one empty assignee row and no
    // bounty rows, so an assignee-only save passes validation.
    expect(screen.getAllByLabelText("Assignee")).toHaveLength(1);
    expect(screen.getByText("No bounty yet")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "+ Add assignee" }));
    const [first, second] = screen.getAllByLabelText("Assignee");
    await user.selectOptions(first!, "addr1alice");
    await user.selectOptions(second!, "__custom");
    await user.type(screen.getByLabelText("Custom address"), "addr1custom");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        assignees: [
          { source: "manual", wallet: "addr1alice" },
          { source: "manual", wallet: "addr1custom" },
        ],
        amounts: null,
        bounty_lovelace: null,
      }),
    );
  });

  it("drops empty rows and refuses the same wallet twice", async () => {
    const { user, onSave } = setup(task({}));
    await user.click(screen.getByRole("button", { name: "+ Add assignee" }));
    await user.click(screen.getByRole("button", { name: "+ Add assignee" }));
    const rows = screen.getAllByLabelText("Assignee");
    await user.selectOptions(rows[0]!, "addr1alice");
    await user.selectOptions(rows[2]!, "addr1alice");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Each wallet can be assigned once")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    await user.selectOptions(rows[2]!, "addr1bob");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        assignees: [
          { source: "manual", wallet: "addr1alice" },
          { source: "manual", wallet: "addr1bob" },
        ],
      }),
    );
  });
});

describe("TaskModal budget period", () => {
  it("asks for a quarter in quarterly-budgeted workgroups and stores its first month", async () => {
    const { user, onSave } = setup(
      task({ budget_month: "2026-05-01" }),
      [{ starts_on: "2026-01-01", cadence: "quarterly" }],
    );
    const quarter = screen.getByLabelText("Budget quarter") as HTMLSelectElement;
    expect(quarter.value).toBe("04");
    expect(screen.queryByLabelText("Budget month")).toBeNull();

    await user.selectOptions(quarter, "07");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ budget_month: "2026-07-01" }));
  });

  it("keeps the month input for monthly workgroups and months before a quarterly setup", () => {
    setup(task({ budget_month: "2026-05-01" }), [{ starts_on: "2026-01-01", cadence: "monthly" }]);
    expect((screen.getByLabelText("Budget month") as HTMLInputElement).value).toBe("2026-05");
    expect(screen.queryByLabelText("Budget quarter")).toBeNull();
    cleanup();
    setup(task({ budget_month: "2026-05-01" }), [{ starts_on: "2026-07-01", cadence: "quarterly" }]);
    expect(screen.getByLabelText("Budget month")).toBeTruthy();
  });
});

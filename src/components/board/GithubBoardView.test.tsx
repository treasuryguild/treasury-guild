// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BoardTask, LiveProjectBoard } from "@/lib/boardTypes";
import { GithubBoardView } from "./GithubBoardView";

function task(over: Partial<BoardTask>): BoardTask {
  return {
    id: "task-1", number: 1, title: "Ship it", body: null, source: "native", column_id: null,
    task_assignees: [], bounty_lovelace: null, amounts: null, pay_state: "none", archived_at: null,
    budget_month: "2026-09-01", paid_tx_hash: null, chain_number: null,
    gh_url: null, gh_status: null, gh_labels: null, gh_node_id: null, gh_repo_id: null, gh_issue_number: null,
    ...over,
  };
}

const githubTask = task({
  id: "gh", number: 7, title: "Fix the login bug", source: "github", pay_state: "payable",
  gh_node_id: "I_7", gh_status: "In review",
});
const callTask = task({ id: "call", number: 8, title: "Call: Standup, 2026-09-01", pay_state: "payable" });

const board: LiveProjectBoard = {
  projectId: "P_1", title: "Roadmap", url: "https://github.com/orgs/x/projects/1",
  statusOptions: ["Todo", "In review"],
  items: [{
    itemNodeId: "PVTI_7", kind: "issue", contentNodeId: "I_7", number: 7, title: "Fix the login bug",
    url: null, state: "OPEN", status: "In review", numbers: {}, labels: [], assigneeLogins: [],
    repoId: 1, repoFullName: "x/repo",
  }],
  truncated: false,
};

function renderView(over: Partial<Parameters<typeof GithubBoardView>[0]> = {}) {
  render(
    <GithubBoardView boards={[board]} hasRepos partial={false} error={null} tasks={[githubTask, callTask]}
      canManage={false} isAdmin={false} settingsHref="/c/x/settings/github" onEdit={() => {}} {...over} />,
  );
}

afterEach(cleanup);

describe("GithubBoardView", () => {
  it("lists native tasks under Created in Treasury Guild, GitHub tasks in their live column", () => {
    renderView();
    const section = screen.getByRole("region", { name: "Created in Treasury Guild" });
    expect(within(section).getByText("Call: Standup, 2026-09-01")).toBeTruthy();
    expect(within(section).queryByText("Fix the login bug")).toBeNull();
    expect(screen.getAllByText("Fix the login bug")).toHaveLength(1);
  });

  it("keeps native tasks out of the fallback status columns", () => {
    renderView({ boards: null, error: "GitHub is down" });
    const section = screen.getByRole("region", { name: "Created in Treasury Guild" });
    expect(within(section).getByText("Call: Standup, 2026-09-01")).toBeTruthy();
    expect(screen.queryByText("No status")).toBeNull();
  });

  it("shows native tasks even before a repository is linked", () => {
    renderView({ boards: [], hasRepos: false });
    expect(screen.getByText(/no repository is linked yet/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Created in Treasury Guild" })).toBeTruthy();
  });

  it("has no section when every task comes from GitHub", () => {
    renderView({ tasks: [githubTask] });
    expect(screen.queryByRole("region", { name: "Created in Treasury Guild" })).toBeNull();
  });

  it("moves a dragged card at once, and returns it when the GitHub move fails", async () => {
    let finish: (ok: boolean) => void = () => {};
    const onMoveTaskStatus = vi.fn(
      () => new Promise<boolean>((resolve) => { finish = resolve; }),
    );
    renderView({ canManage: true, tasks: [githubTask], onMoveTaskStatus });
    const columnOf = (name: string) =>
      screen.getByRole("heading", { name }).closest(".glass-panel") as HTMLElement;
    const card = screen.getByText("Fix the login bug").closest("[draggable]") as HTMLElement;

    fireEvent.dragStart(card);
    fireEvent.drop(columnOf("Todo"));

    // Optimistic: the card is already in Todo with a saving note, and the
    // move was asked for — GitHub has not answered yet.
    expect(onMoveTaskStatus).toHaveBeenCalledWith(githubTask, "Todo");
    expect(within(columnOf("Todo")).getByText("Fix the login bug")).toBeTruthy();
    expect(within(columnOf("Todo")).getByText("Saving to GitHub…")).toBeTruthy();

    finish(false);
    await waitFor(() => {
      expect(within(columnOf("In review")).getByText("Fix the login bug")).toBeTruthy();
    });
    expect(screen.queryByText("Saving to GitHub…")).toBeNull();
  });

  it("offers Add issue… when managing, and calls onAdd with the column Status and repo", async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    renderView({
      canManage: true,
      tasks: [githubTask],
      repos: [{ id: 5, fullName: "x/repo" }],
      onAdd,
    });
    const columnOf = (name: string) =>
      screen.getByRole("heading", { name }).closest(".glass-panel") as HTMLElement;
    const todo = columnOf("Todo");
    expect(within(todo).queryByRole("combobox")).toBeNull();
    const input = within(todo).getByPlaceholderText("Add issue…");
    fireEvent.change(input, { target: { value: "New bug" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith("P_1", "Todo", "New bug", 5);
    });
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("");
    });
  });

  it("shows a repository picker only when more than one repo is linked", async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    renderView({
      canManage: true,
      tasks: [githubTask],
      repos: [
        { id: 5, fullName: "x/repo" },
        { id: 6, fullName: "x/docs" },
      ],
      onAdd,
    });
    const columnOf = (name: string) =>
      screen.getByRole("heading", { name }).closest(".glass-panel") as HTMLElement;
    const todo = columnOf("Todo");
    const select = within(todo).getByRole("combobox");
    fireEvent.change(select, { target: { value: "6" } });
    const input = within(todo).getByPlaceholderText("Add issue…");
    fireEvent.change(input, { target: { value: "Docs fix" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith("P_1", "Todo", "Docs fix", 6);
    });
  });

  it("hides Add issue… when the viewer cannot manage", () => {
    renderView({
      canManage: false,
      tasks: [githubTask],
      repos: [{ id: 5, fullName: "x/repo" }],
      onAdd: vi.fn(),
    });
    expect(screen.queryByPlaceholderText("Add issue…")).toBeNull();
  });
});

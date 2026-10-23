// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MergedBoardItem } from "@/lib/boardTypes";
import { GithubItemModal } from "./GithubItemModal";

vi.mock("@/hooks/useGithubEditorOptions", () => ({
  useGithubEditorOptions: () => ({
    data: {
      assignableLogins: ["alice", "bob"],
      numberFieldNames: ["ADA", "SIGN"],
    },
    loading: false,
    error: null,
    reload: () => {},
    setData: () => {},
  }),
}));

const WG = "20000000-0000-4000-8000-000000000001";

function item(over: Partial<MergedBoardItem> = {}): MergedBoardItem {
  return {
    itemNodeId: "PVTI_1",
    title: "Loose issue",
    url: "https://github.com/guild/app/issues/9",
    number: 9,
    draft: false,
    isPullRequest: false,
    assigneeLogins: ["alice"],
    labels: ["audited"],
    state: "OPEN",
    amounts: { ADA: 10 },
    task: null,
    ...over,
  };
}

afterEach(cleanup);

describe("GithubItemModal", () => {
  it("sends assignees and a new bounty field to GitHub", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <GithubItemModal
        item={item()}
        workgroupId={WG}
        status="Todo"
        statusOptions={["Todo", "Done"]}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Add GitHub assignee"), "bob");
    await user.selectOptions(screen.getByLabelText("Add bounty field"), "SIGN");
    await user.type(screen.getByLabelText("Amount for SIGN"), "3");
    await user.click(screen.getByRole("button", { name: "Save to GitHub" }));
    expect(onSave).toHaveBeenCalledWith({
      assignees: ["alice", "bob"],
      amounts: { ADA: "10", SIGN: "3" },
    });
  });
});

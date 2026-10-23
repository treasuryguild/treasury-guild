import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ octokit: vi.fn() }));
vi.mock("./app", () => ({ installationOctokit: mocks.octokit }));
import { addProjectItemByContentId } from "./projectsV2";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("addProjectItemByContentId", () => {
  it("adds the content to the project and moves it to the named Status", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({
        addProjectV2ItemById: { item: { id: "PVTI_new" } },
      })
      .mockResolvedValueOnce({
        node: {
          id: "PVTI_new",
          project: {
            id: "PVT_1",
            field: { id: "F_status", options: [{ id: "O_todo", name: "Todo" }] },
          },
          fieldValueByName: null,
        },
      })
      .mockResolvedValueOnce({ projectV2Item: { id: "PVTI_new" } });
    mocks.octokit.mockResolvedValue({ graphql });

    await expect(addProjectItemByContentId(99, "PVT_1", "I_42", "Todo")).resolves.toEqual({
      outcome: "added",
      itemNodeId: "PVTI_new",
      status: "Todo",
    });
    expect(graphql.mock.calls[0]?.[1]).toEqual({ projectId: "PVT_1", contentId: "I_42" });
    expect(graphql.mock.calls[2]?.[1]).toMatchObject({
      projectId: "PVT_1",
      itemId: "PVTI_new",
      fieldId: "F_status",
      optionId: "O_todo",
    });
  });

  it("reports no_option when the project has no such Status column", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({
        addProjectV2ItemById: { item: { id: "PVTI_new" } },
      })
      .mockResolvedValueOnce({
        node: {
          id: "PVTI_new",
          project: {
            id: "PVT_1",
            field: { id: "F_status", options: [{ id: "O_todo", name: "Todo" }] },
          },
          fieldValueByName: null,
        },
      });
    mocks.octokit.mockResolvedValue({ graphql });

    await expect(addProjectItemByContentId(99, "PVT_1", "I_42", "Missing")).resolves.toEqual({
      outcome: "no_option",
    });
  });

  it("throws when GitHub returns no item id", async () => {
    mocks.octokit.mockResolvedValue({
      graphql: vi.fn().mockResolvedValue({ addProjectV2ItemById: { item: null } }),
    });
    await expect(addProjectItemByContentId(99, "PVT_1", "I_42", "Todo")).rejects.toThrow(
      /no item id/,
    );
  });
});

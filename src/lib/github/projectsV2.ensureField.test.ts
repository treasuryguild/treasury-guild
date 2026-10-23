import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ octokit: vi.fn() }));
vi.mock("./app", () => ({ installationOctokit: mocks.octokit }));
import { ensureProjectNumberField } from "./projectsV2";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ensureProjectNumberField", () => {
  it("reuses an existing NUMBER field case-insensitively", async () => {
    const graphql = vi.fn().mockResolvedValueOnce({
      node: {
        id: "PVT_1",
        fields: {
          nodes: [
            { id: "F1", name: "Hosky", dataType: "NUMBER" },
            { id: "F2", name: "Status", dataType: "SINGLE_SELECT" },
          ],
        },
      },
    });
    mocks.octokit.mockResolvedValue({ graphql });

    await expect(ensureProjectNumberField(99, "PVT_1", "HOSKY")).resolves.toEqual({
      fieldName: "Hosky",
      created: false,
    });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("creates a NUMBER field when none matches", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({
        node: {
          id: "PVT_1",
          fields: { nodes: [{ id: "F2", name: "Status", dataType: "SINGLE_SELECT" }] },
        },
      })
      .mockResolvedValueOnce({
        createProjectV2Field: {
          projectV2Field: { id: "F_new", name: "HOSKY", dataType: "NUMBER" },
        },
      });
    mocks.octokit.mockResolvedValue({ graphql });

    await expect(ensureProjectNumberField(99, "PVT_1", "HOSKY")).resolves.toEqual({
      fieldName: "HOSKY",
      created: true,
    });
    expect(graphql.mock.calls[1]?.[1]).toEqual({ projectId: "PVT_1", name: "HOSKY" });
  });

  it("throws when the project node is missing", async () => {
    mocks.octokit.mockResolvedValue({
      graphql: vi.fn().mockResolvedValue({ node: null }),
    });
    await expect(ensureProjectNumberField(99, "PVT_missing", "ADA")).rejects.toThrow(
      /project not found/,
    );
  });
});

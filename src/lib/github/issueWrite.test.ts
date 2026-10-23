import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  octokit: vi.fn(),
  setStatus: vi.fn(),
  setNumbers: vi.fn(),
}));
vi.mock("./app", () => ({ installationOctokit: mocks.octokit }));
vi.mock("./projectsV2", () => ({
  setProjectItemStatus: mocks.setStatus,
  setProjectItemNumberFields: mocks.setNumbers,
}));
import { createGithubIssue, updateGithubIssue } from "./issueWrite";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createGithubIssue", () => {
  it("opens an issue and returns its number, node id and url", async () => {
    const create = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        node_id: "I_42",
        html_url: "https://github.com/guild/app/issues/42",
        title: "Ship it",
      },
    });
    mocks.octokit.mockResolvedValue({ rest: { issues: { create } } });

    await expect(createGithubIssue({
      installationId: 99,
      repoFullName: "guild/app",
      title: "Ship it",
    })).resolves.toEqual({
      number: 42,
      nodeId: "I_42",
      htmlUrl: "https://github.com/guild/app/issues/42",
      title: "Ship it",
    });
    expect(create).toHaveBeenCalledWith({ owner: "guild", repo: "app", title: "Ship it" });
  });

  it("maps GitHub failures to UpstreamError", async () => {
    mocks.octokit.mockResolvedValue({
      rest: { issues: { create: vi.fn().mockRejectedValue(new Error("forbidden")) } },
    });
    await expect(createGithubIssue({
      installationId: 99,
      repoFullName: "guild/app",
      title: "Ship it",
    })).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("updateGithubIssue", () => {
  it("pushes a title edit through REST", async () => {
    const update = vi.fn().mockResolvedValue({});
    mocks.octokit.mockResolvedValue({ rest: { issues: { update } } });
    await expect(updateGithubIssue({
      installationId: 99,
      repoFullName: "guild/app",
      issueNumber: 7,
      edit: { title: "New title" },
    })).resolves.toEqual({ movedToStatus: null, missingAmountFields: [] });
    expect(update).toHaveBeenCalledWith({
      owner: "guild", repo: "app", issue_number: 7, title: "New title",
    });
  });
});

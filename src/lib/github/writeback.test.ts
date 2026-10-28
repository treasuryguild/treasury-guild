import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  octokit: vi.fn(),
  setStatus: vi.fn(),
}));
vi.mock("./app", () => ({ installationOctokit: mocks.octokit }));
vi.mock("./projectsV2", () => ({ setProjectItemStatus: mocks.setStatus }));

import { writeBackPayment } from "./writeback";

const TX = "abcdef0123456789" + "0".repeat(48);
const BASE = {
  installationId: 99,
  repoFullName: "guild/app",
  issueNumber: 42,
  amounts: [{ ticker: "ADA", decimals: 6, quantity: 1_500_000n }],
  recipientLabels: ["alice"],
  txHash: TX,
  network: 0 as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("writeBackPayment", () => {
  it("posts a comment with the amounts, recipients and explorer link", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const addLabels = vi.fn().mockResolvedValue({});
    mocks.octokit.mockResolvedValue({ rest: { issues: { createComment, addLabels } } });

    await expect(writeBackPayment(BASE)).resolves.toEqual({ movedToStatus: null });
    expect(createComment).toHaveBeenCalledExactlyOnceWith({
      owner: "guild",
      repo: "app",
      issue_number: 42,
      body: expect.stringMatching(
        /Paid \*\*1\.5 ADA\*\* to `alice` in tx \[`abcdef0123456789…`\]\(https:\/\/preprod\.cexplorer\.io\/tx\//,
      ),
    });
    expect(addLabels).toHaveBeenCalledExactlyOnceWith({
      owner: "guild", repo: "app", issue_number: 42, labels: ["paid"],
    });
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it("says each when more than one recipient was paid", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    mocks.octokit.mockResolvedValue({
      rest: { issues: { createComment, addLabels: vi.fn().mockResolvedValue({}) } },
    });
    await writeBackPayment({
      ...BASE,
      amounts: [
        { ticker: "ADA", decimals: 6, quantity: 10_000_000n },
        { ticker: "GVT", decimals: 0, quantity: 5n },
      ],
      recipientLabels: ["alice", "bob"],
    });
    expect(createComment.mock.calls[0]![0].body).toContain("**10 ADA + 5 GVT** each to `alice`, `bob`");
  });

  it("keeps going when the paid label cannot be added", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    mocks.octokit.mockResolvedValue({
      rest: {
        issues: {
          createComment,
          addLabels: vi.fn().mockRejectedValue(new Error("forbidden")),
        },
      },
    });
    await expect(writeBackPayment(BASE)).resolves.toEqual({ movedToStatus: null });
    expect(createComment).toHaveBeenCalledOnce();
  });

  it("reports a successful status move and swallows a failed one", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    mocks.octokit.mockResolvedValue({
      rest: { issues: { createComment, addLabels: vi.fn().mockResolvedValue({}) } },
    });
    mocks.setStatus.mockResolvedValue({ outcome: "updated", status: "Paid" });
    await expect(writeBackPayment({
      ...BASE,
      projectItem: { itemNodeId: "PVTI_1", status: "Paid" },
    })).resolves.toEqual({ movedToStatus: "Paid" });
    expect(mocks.setStatus).toHaveBeenCalledExactlyOnceWith(99, "PVTI_1", "Paid");

    mocks.setStatus.mockRejectedValue(new Error("no projects permission"));
    await expect(writeBackPayment({
      ...BASE,
      projectItem: { itemNodeId: "PVTI_1", status: "Paid" },
    })).resolves.toEqual({ movedToStatus: null });
    expect(createComment).toHaveBeenCalledTimes(2);
  });

  it("lets a comment failure through so the sweep retries without a second comment", async () => {
    mocks.octokit.mockResolvedValue({
      rest: { issues: { createComment: vi.fn().mockRejectedValue(new Error("GitHub down")) } },
    });
    await expect(writeBackPayment(BASE)).rejects.toThrow("GitHub down");
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteInstallation: vi.fn(), workgroupIds: vi.fn(), hasRepos: vi.fn(),
  isActive: vi.fn(), setKind: vi.fn(),
}));
vi.mock("@/lib/db/github", () => ({
  deleteInstallation: mocks.deleteInstallation,
  loadInstallationWorkgroupIds: mocks.workgroupIds,
  workgroupHasRepos: mocks.hasRepos,
}));
vi.mock("@/lib/db/workgroups", () => ({
  setWorkgroupKind: mocks.setKind,
  workgroupIsActive: mocks.isActive,
}));
import { removeInstallation } from "./disconnect";

const ACTIVE = "20000000-0000-4000-8000-000000000001";
const ARCHIVED = "20000000-0000-4000-8000-000000000002";
const STILL_LINKED = "20000000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workgroupIds.mockResolvedValue([ACTIVE, ARCHIVED, STILL_LINKED]);
  mocks.isActive.mockImplementation(async (id: string) => id !== ARCHIVED);
  mocks.hasRepos.mockImplementation(async (id: string) => id === STILL_LINKED);
});

describe("removeInstallation", () => {
  it("collects workgroups before deleting, then makes emptied active ones native", async () => {
    await removeInstallation(99);
    expect(mocks.workgroupIds).toHaveBeenCalledWith(99);
    expect(mocks.deleteInstallation).toHaveBeenCalledWith(99);
    expect(mocks.workgroupIds.mock.invocationCallOrder[0]!).toBeLessThan(mocks.deleteInstallation.mock.invocationCallOrder[0]!);
    expect(mocks.setKind).toHaveBeenCalledTimes(1);
    expect(mocks.setKind).toHaveBeenCalledWith(ACTIVE, "native");
  });

  it("leaves an archived workgroup and one that still has repos alone", async () => {
    await removeInstallation(99);
    expect(mocks.setKind).not.toHaveBeenCalledWith(ARCHIVED, expect.anything());
    expect(mocks.setKind).not.toHaveBeenCalledWith(STILL_LINKED, expect.anything());
  });

  it("still deletes when the installation fed no workgroup", async () => {
    mocks.workgroupIds.mockResolvedValue([]);
    await removeInstallation(99);
    expect(mocks.deleteInstallation).toHaveBeenCalledWith(99);
    expect(mocks.setKind).not.toHaveBeenCalled();
  });
});

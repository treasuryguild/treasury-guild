// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiFetch } from "@/lib/api/client";
import type * as ApiClientModule from "@/lib/api/client";
import type { WorkgroupLifecycleStatus } from "@/lib/api/types";
import { WorkgroupLifecycleDialog } from "./WorkgroupLifecycleDialog";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...await importOriginal<typeof ApiClientModule>(), apiFetch: vi.fn(),
}));
const group = { id: "group-1", name: "Design", kind: "native", description: null, treasury_id: null, archived_at: null };
const active: WorkgroupLifecycleStatus = { archivedAt: null, outstandingTasks: 0, pendingPayouts: 0, canDelete: true };

function setup(status: WorkgroupLifecycleStatus = active) {
  vi.mocked(apiFetch).mockResolvedValue(status);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<WorkgroupLifecycleDialog workgroup={group} slug="guild" onChanged={onChanged} onClose={onClose} />);
  return { user: userEvent.setup(), onChanged, onClose };
}
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("workgroup lifecycle confirmation", () => {
  it("explains blockers and disables archive and deletion for used workgroups", async () => {
    const { user, onChanged } = setup({ ...active, outstandingTasks: 2, pendingPayouts: 1, canDelete: false });
    const archive = await screen.findByRole("button", { name: "Archive workgroup" });
    expect((archive as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Resolve 2 payable or queued/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete empty workgroup" })).toBeNull();
    await user.click(archive);
    expect(onChanged).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("archives only after confirmation and reports completion", async () => {
    const { user, onChanged } = setup();
    await screen.findByRole("button", { name: "Archive workgroup" });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true });
    await user.click(screen.getByRole("button", { name: "Archive workgroup" }));
    expect(apiFetch).toHaveBeenLastCalledWith("/api/workgroups/lifecycle", {
      body: { workgroupId: group.id, action: "archive", confirmation: "" },
    });
    expect(onChanged).toHaveBeenCalledWith("archive");
  });

  it("requires the exact name before permanently deleting an empty group", async () => {
    const { user, onChanged } = setup();
    await user.click(await screen.findByRole("button", { name: "Delete empty workgroup" }));
    const button = screen.getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
    const input = screen.getByLabelText("Type Design to confirm deletion");
    await user.type(input, "design");
    expect(button.disabled).toBe(true);
    await user.clear(input);
    await user.type(input, "Design");
    expect(button.disabled).toBe(false);
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true });
    await user.click(button);
    expect(onChanged).toHaveBeenCalledWith("delete");
  });

  it("offers restoration based on current server state", async () => {
    const { user, onChanged } = setup({ ...active, archivedAt: "2026-09-09T00:00:00Z", canDelete: false });
    await user.click(await screen.findByRole("button", { name: "Restore workgroup" }));
    expect(onChanged).toHaveBeenCalledWith("restore");
    expect(screen.queryByRole("button", { name: "Archive workgroup" })).toBeNull();
  });

  it("keeps the dialog open and refreshes blockers when a concurrent change rejects archive", async () => {
    const { user, onChanged, onClose } = setup();
    await screen.findByRole("button", { name: "Archive workgroup" });
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("Resolve payable tasks before archiving"))
      .mockResolvedValueOnce({ ...active, outstandingTasks: 1, canDelete: false });
    await user.click(screen.getByRole("button", { name: "Archive workgroup" }));
    expect(await screen.findByText("Resolve payable tasks before archiving")).toBeTruthy();
    await screen.findByText(/Resolve 1 payable or queued/);
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Archive workgroup" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

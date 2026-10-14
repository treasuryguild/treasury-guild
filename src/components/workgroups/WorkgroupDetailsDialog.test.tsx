// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as ApiClient from "@/lib/api/client";
import { WorkgroupDetailsDialog } from "./WorkgroupDetailsDialog";

const db = vi.hoisted(() => ({ from: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn() }));
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({ browserClient: () => db }));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()), apiFetch: api.fetch,
}));
vi.mock("@/hooks/useTreasuries", () => ({ useTreasuries: () => ({
  data: [{ id: "wallet-1", name: "Project treasury" }, { id: "wallet-2", name: "Dev wallet" }], loading: false, error: null,
}) }));

const workgroup = { id: "group-1", name: "Design", description: "Existing purpose", kind: "native", treasury_id: "wallet-1", archived_at: null };
const routing = {
  treasuryId: "wallet-1", cadence: "monthly", currentStart: "2026-09-01", nextStart: "2026-10-01", currentBlocked: false,
  history: [{ id: "a1", treasuryId: "wallet-1", startsOn: "1000-01-01", reason: null, createdBy: "migration", createdAt: "2026-09-01T00:00:00Z" }],
};
function setup() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<WorkgroupDetailsDialog workgroup={workgroup} communityId="community-1" slug="guild" onSaved={onSaved} onClose={onClose} onLifecycleChanged={vi.fn()} />);
  return { user: userEvent.setup(), onSaved, onClose };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [db.from, db.update, db.eq, db.select]) method.mockReturnValue(db);
  db.single.mockResolvedValue({ data: workgroup, error: null });
  api.fetch.mockImplementation(async (_path: string, init?: { body?: unknown }) =>
    init?.body ? { startsOn: "2026-10-01" } : routing);
});
afterEach(cleanup);

describe("workgroup details", () => {
  it("saves edited details without touching the wallet column", async () => {
    const { user, onSaved } = setup();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Design");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "  Product design  ");
    await user.clear(screen.getByLabelText("Description"));
    const updated = { ...workgroup, name: "Product design", description: null };
    db.single.mockResolvedValue({ data: updated, error: null });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(db.update).toHaveBeenCalledWith({ name: "Product design", description: null });
    expect(db.eq).toHaveBeenCalledWith("id", "group-1");
    expect(db.eq).toHaveBeenCalledWith("community_id", "community-1");
    expect(onSaved).toHaveBeenCalledWith(updated);
  });

  it("changes the wallet through the routing API for the chosen period", async () => {
    const { user, onSaved } = setup();
    await waitFor(() => expect(screen.getByText(/in Sep 2026/)).toBeTruthy());
    await user.selectOptions(screen.getByLabelText("Payment wallet"), "wallet-2");
    await user.click(screen.getByLabelText(/This period/));
    await user.type(screen.getByLabelText("Reason"), "Own wallet now");
    await user.click(screen.getByRole("button", { name: "Change wallet" }));
    expect(api.fetch).toHaveBeenCalledWith("/api/workgroups/routing", {
      body: { workgroupId: "group-1", treasuryId: "wallet-2", effective: "current", reason: "Own wallet now" },
    });
    expect(onSaved).toHaveBeenCalledWith({ ...workgroup, treasury_id: "wallet-2" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("only offers the next period once the current one has payouts", async () => {
    api.fetch.mockImplementation(async (_path: string, init?: { body?: unknown }) =>
      init?.body ? { startsOn: "2026-10-01" } : { ...routing, currentBlocked: true });
    const { user, onSaved } = setup();
    await waitFor(() => expect((screen.getByLabelText(/This period/) as HTMLInputElement).disabled).toBe(true));
    expect(screen.getByText(/Already has payouts/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Payment wallet"), "");
    await user.click(screen.getByRole("button", { name: "Change wallet" }));
    expect(api.fetch).toHaveBeenCalledWith("/api/workgroups/routing", {
      body: { workgroupId: "group-1", treasuryId: null, effective: "next", reason: undefined },
    });
    // Nothing changes on the row until the period starts.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps edits after a rejected save and allows retry", async () => {
    db.single.mockResolvedValueOnce({ data: null, error: { message: "Permission denied" } });
    const { user, onSaved, onClose } = setup();
    await user.type(screen.getByLabelText("Description"), " updated");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Permission denied")).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Existing purpose updated");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("rejects whitespace-only names and cancels without writing", async () => {
    const { user, onClose } = setup();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "   ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Enter a workgroup or project name.")).toBeTruthy();
    expect(db.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not report success when no updated row is returned", async () => {
    db.single.mockResolvedValue({ data: null, error: null });
    const { user, onSaved } = setup();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText(/could not be updated/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

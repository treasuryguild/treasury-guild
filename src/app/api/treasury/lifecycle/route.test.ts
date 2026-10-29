import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  status: vi.fn(),
  change: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireTreasuryAdmin: mocks.admin }));
vi.mock("@/lib/db/treasuries", () => ({
  loadTreasuryLifecycleStatus: mocks.status,
  changeTreasuryLifecycle: mocks.change,
}));

import { GET, POST } from "./route";

const id = "40000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/treasury/lifecycle", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.admin.mockResolvedValue({ id, community_id: "community" });
  mocks.status.mockResolvedValue({ archivedAt: null, blockers: [] });
});

describe("treasury lifecycle API", () => {
  it("denies non-admins before reading or changing the treasury", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await POST(request({ treasuryId: id, action: "archive" }), context)).status).toBe(403);
    expect(mocks.change).not.toHaveBeenCalled();
    expect((await GET(new Request(`http://localhost/api/treasury/lifecycle?treasuryId=${id}`), context)).status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("archives as the signed-in wallet", async () => {
    const result = await POST(request({ treasuryId: id, action: "archive", actor: "someone" }), context);
    expect(result.status).toBe(200);
    expect(mocks.change).toHaveBeenCalledWith({ treasuryId: id, action: "archive", actor: "admin" });
  });

  it("returns the blockers the dialog shows", async () => {
    mocks.status.mockResolvedValue({ archivedAt: null, blockers: ["Set another treasury as primary first"] });
    const result = await GET(new Request(`http://localhost/api/treasury/lifecycle?treasuryId=${id}`), context);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ archivedAt: null, blockers: ["Set another treasury as primary first"] });
  });

  it("rejects an unknown action without mutating", async () => {
    expect((await POST(request({ treasuryId: id, action: "delete" }), context)).status).toBe(400);
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("returns not found when the treasury is gone", async () => {
    mocks.status.mockResolvedValue(null);
    expect((await GET(new Request(`http://localhost/api/treasury/lifecycle?treasuryId=${id}`), context)).status).toBe(404);
  });
});

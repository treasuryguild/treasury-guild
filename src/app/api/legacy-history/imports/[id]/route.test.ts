import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  importRow: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/legacyHistory/access", () => ({ requireLegacyImportAdmin: mocks.importRow }));
vi.mock("@/lib/db/legacyHistory", () => ({ deleteLegacyImport: mocks.remove }));
import { DELETE } from "./route";

const ADMIN = "addr_test1admin";
const IMPORT_ID = "40000000-0000-4000-8000-000000000001";
const context = () => ({ params: Promise.resolve({ id: IMPORT_ID }) });
const request = () => new Request(`http://localhost/api/legacy-history/imports/${IMPORT_ID}`, { method: "DELETE" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.importRow.mockResolvedValue({ id: IMPORT_ID, community_id: "com" });
});

describe("DELETE /api/legacy-history/imports/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await DELETE(request(), context())).status).toBe(401);
    expect(mocks.importRow).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.importRow.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await DELETE(request(), context())).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("404s on an unknown import", async () => {
    mocks.importRow.mockRejectedValue(new NotFoundError("Import not found"));
    const res = await DELETE(request(), context());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Import not found" });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes the import", async () => {
    const res = await DELETE(request(), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.importRow).toHaveBeenCalledWith(IMPORT_ID, ADMIN);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(IMPORT_ID);
  });

  it("rejects a request that declares another origin", async () => {
    const req = new Request(`http://localhost/api/legacy-history/imports/${IMPORT_ID}`, {
      method: "DELETE", headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect((await DELETE(req, context())).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

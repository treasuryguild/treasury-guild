import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  source: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/funding/access", () => ({ requireFundingSourceAdmin: mocks.source }));
vi.mock("@/lib/db/funding", () => ({ updateFundingSource: mocks.update, deleteFundingSource: mocks.remove }));
import { DELETE, PATCH } from "./route";

const ADMIN = "addr_test1admin";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const context = () => ({ params: Promise.resolve({ id: SOURCE }) });
const request = (method: "PATCH" | "DELETE", value: object) =>
  new Request(`http://localhost/api/funding/sources/${SOURCE}`, {
    method,
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.source.mockResolvedValue({ id: SOURCE, community_id: "com", name: "Project Catalyst" });
});

describe("PATCH /api/funding/sources/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    const res = await PATCH(request("PATCH", { name: "New" }), context());
    expect(res.status).toBe(401);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("is admin-only and 404s on an unknown source", async () => {
    mocks.source.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await PATCH(request("PATCH", { name: "New" }), context())).status).toBe(403);
    mocks.source.mockRejectedValueOnce(new NotFoundError("Funding source not found"));
    const missing = await PATCH(request("PATCH", { name: "New" }), context());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Funding source not found" });
    expect(mocks.source).toHaveBeenCalledWith(SOURCE, ADMIN);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("writes only the fields that were sent, trimmed", async () => {
    const res = await PATCH(request("PATCH", { name: "  Catalyst F14 " }), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(SOURCE, { name: "Catalyst F14" });
  });

  it("clears the description and url with null or an empty string", async () => {
    await PATCH(request("PATCH", { description: null, url: null }), context());
    expect(mocks.update).toHaveBeenLastCalledWith(SOURCE, { description: null, url: null });
    await PATCH(request("PATCH", { description: "   ", url: "" }), context());
    expect(mocks.update).toHaveBeenLastCalledWith(SOURCE, { description: null, url: null });
    await PATCH(request("PATCH", { description: " Grants ", url: "https://example.org/fund" }), context());
    expect(mocks.update).toHaveBeenLastCalledWith(SOURCE, { description: "Grants", url: "https://example.org/fund" });
  });

  it.each([
    [{ name: "   " }],
    [{ name: "x".repeat(81) }],
    [{ description: "d".repeat(501) }],
    [{ url: "ftp://example.org" }],
  ])("rejects invalid input %j", async (body) => {
    const res = await PATCH(request("PATCH", body), context());
    expect(res.status).toBe(400);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/funding/sources/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    const res = await DELETE(request("DELETE", { confirmName: "Project Catalyst" }), context());
    expect(res.status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("is admin-only and 404s on an unknown source", async () => {
    mocks.source.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await DELETE(request("DELETE", { confirmName: "Project Catalyst" }), context())).status).toBe(403);
    mocks.source.mockRejectedValueOnce(new NotFoundError("Funding source not found"));
    expect((await DELETE(request("DELETE", { confirmName: "Project Catalyst" }), context())).status).toBe(404);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes the source once its name is typed exactly", async () => {
    const res = await DELETE(request("DELETE", { confirmName: " Project Catalyst " }), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.source).toHaveBeenCalledWith(SOURCE, ADMIN);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(SOURCE);
  });

  it.each([
    [{ confirmName: "project catalyst" }],
    [{ confirmName: "Project" }],
    [{ confirmName: "" }],
    [{}],
    [{ confirmName: "x".repeat(81) }],
  ])("refuses the wrong confirmation %j", async (body) => {
    const res = await DELETE(request("DELETE", body), context());
    expect(res.status).toBe(400);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

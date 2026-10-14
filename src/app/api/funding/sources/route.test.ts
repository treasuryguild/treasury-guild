import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/funding", () => ({ createFundingSource: mocks.create }));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const request = (value: object, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/funding/sources", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json", ...headers },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.create.mockResolvedValue({ id: "src-new" });
});

describe("POST /api/funding/sources", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    const res = await POST(request({ communityId: COMMUNITY, name: "Catalyst" }), context);
    expect(res.status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({ communityId: COMMUNITY, name: "Catalyst" }), context);
    expect(res.status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the source with trimmed text and returns its id", async () => {
    const res = await POST(request({
      communityId: COMMUNITY, name: "  Project Catalyst  ", description: "  Fund 14  ", url: "https://projectcatalyst.io",
    }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "src-new" });
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({
      community_id: COMMUNITY,
      name: "Project Catalyst",
      description: "Fund 14",
      url: "https://projectcatalyst.io",
      created_by: ADMIN,
    });
  });

  it("stores a missing or blank description and url as null", async () => {
    await POST(request({ communityId: COMMUNITY, name: "Sponsor" }), context);
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ description: null, url: null }));
    await POST(request({ communityId: COMMUNITY, name: "Sponsor", description: "   ", url: "" }), context);
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ description: null, url: null }));
  });

  it.each([
    [{}],
    [{ communityId: "not-a-uuid", name: "X" }],
    [{ communityId: COMMUNITY }],
    [{ communityId: COMMUNITY, name: "   " }],
    [{ communityId: COMMUNITY, name: "x".repeat(81) }],
    [{ communityId: COMMUNITY, name: "X", description: "d".repeat(501) }],
    [{ communityId: COMMUNITY, name: "X", url: "javascript:alert(1)" }],
  ])("rejects invalid input %j before any authorization", async (body) => {
    const res = await POST(request(body), context);
    expect(res.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a request that declares another origin", async () => {
    const res = await POST(request({ communityId: COMMUNITY, name: "Catalyst" }, { Origin: "https://evil.example" }), context);
    expect(res.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

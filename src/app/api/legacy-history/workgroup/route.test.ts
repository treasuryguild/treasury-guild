import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  alias: vi.fn(),
  create: vi.fn(),
  community: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/chainImport", () => ({ upsertWorkgroupAlias: mocks.alias }));
vi.mock("@/lib/db/workgroups", () => ({
  createWorkgroupWithBoard: mocks.create,
  workgroupCommunityId: mocks.community,
}));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ARCHIVED = "20000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/legacy-history/workgroup", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.create.mockResolvedValue("wg-new");
  mocks.community.mockResolvedValue(COMMUNITY);
});

describe("POST /api/legacy-history/workgroup", () => {
  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({ communityId: COMMUNITY, name: "gov", action: "create" }), context);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the workgroup under the name as written and remembers the normalized key", async () => {
    const res = await POST(request({
      communityId: COMMUNITY, name: "treasury-guild", action: "create", displayName: "Treasury Guild",
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(COMMUNITY, "Treasury Guild");
    expect(mocks.alias).toHaveBeenCalledWith(COMMUNITY, "treasury-guild", "wg-new", ADMIN);
    expect(await res.json()).toEqual({ workgroupId: "wg-new" });
  });

  it("maps to an existing workgroup, archived ones included, of this community only", async () => {
    const ok = await POST(request({ communityId: COMMUNITY, name: "Old Guild", action: "map", workgroupId: ARCHIVED }), context);
    expect(ok.status).toBe(200);
    expect(mocks.alias).toHaveBeenCalledWith(COMMUNITY, "old-guild", ARCHIVED, ADMIN);

    mocks.alias.mockClear();
    mocks.community.mockResolvedValue("other");
    const foreign = await POST(request({ communityId: COMMUNITY, name: "gov", action: "map", workgroupId: ARCHIVED }), context);
    expect(foreign.status).toBe(400);
    expect(mocks.alias).not.toHaveBeenCalled();
  });
});

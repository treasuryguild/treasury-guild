import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  run: vi.fn(),
  blocked: vi.fn(),
  treasury: vi.fn(),
  alias: vi.fn(),
  create: vi.fn(),
  community: vi.fn(),
  active: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/chainImport/run", () => ({ importExternalTxs: mocks.run }));
vi.mock("@/lib/db/chainImport", () => ({
  loadBlockedByWorkgroup: mocks.blocked,
  loadImportTreasury: mocks.treasury,
  upsertWorkgroupAlias: mocks.alias,
}));
vi.mock("@/lib/db/workgroups", () => ({
  createWorkgroupWithBoard: mocks.create,
  workgroupCommunityId: mocks.community,
  requireActiveWorkgroup: mocks.active,
}));
import { POST } from "./route";

const WALLET = "addr_test1admin";
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/chain-import/workgroup", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.create.mockResolvedValue("wg-new");
  mocks.community.mockResolvedValue("10000000-0000-4000-8000-000000000001");
  mocks.active.mockResolvedValue(undefined);
  mocks.blocked.mockResolvedValue([
    { tx_hash: "h1", treasury_id: "t1" },
    { tx_hash: "h2", treasury_id: "t1" },
    { tx_hash: "h3", treasury_id: "t2" },
  ]);
  mocks.treasury.mockImplementation(async (id: string) => ({ id, community_id: "10000000-0000-4000-8000-000000000001", address: "a", network: 0 }));
  mocks.run.mockImplementation(async (_t: unknown, opts: { hashes: string[] }) => ({
    imported: opts.hashes,
    blocked: [],
  }));
});

describe("POST /api/chain-import/workgroup", () => {
  it("is admin-only and writes nothing otherwise", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001", name: "Docs", action: "create" }), context);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.alias).not.toHaveBeenCalled();
  });

  it("creates the workgroup, remembers the name and retries what waited for it, per treasury", async () => {
    const res = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001", name: "Docs", action: "create" }), context);
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", "Docs");
    expect(mocks.alias).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", "Docs", "wg-new", WALLET);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls[0]![1]).toEqual({ hashes: ["h1", "h2"], limit: 2 });
    expect(mocks.run.mock.calls[1]![1]).toEqual({ hashes: ["h3"], limit: 1 });
    expect(await res.json()).toEqual({ imported: ["h1", "h2", "h3"], blocked: [] });
  });

  it("maps a name to an existing workgroup of this community only", async () => {
    const ok = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001", name: "Docs", action: "map", workgroupId: "20000000-0000-4000-8000-000000000002" }), context);
    expect(ok.status).toBe(200);
    expect(mocks.alias).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", "Docs", "20000000-0000-4000-8000-000000000002", WALLET);
    expect(mocks.create).not.toHaveBeenCalled();

    mocks.alias.mockClear();
    mocks.community.mockResolvedValue("other");
    const foreign = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001", name: "Docs", action: "map", workgroupId: "20000000-0000-4000-8000-000000000002" }), context);
    expect(foreign.status).toBe(400);

    mocks.community.mockResolvedValue("10000000-0000-4000-8000-000000000001");
    mocks.active.mockRejectedValue(new ConflictError("Restore this workgroup before making changes"));
    const archived = await POST(request({ communityId: "10000000-0000-4000-8000-000000000001", name: "Docs", action: "map", workgroupId: "20000000-0000-4000-8000-000000000002" }), context);
    expect(archived.status).toBe(409);
    expect(mocks.alias).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { communityId: "10000000-0000-4000-8000-000000000001", name: "", action: "create" },
    { communityId: "10000000-0000-4000-8000-000000000001", name: "Docs", action: "map" },
    { communityId: "10000000-0000-4000-8000-000000000001", name: "x".repeat(65), action: "create" },
  ])("rejects invalid input %j", async (body) => {
    const res = await POST(request(body), context);
    expect(res.status).toBe(400);
  });
});

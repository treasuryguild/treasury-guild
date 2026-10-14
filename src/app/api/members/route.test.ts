import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientModule from "@/lib/db/client";
import type * as MembershipModule from "@/lib/db/membership";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), admin: vi.fn(), role: vi.fn(), signer: vi.fn(),
  add: vi.fn(), setRole: vi.fn(), workgroupIds: vi.fn(), db: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin, memberRole: mocks.role }));
vi.mock("@/lib/db/treasuries", () => ({ isCommunityTreasurySigner: mocks.signer }));
// removeMember stays real: its two deletes (lead assignments, then the membership) run
// against the fake service client below.
vi.mock("@/lib/db/membership", async (importOriginal) => ({
  ...(await importOriginal<typeof MembershipModule>()),
  addMember: mocks.add, setMemberRole: mocks.setRole,
}));
vi.mock("@/lib/db/workgroups", () => ({ communityWorkgroupIds: mocks.workgroupIds, workgroupCommunityId: vi.fn() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  serviceClient: mocks.db,
}));
import { DELETE, PATCH, POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WG_A = "50000000-0000-4000-8000-000000000001";
const WG_B = "50000000-0000-4000-8000-000000000002";
const ADMIN = "addr_test1admin";
// A well-formed preprod enterprise address: the add schema checks the address.
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const BOB = "addr_test1bob";

interface DbCall { table: string; op: string; filters: [string, string, unknown][] }
let dbCalls: DbCall[] = [];
/** Records `from(table).delete().eq(...).in(...)` chains and resolves them without error. */
function fakeServiceClient() {
  return {
    from(table: string) {
      const call: DbCall = { table, op: "", filters: [] };
      dbCalls.push(call);
      const query = {
        delete() { call.op = "delete"; return query; },
        eq(column: string, value: unknown) { call.filters.push(["eq", column, value]); return query; },
        in(column: string, values: unknown) { call.filters.push(["in", column, values]); return query; },
        then(resolve: (value: { error: null }) => void) { resolve({ error: null }); },
      };
      return query;
    },
  };
}

const context = { params: Promise.resolve({}) };
const call = (handler: typeof POST, method: string, body: object, headers: Record<string, string> = {}) =>
  handler(new Request("http://localhost/api/members", {
    method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }), context);
const post = (body: object, headers?: Record<string, string>) => call(POST, "POST", body, headers);
const patch = (body: object, headers?: Record<string, string>) => call(PATCH, "PATCH", body, headers);
const del = (body: object, headers?: Record<string, string>) => call(DELETE, "DELETE", body, headers);

beforeEach(() => {
  vi.resetAllMocks();
  dbCalls = [];
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.role.mockResolvedValue("member");
  mocks.signer.mockResolvedValue(false);
  mocks.add.mockResolvedValue(undefined);
  mocks.setRole.mockResolvedValue(undefined);
  mocks.workgroupIds.mockResolvedValue([WG_A, WG_B]);
  mocks.db.mockImplementation(fakeServiceClient);
});

describe("members API", () => {
  describe("every method", () => {
    it("requires a session", async () => {
      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await post({ communityId: COMMUNITY, wallet: ALICE })).status).toBe(401);
      expect((await patch({ communityId: COMMUNITY, wallet: BOB, role: "admin" })).status).toBe(401);
      expect((await del({ communityId: COMMUNITY, wallet: BOB })).status).toBe(401);
      expect(mocks.admin).not.toHaveBeenCalled();
    });

    it("refuses a cross-site request", async () => {
      const foreign = { origin: "https://evil.test" };
      expect((await post({ communityId: COMMUNITY, wallet: ALICE }, foreign)).status).toBe(403);
      expect((await patch({ communityId: COMMUNITY, wallet: BOB, role: "admin" }, foreign)).status).toBe(403);
      expect((await del({ communityId: COMMUNITY, wallet: BOB }, foreign)).status).toBe(403);
      expect(mocks.session).not.toHaveBeenCalled();
      expect(mocks.add).not.toHaveBeenCalled();
      expect(mocks.setRole).not.toHaveBeenCalled();
      expect(dbCalls).toEqual([]);
    });

    it("requires an admin of the community", async () => {
      mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
      expect((await post({ communityId: COMMUNITY, wallet: ALICE })).status).toBe(403);
      expect((await patch({ communityId: COMMUNITY, wallet: BOB, role: "admin" })).status).toBe(403);
      expect((await del({ communityId: COMMUNITY, wallet: BOB })).status).toBe(403);
      expect(mocks.admin).toHaveBeenCalledTimes(3);
      expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
      expect(mocks.role).not.toHaveBeenCalled();
      expect(mocks.add).not.toHaveBeenCalled();
      expect(mocks.setRole).not.toHaveBeenCalled();
      expect(dbCalls).toEqual([]);
    });

    it("validates the body before checking anything", async () => {
      expect((await post({ communityId: "nope", wallet: ALICE })).status).toBe(400);
      expect((await post({ communityId: COMMUNITY, wallet: "not-an-address" })).status).toBe(400);
      expect((await post({ communityId: COMMUNITY })).status).toBe(400);
      expect((await patch({ communityId: COMMUNITY, wallet: BOB, role: "owner" })).status).toBe(400);
      expect((await patch({ communityId: COMMUNITY, wallet: BOB })).status).toBe(400);
      expect((await patch({ communityId: COMMUNITY, wallet: "", role: "admin" })).status).toBe(400);
      expect((await del({ communityId: COMMUNITY })).status).toBe(400);
      expect((await del({ communityId: "nope", wallet: BOB })).status).toBe(400);
      expect(mocks.admin).not.toHaveBeenCalled();
    });
  });

  describe("POST (add)", () => {
    it("adds the wallet as a member", async () => {
      const response = await post({ communityId: COMMUNITY, wallet: ALICE });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.add).toHaveBeenCalledExactlyOnceWith(COMMUNITY, ALICE);
      // Adding never consults the target's role or the signer lists.
      expect(mocks.role).not.toHaveBeenCalled();
      expect(mocks.signer).not.toHaveBeenCalled();
    });
  });

  describe("PATCH (role)", () => {
    it("refuses changing your own role, before looking the member up", async () => {
      const response = await patch({ communityId: COMMUNITY, wallet: ADMIN, role: "member" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "You cannot change your own role" });
      expect(mocks.role).not.toHaveBeenCalled();
      expect(mocks.setRole).not.toHaveBeenCalled();
    });

    it("answers 404 for a wallet that is not a member", async () => {
      mocks.role.mockResolvedValue(null);
      const response = await patch({ communityId: COMMUNITY, wallet: BOB, role: "admin" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Member not found" });
      expect(mocks.role).toHaveBeenCalledWith(COMMUNITY, BOB);
      expect(mocks.setRole).not.toHaveBeenCalled();
    });

    it("never changes the owner's role", async () => {
      mocks.role.mockResolvedValue("owner");
      const response = await patch({ communityId: COMMUNITY, wallet: BOB, role: "member" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "The owner's role cannot be changed" });
      expect(mocks.signer).not.toHaveBeenCalled();
      expect(mocks.setRole).not.toHaveBeenCalled();
    });

    it("promotes a member to admin without consulting the signer lists", async () => {
      const response = await patch({ communityId: COMMUNITY, wallet: BOB, role: "admin" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.signer).not.toHaveBeenCalled();
      expect(mocks.setRole).toHaveBeenCalledExactlyOnceWith(COMMUNITY, BOB, "admin");
    });

    it("keeps a base signer an admin", async () => {
      mocks.role.mockResolvedValue("admin");
      mocks.signer.mockResolvedValue(true);
      const response = await patch({ communityId: COMMUNITY, wallet: BOB, role: "member" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Treasury signers must remain admins" });
      // Only the base group counts: the check is scoped to it.
      expect(mocks.signer).toHaveBeenCalledExactlyOnceWith(COMMUNITY, BOB, ["base"]);
      expect(mocks.setRole).not.toHaveBeenCalled();
    });

    it("demotes an admin who signs only as a recovery signer or co-signer", async () => {
      mocks.role.mockResolvedValue("admin");
      mocks.signer.mockResolvedValue(false);
      const response = await patch({ communityId: COMMUNITY, wallet: BOB, role: "member" });
      expect(response.status).toBe(200);
      expect(mocks.signer).toHaveBeenCalledExactlyOnceWith(COMMUNITY, BOB, ["base"]);
      expect(mocks.setRole).toHaveBeenCalledExactlyOnceWith(COMMUNITY, BOB, "member");
    });
  });

  describe("DELETE (remove)", () => {
    it("refuses removing yourself, before looking the member up", async () => {
      const response = await del({ communityId: COMMUNITY, wallet: ADMIN });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "You cannot remove yourself" });
      expect(mocks.role).not.toHaveBeenCalled();
      expect(dbCalls).toEqual([]);
    });

    it("answers 404 for a wallet that is not a member", async () => {
      mocks.role.mockResolvedValue(null);
      const response = await del({ communityId: COMMUNITY, wallet: BOB });
      expect(response.status).toBe(404);
      expect(mocks.signer).not.toHaveBeenCalled();
      expect(dbCalls).toEqual([]);
    });

    it("never removes the owner", async () => {
      mocks.role.mockResolvedValue("owner");
      const response = await del({ communityId: COMMUNITY, wallet: BOB });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "The owner's role cannot be changed" });
      expect(mocks.signer).not.toHaveBeenCalled();
      expect(dbCalls).toEqual([]);
    });

    it("never removes a signer of any group", async () => {
      mocks.role.mockResolvedValue("member");
      mocks.signer.mockResolvedValue(true);
      const response = await del({ communityId: COMMUNITY, wallet: BOB });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Treasury signers cannot be removed" });
      // No group filter: a recovery signer or co-signer counts too.
      expect(mocks.signer).toHaveBeenCalledExactlyOnceWith(COMMUNITY, BOB);
      expect(dbCalls).toEqual([]);
    });

    it("removes a member after dropping their lead assignments in the community", async () => {
      const response = await del({ communityId: COMMUNITY, wallet: BOB });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.workgroupIds).toHaveBeenCalledWith(COMMUNITY);
      expect(dbCalls).toEqual([
        { table: "workgroup_leads", op: "delete", filters: [["eq", "wallet_address", BOB], ["in", "workgroup_id", [WG_A, WG_B]]] },
        { table: "community_members", op: "delete", filters: [["eq", "community_id", COMMUNITY], ["eq", "wallet_address", BOB]] },
      ]);
    });

    it("skips the lead cleanup when the community has no workgroups", async () => {
      mocks.workgroupIds.mockResolvedValue([]);
      expect((await del({ communityId: COMMUNITY, wallet: BOB })).status).toBe(200);
      expect(dbCalls).toEqual([
        { table: "community_members", op: "delete", filters: [["eq", "community_id", COMMUNITY], ["eq", "wallet_address", BOB]] },
      ]);
    });
  });
});

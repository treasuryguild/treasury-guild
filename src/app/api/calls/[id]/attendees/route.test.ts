import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { shortAddress } from "@/lib/format";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), loadCall: vi.fn(), attendees: vi.fn(), attendee: vi.fn(),
  insert: vi.fn(), update: vi.fn(), remove: vi.fn(), aliases: vi.fn(), members: vi.fn(),
  saveAlias: vi.fn(), contributor: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/calls", () => ({
  loadCall: mocks.loadCall, loadCallAttendees: mocks.attendees, loadCallAttendee: mocks.attendee,
  insertAttendees: mocks.insert, updateAttendee: mocks.update, deleteAttendee: mocks.remove,
  loadNameAliases: mocks.aliases, loadMemberOptions: mocks.members, saveNameAlias: mocks.saveAlias,
}));
vi.mock("@/lib/db/membership", () => ({ ensureContributor: mocks.contributor }));
import { DELETE, PATCH, POST } from "./route";

const CALL_ID = "40000000-0000-4000-8000-000000000003";
const ATTENDEE_ID = "40000000-0000-4000-8000-000000000004";
const MANAGE = "Only admins and workgroup leads can manage calls";
const REWARDED = "This attendee is already on an attendance task";
// Well-formed enterprise addresses (random key hashes): three on preprod, one on mainnet.
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const BOB = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const CAROL = "addr_test1vr9mtjy7453pue4fs0d6qmwwenvf6z2zay0a6a9vj3n7eeqdurjp6";
const MAINNET =
  "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";

const context = { params: Promise.resolve({ id: CALL_ID }) };
const request = (method: string, body: object) => new Request(`http://localhost/api/calls/${CALL_ID}/attendees`, {
  method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const post = (body: object) => POST(request("POST", body), context);
const patch = (body: object) => PATCH(request("PATCH", { attendeeId: ATTENDEE_ID, ...body }), context);
const remove = (body: object = { attendeeId: ATTENDEE_ID }) => DELETE(request("DELETE", body), context);
const call = {
  id: CALL_ID, community_id: "community", workgroup_id: "workgroup",
  workgroups: { archived_at: null, communities: { slug: "guild", network: 0 } },
};
const row = (overrides: object = {}) => ({
  id: ATTENDEE_ID, call_id: CALL_ID, provider: "zoom", display_name: "Bob Smith (Guest)",
  wallet_address: null, status: "auto", task_id: null,
  ...overrides,
});
const error = async (response: Response) => (await response.json()).error as string;
const refuseManager = () => mocks.manager.mockImplementation(
  async (_c: string, _w: string, _wallet: string, message: string) => { throw new ForbiddenError(message); },
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.loadCall.mockResolvedValue(call);
  mocks.manager.mockResolvedValue(undefined);
  mocks.attendees.mockResolvedValue([row({ id: "a-1", display_name: "Alice", wallet_address: ALICE })]);
  mocks.attendee.mockResolvedValue(row());
  mocks.aliases.mockResolvedValue(new Map());
  mocks.members.mockResolvedValue([]);
  mocks.contributor.mockResolvedValue({ created: false });
});

describe("add attendees API", () => {
  it("adds one wallet as a manual attendee named by its short address", async () => {
    const response = await post({ kind: "wallet", wallet: BOB });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 1, matched: 1, skipped: 0 });
    expect(mocks.manager).toHaveBeenCalledWith("community", "workgroup", "lead", MANAGE);
    expect(mocks.attendees).toHaveBeenCalledWith(CALL_ID);
    expect(mocks.contributor).toHaveBeenCalledExactlyOnceWith(BOB);
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith([
      { call_id: CALL_ID, provider: "manual", display_name: shortAddress(BOB), wallet_address: BOB },
    ]);
  });

  it("refuses a wallet already on the list, and one on the other network", async () => {
    const twice = await post({ kind: "wallet", wallet: ALICE });
    expect(twice.status).toBe(409);
    expect(await error(twice)).toBe("This wallet is already on the call's list");
    const mainnet = await post({ kind: "wallet", wallet: MAINNET });
    expect(mainnet.status).toBe(400);
    expect(await error(mainnet)).toBe("This community pays on preprod: use a preprod (addr_test…) address");
    expect(mocks.contributor).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("adds pasted names once each, matched to a wallet only where the match is unambiguous", async () => {
    mocks.aliases.mockResolvedValue(new Map([["bobby", BOB], ["al", ALICE]]));
    mocks.members.mockResolvedValue([
      { wallet: BOB, handle: "Bob", githubUsername: null },
      { wallet: CAROL, handle: "carol", githubUsername: "sam" },
      { wallet: ALICE, handle: "alice", githubUsername: "Sam" },
    ]);
    const names = ["ALICE (Host)", "Bob", "@bob", "Bobby", "Al", "Carol", "Sam", "Dave", "!!!"];
    const response = await post({ kind: "names", names });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 4, matched: 2, skipped: 5 });
    expect(mocks.aliases).toHaveBeenCalledWith("community");
    expect(mocks.members).toHaveBeenCalledWith("community");
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith([
      { call_id: CALL_ID, provider: "manual", display_name: "Bob", wallet_address: BOB },
      { call_id: CALL_ID, provider: "manual", display_name: "Carol", wallet_address: CAROL },
      { call_id: CALL_ID, provider: "manual", display_name: "Sam", wallet_address: null },
      { call_id: CALL_ID, provider: "manual", display_name: "Dave", wallet_address: null },
    ]);
    expect(mocks.contributor).not.toHaveBeenCalled();
  });

  it("refuses an unknown call, a non-manager and an archived workgroup before reading the list", async () => {
    mocks.loadCall.mockResolvedValueOnce(null);
    expect((await post({ kind: "names", names: ["Bob"] })).status).toBe(404);
    mocks.loadCall.mockResolvedValueOnce({ ...call, workgroups: { archived_at: "2026-09-01T00:00:00Z", communities: null } });
    expect((await post({ kind: "wallet", wallet: BOB })).status).toBe(409);
    refuseManager();
    const forbidden = await post({ kind: "wallet", wallet: BOB });
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post({ kind: "wallet", wallet: BOB })).status).toBe(401);
    expect(mocks.attendees).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies before loading the call", async () => {
    const refusal = async (body: object) => {
      const response = await post(body);
      expect(response.status).toBe(400);
      return error(response);
    };
    expect(await refusal({ kind: "names", names: [] })).toBe("names: Paste at least one name");
    expect(await refusal({ kind: "names", names: Array.from({ length: 201 }, (_, i) => `Guest ${i}`) })).toBe("names: At most 200 names at a time");
    expect(await refusal({ kind: "wallet", wallet: "addr_test1nope" })).toBe("Invalid address");
    await refusal({ kind: "names", names: ["  "] });
    await refusal({ kind: "email", email: "bob@example.org" });
    await refusal({});
    expect(mocks.loadCall).not.toHaveBeenCalled();
  });
});

describe("edit attendee API", () => {
  it("links a wallet and remembers the name for the community's next calls", async () => {
    const response = await patch({ wallet: BOB, remember: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.attendee).toHaveBeenCalledWith(CALL_ID, ATTENDEE_ID);
    expect(mocks.contributor).toHaveBeenCalledExactlyOnceWith(BOB);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(ATTENDEE_ID, { wallet_address: BOB });
    expect(mocks.saveAlias).toHaveBeenCalledExactlyOnceWith({
      community_id: "community", normalized_name: "bob smith", wallet_address: BOB, created_by: "lead",
    });
  });

  it("remembers nothing unless asked, on an unlink, or for a name with no letters", async () => {
    await patch({ wallet: BOB });
    await patch({ wallet: null, remember: true });
    expect(mocks.update).toHaveBeenLastCalledWith(ATTENDEE_ID, { wallet_address: null });
    mocks.attendee.mockResolvedValue(row({ display_name: "???" }));
    await patch({ wallet: BOB, remember: true });
    expect(mocks.update).toHaveBeenCalledTimes(3);
    expect(mocks.contributor).toHaveBeenCalledTimes(2);
    expect(mocks.saveAlias).not.toHaveBeenCalled();
  });

  it("sets the status alone, or together with the wallet", async () => {
    expect((await patch({ status: "excluded" })).status).toBe(200);
    expect(mocks.update).toHaveBeenLastCalledWith(ATTENDEE_ID, { status: "excluded" });
    expect(mocks.contributor).not.toHaveBeenCalled();
    expect((await patch({ status: "confirmed", wallet: BOB })).status).toBe(200);
    expect(mocks.update).toHaveBeenLastCalledWith(ATTENDEE_ID, { wallet_address: BOB, status: "confirmed" });
  });

  it("refuses an attendee of another call, one already rewarded, and a wallet on the other network", async () => {
    mocks.attendee.mockResolvedValueOnce(null);
    const missing = await patch({ status: "excluded" });
    expect(missing.status).toBe(404);
    expect(await error(missing)).toBe("Attendee not found");
    mocks.attendee.mockResolvedValueOnce(row({ task_id: "task-1" }));
    const rewarded = await patch({ status: "excluded" });
    expect(rewarded.status).toBe(409);
    expect(await error(rewarded)).toBe(REWARDED);
    const mainnet = await patch({ wallet: MAINNET });
    expect(mainnet.status).toBe(400);
    expect(await error(mainnet)).toBe("This community pays on preprod: use a preprod (addr_test…) address");
    expect(mocks.contributor).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("surfaces a wallet that another row of the call already carries, without remembering it", async () => {
    mocks.update.mockRejectedValue(new ConflictError("This wallet is already on the call's list"));
    expect((await patch({ wallet: ALICE, remember: true })).status).toBe(409);
    expect(mocks.saveAlias).not.toHaveBeenCalled();
  });

  it("refuses a non-manager, and malformed bodies before loading the call", async () => {
    refuseManager();
    const forbidden = await patch({ status: "excluded" });
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);
    expect(mocks.attendee).not.toHaveBeenCalled();
    mocks.loadCall.mockClear();
    const nothing = await patch({ remember: true });
    expect(nothing.status).toBe(400);
    expect(await error(nothing)).toBe("Nothing to update");
    expect((await patch({ wallet: "addr_test1nope" })).status).toBe(400);
    expect((await patch({ status: "paid" })).status).toBe(400);
    expect((await patch({ attendeeId: "a-1", status: "excluded" })).status).toBe(400);
    expect(mocks.loadCall).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("remove attendee API", () => {
  it("removes a row of this call that is not yet rewarded", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.attendee).toHaveBeenCalledWith(CALL_ID, ATTENDEE_ID);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(ATTENDEE_ID);
  });

  it("refuses an unknown attendee, a rewarded one, a non-manager and a malformed body", async () => {
    mocks.attendee.mockResolvedValueOnce(null);
    expect((await remove()).status).toBe(404);
    mocks.attendee.mockResolvedValueOnce(row({ task_id: "task-1" }));
    const rewarded = await remove();
    expect(rewarded.status).toBe(409);
    expect(await error(rewarded)).toBe(REWARDED);
    expect((await remove({ attendeeId: "a-1" })).status).toBe(400);
    expect((await remove({})).status).toBe(400);
    refuseManager();
    expect((await remove()).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

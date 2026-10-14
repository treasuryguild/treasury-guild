import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError, UnauthorizedError } from "@/lib/errors";
import { shortAddress } from "@/lib/format";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), rateLimit: vi.fn(), loadCall: vi.fn(), code: vi.fn(), attendees: vi.fn(),
  insertOnce: vi.fn(), name: vi.fn(), addMember: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: vi.fn() }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/calls", () => ({
  loadCall: mocks.loadCall, loadCheckinCode: mocks.code, loadCallAttendees: mocks.attendees,
  insertAttendeeOnce: mocks.insertOnce, loadContributorName: mocks.name,
}));
vi.mock("@/lib/db/membership", () => ({ addMember: mocks.addMember }));
import { POST } from "./route";

const CALL_ID = "40000000-0000-4000-8000-000000000003";
const NOW = "2026-10-01T18:30:00.000Z";
const MISMATCH = "That code does not match this call";
const MINUTE = 60 * 1000;
// Well-formed enterprise preprod addresses (random key hashes), and a mainnet one.
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const BOB = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const MAINNET =
  "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";

const context = { params: Promise.resolve({ id: CALL_ID }) };
const post = (body: object = { code: "ABC234" }) => POST(new Request(`http://localhost/api/calls/${CALL_ID}/checkin`, {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
}), context);
const call = (overrides: object = {}) => ({
  id: CALL_ID, community_id: "community", workgroup_id: "workgroup", title: "Town hall",
  starts_at: "2026-10-01T18:00:00.000Z", ends_at: "2026-10-01T19:00:00.000Z",
  workgroups: { archived_at: null, communities: { slug: "guild", network: 0 } },
  ...overrides,
});
const error = async (response: Response) => (await response.json()).error as string;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(NOW));
  mocks.session.mockResolvedValue({ wallet: ALICE });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.loadCall.mockResolvedValue(call());
  mocks.code.mockResolvedValue("ABC234");
  mocks.attendees.mockResolvedValue([{ id: "a-1", wallet_address: BOB }, { id: "a-2", wallet_address: null }]);
  mocks.addMember.mockResolvedValue(undefined);
  mocks.name.mockResolvedValue("alice");
  mocks.insertOnce.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("call check-in API", () => {
  it("joins the wallet to the community and puts it on the list once, under its own name", async () => {
    const response = await post({ code: "abc-234 " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "Town hall", communitySlug: "guild", already: false });
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith("callCheckin", `${CALL_ID}:${ALICE}`);
    expect(mocks.code).toHaveBeenCalledWith(CALL_ID);
    expect(mocks.addMember).toHaveBeenCalledExactlyOnceWith("community", ALICE);
    expect(mocks.name).toHaveBeenCalledWith(ALICE);
    expect(mocks.insertOnce).toHaveBeenCalledExactlyOnceWith({
      call_id: CALL_ID, provider: "checkin", external_id: ALICE, display_name: "alice",
      wallet_address: ALICE, first_seen: NOW, last_seen: NOW,
    });
  });

  it("names a wallet with no profile by its short address", async () => {
    mocks.name.mockResolvedValue(null);
    expect((await post()).status).toBe(200);
    expect(mocks.insertOnce).toHaveBeenCalledWith(expect.objectContaining({ display_name: shortAddress(ALICE) }));
  });

  it("answers 'already' for a wallet on the list, and for a check-in that lost a race, without a second row", async () => {
    mocks.insertOnce.mockResolvedValue(false);
    expect(await (await post()).json()).toMatchObject({ already: true });
    expect(mocks.insertOnce).toHaveBeenCalledTimes(1);

    mocks.attendees.mockResolvedValue([{ id: "a-1", wallet_address: ALICE }]);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "Town hall", communitySlug: "guild", already: true });
    expect(mocks.addMember).toHaveBeenCalledTimes(1);
    expect(mocks.insertOnce).toHaveBeenCalledTimes(1);
  });

  it("gives one answer for no such call, a call with no code and a wrong code", async () => {
    const mismatch = async (body?: object) => {
      const response = await post(body);
      expect(response.status).toBe(404);
      expect(await error(response)).toBe(MISMATCH);
    };
    await mismatch({ code: "ABC235" });
    await mismatch({ code: "ABC2345" });
    mocks.code.mockResolvedValueOnce(null);
    await mismatch();
    mocks.code.mockClear();
    mocks.loadCall.mockResolvedValue(null);
    await mismatch();
    expect(mocks.code).not.toHaveBeenCalled();
    expect(mocks.attendees).not.toHaveBeenCalled();
    expect(mocks.addMember).not.toHaveBeenCalled();
  });

  it("opens 15 minutes before the start and closes when the call ends", async () => {
    vi.setSystemTime(Date.parse("2026-10-01T18:00:00.000Z") - 15 * MINUTE);
    expect((await post()).status).toBe(200);
    vi.setSystemTime(Date.parse("2026-10-01T19:00:00.000Z"));
    expect((await post()).status).toBe(200);
    mocks.addMember.mockClear();

    vi.setSystemTime(Date.parse("2026-10-01T18:00:00.000Z") - 15 * MINUTE - 1);
    const early = await post();
    expect(early.status).toBe(400);
    expect(await error(early)).toBe("Check-in opens 15 minutes before the call starts");
    vi.setSystemTime(Date.parse("2026-10-01T19:00:00.000Z") + 1);
    const closed = await post();
    expect(closed.status).toBe(400);
    expect(await error(closed)).toBe("Check-in closed when the call ended");
    expect(mocks.addMember).not.toHaveBeenCalled();
  });

  it("refuses a call of an archived workgroup, and a wallet on the other network", async () => {
    mocks.loadCall.mockResolvedValueOnce(call({ workgroups: { archived_at: "2026-09-01T00:00:00Z", communities: { slug: "guild", network: 0 } } }));
    const archived = await post();
    expect(archived.status).toBe(409);
    expect(await error(archived)).toBe("This call is archived");

    mocks.session.mockResolvedValue({ wallet: MAINNET });
    const mainnet = await post();
    expect(mainnet.status).toBe(400);
    expect(await error(mainnet)).toBe("This community pays on preprod: use a preprod (addr_test…) address");
    expect(mocks.addMember).not.toHaveBeenCalled();
    expect(mocks.insertOnce).not.toHaveBeenCalled();
  });

  it("caps the attempts per call and wallet before the code is compared", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    expect((await post()).status).toBe(429);
    expect(mocks.loadCall).not.toHaveBeenCalled();
    expect(mocks.code).not.toHaveBeenCalled();
  });

  it("needs a session and a code, and counts neither against the limit", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ code: "   " })).status).toBe(400);
    expect((await post({ code: "A".repeat(33) })).status).toBe(400);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.loadCall).not.toHaveBeenCalled();
  });
});

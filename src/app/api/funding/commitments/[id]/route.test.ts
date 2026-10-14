import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  commitment: vi.fn(),
  tokens: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/funding/access", () => ({
  requireFundingCommitmentAdmin: mocks.commitment,
  resolveFundingTokens: mocks.tokens,
}));
vi.mock("@/lib/db/funding", () => ({ updateFundingCommitment: mocks.update, deleteFundingCommitment: mocks.remove }));
import { DELETE, PATCH } from "./route";

const ADMIN = "addr_test1admin";
const COMMITMENT = "50000000-0000-4000-8000-000000000001";
const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
const context = () => ({ params: Promise.resolve({ id: COMMITMENT }) });
const patch = (value: object) =>
  new Request(`http://localhost/api/funding/commitments/${COMMITMENT}`, {
    method: "PATCH",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });
const del = () => new Request(`http://localhost/api/funding/commitments/${COMMITMENT}`, { method: "DELETE" });

const row = (extra: object = {}) => ({
  id: COMMITMENT, community_id: "com", kind: "recurring", cadence: "monthly",
  starts_on: "2026-01-01", ends_on: "2026-12-01", ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.commitment.mockResolvedValue(row());
  mocks.tokens.mockResolvedValue(new Map([["lovelace", { ticker: "ADA", decimals: 6 }], [AGIX, { ticker: "AGIX", decimals: 8 }]]));
});

describe("PATCH /api/funding/commitments/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await PATCH(patch({ name: "New" }), context())).status).toBe(401);
    expect(mocks.commitment).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("is admin-only and 404s on an unknown commitment", async () => {
    mocks.commitment.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await PATCH(patch({ name: "New" }), context())).status).toBe(403);
    mocks.commitment.mockRejectedValueOnce(new NotFoundError("Commitment not found"));
    const missing = await PATCH(patch({ name: "New" }), context());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Commitment not found" });
    expect(mocks.commitment).toHaveBeenCalledWith(COMMITMENT, ADMIN);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("writes only the fields that were sent", async () => {
    const res = await PATCH(patch({ name: "  Monthly grant ", note: "  " }), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(COMMITMENT, { name: "Monthly grant", note: null });
    expect(mocks.tokens).not.toHaveBeenCalled();
  });

  it("stores months as day-1 dates and clears an end month with null", async () => {
    await PATCH(patch({ startsOn: "2026-03", endsOn: "2026-09", url: "https://example.org/plan" }), context());
    expect(mocks.update).toHaveBeenLastCalledWith(COMMITMENT, {
      url: "https://example.org/plan", starts_on: "2026-03-01", ends_on: "2026-09-01",
    });
    await PATCH(patch({ endsOn: null, url: "" }), context());
    expect(mocks.update).toHaveBeenLastCalledWith(COMMITMENT, { url: null, ends_on: null });
  });

  it("scales amounts with the token's real decimals, resolved for the commitment's community", async () => {
    const res = await PATCH(patch({
      amounts: [{ unit: "lovelace", amount: "20000" }, { unit: AGIX, amount: "211800.72389063" }],
    }), context());
    expect(res.status).toBe(200);
    expect(mocks.tokens).toHaveBeenCalledWith("com", ["lovelace", AGIX]);
    expect(mocks.update).toHaveBeenCalledWith(COMMITMENT, {
      amounts: [
        { unit: "lovelace", amount: "20000000000", asset_label: "ADA", decimals: 6 },
        { unit: AGIX, amount: "21180072389063", asset_label: "AGIX", decimals: 8 },
      ],
    });
  });

  it("refuses more decimals than the token has and unknown tokens", async () => {
    expect((await PATCH(patch({ amounts: [{ unit: "lovelace", amount: "1.0000001" }] }), context())).status).toBe(400);
    mocks.tokens.mockRejectedValueOnce(new BadRequestError("No token with the unit … exists on this network"));
    expect((await PATCH(patch({ amounts: [{ unit: "ab".repeat(30), amount: "1" }] }), context())).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "  " }],
    [{ name: "x".repeat(121) }],
    [{ startsOn: "2026-13" }],
    [{ endsOn: "March" }],
    [{ amounts: [] }],
    [{ amounts: [{ unit: "lovelace", amount: "0" }] }],
    [{ amounts: [{ unit: "lovelace", amount: "1,5" }] }],
    [{ amounts: [{ unit: "not-hex", amount: "1" }] }],
    [{ amounts: [{ unit: "lovelace", amount: "1" }, { unit: "lovelace", amount: "2" }] }],
  ])("rejects invalid input %j before loading the commitment", async (body) => {
    const res = await PATCH(patch(body), context());
    expect(res.status).toBe(400);
    expect(mocks.commitment).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses amounts and months on a schedule, but still renames it", async () => {
    mocks.commitment.mockResolvedValue(row({ kind: "schedule", starts_on: null, ends_on: null }));
    for (const body of [{ amounts: [{ unit: "lovelace", amount: "1" }] }, { startsOn: "2026-01" }, { endsOn: "2026-02" }]) {
      const res = await PATCH(patch(body), context());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "A schedule's amounts are set per period" });
    }
    expect(mocks.update).not.toHaveBeenCalled();
    expect((await PATCH(patch({ name: "Release plan" }), context())).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(COMMITMENT, { name: "Release plan" });
  });

  it("allows an end month on a recurring commitment only", async () => {
    mocks.commitment.mockResolvedValue(row({ kind: "one_off", cadence: null, starts_on: null, ends_on: null }));
    const res = await PATCH(patch({ endsOn: "2026-06" }), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Only a recurring commitment has an end month" });
    // A one-off's expected month is optional and can be cleared.
    expect((await PATCH(patch({ startsOn: null }), context())).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(COMMITMENT, { starts_on: null });
  });

  it("keeps a recurring commitment's first month", async () => {
    const res = await PATCH(patch({ startsOn: null }), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Choose the first month" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("compares a new month with the stored other end", async () => {
    // Stored: 2026-01 .. 2026-12.
    const early = await PATCH(patch({ endsOn: "2025-12" }), context());
    expect(early.status).toBe(400);
    expect(await early.json()).toEqual({ error: "The last month comes before the first" });
    expect((await PATCH(patch({ startsOn: "2027-01" }), context())).status).toBe(400);
    expect((await PATCH(patch({ startsOn: "2027-01", endsOn: "2027-02" }), context())).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("holds a quarterly commitment to quarter months", async () => {
    mocks.commitment.mockResolvedValue(row({ cadence: "quarterly", starts_on: "2026-01-01", ends_on: null }));
    const off = await PATCH(patch({ startsOn: "2026-02" }), context());
    expect(off.status).toBe(400);
    expect(await off.json()).toEqual({ error: "Quarterly periods start in January, April, July or October" });
    expect((await PATCH(patch({ endsOn: "2026-05" }), context())).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
    expect((await PATCH(patch({ startsOn: "2026-04", endsOn: "2026-10" }), context())).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(COMMITMENT, { starts_on: "2026-04-01", ends_on: "2026-10-01" });
  });
});

describe("DELETE /api/funding/commitments/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await DELETE(del(), context())).status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("is admin-only and 404s on an unknown commitment", async () => {
    mocks.commitment.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await DELETE(del(), context())).status).toBe(403);
    mocks.commitment.mockRejectedValueOnce(new NotFoundError("Commitment not found"));
    expect((await DELETE(del(), context())).status).toBe(404);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes the commitment", async () => {
    const res = await DELETE(del(), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.commitment).toHaveBeenCalledWith(COMMITMENT, ADMIN);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(COMMITMENT);
  });
});

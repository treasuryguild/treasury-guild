import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  commitment: vi.fn(),
  tokens: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/funding/access", () => ({
  requireFundingCommitmentAdmin: mocks.commitment,
  resolveFundingTokens: mocks.tokens,
}));
vi.mock("@/lib/db/funding", () => ({ saveFundingSchedule: mocks.save }));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMITMENT = "50000000-0000-4000-8000-000000000001";
const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
const context = () => ({ params: Promise.resolve({ id: COMMITMENT }) });
const request = (value: object) =>
  new Request(`http://localhost/api/funding/commitments/${COMMITMENT}/schedule`, {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });
const ada = (amount: string) => ({ unit: "lovelace", amount });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.commitment.mockResolvedValue({ id: COMMITMENT, community_id: "com", kind: "schedule", cadence: "monthly" });
  mocks.tokens.mockResolvedValue(new Map([["lovelace", { ticker: "ADA", decimals: 6 }], [AGIX, { ticker: "AGIX", decimals: 8 }]]));
  mocks.save.mockImplementation(async (_id: string, periods: unknown[]) => periods.length);
});

describe("POST /api/funding/commitments/[id]/schedule", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await POST(request({ periods: [] }), context())).status).toBe(401);
    expect(mocks.commitment).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("is admin-only and 404s on an unknown commitment", async () => {
    mocks.commitment.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await POST(request({ periods: [] }), context())).status).toBe(403);
    mocks.commitment.mockRejectedValueOnce(new NotFoundError("Commitment not found"));
    const missing = await POST(request({ periods: [] }), context());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Commitment not found" });
    expect(mocks.commitment).toHaveBeenCalledWith(COMMITMENT, ADMIN);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("replaces the whole schedule in one save, with amounts scaled server-side", async () => {
    const res = await POST(request({
      periods: [
        { month: "2026-01", amounts: [ada("20000"), { unit: AGIX, amount: "211800.72389063" }] },
        { month: "2026-04", amounts: [ada("0.5")] },
      ],
    }), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ periods: 2 });
    expect(mocks.tokens).toHaveBeenCalledWith("com", ["lovelace", AGIX, "lovelace"]);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith(COMMITMENT, [
      {
        startsOn: "2026-01-01",
        amounts: [
          { unit: "lovelace", amount: "20000000000", asset_label: "ADA", decimals: 6 },
          { unit: AGIX, amount: "21180072389063", asset_label: "AGIX", decimals: 8 },
        ],
      },
      { startsOn: "2026-04-01", amounts: [{ unit: "lovelace", amount: "500000", asset_label: "ADA", decimals: 6 }] },
    ]);
  });

  it("returns the count the save reports", async () => {
    mocks.save.mockResolvedValue(7);
    const res = await POST(request({ periods: [{ month: "2026-01", amounts: [ada("1")] }] }), context());
    expect(await res.json()).toEqual({ periods: 7 });
  });

  it("clears the schedule with an empty list", async () => {
    const res = await POST(request({ periods: [] }), context());
    expect(res.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(COMMITMENT, []);
    expect(await res.json()).toEqual({ periods: 0 });
  });

  it.each(["one_off", "recurring"])("refuses a %s commitment", async (kind) => {
    mocks.commitment.mockResolvedValue({ id: COMMITMENT, community_id: "com", kind });
    const res = await POST(request({ periods: [{ month: "2026-01", amounts: [ada("1")] }] }), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Only a schedule has periods" });
    expect(mocks.tokens).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ periods: "2026-01" }],
    [{ periods: [{ month: "2026-1", amounts: [ada("1")] }] }],
    [{ periods: [{ month: "2026-01", amounts: [] }] }],
    [{ periods: [{ month: "2026-01", amounts: [ada("0")] }] }],
    [{ periods: [{ month: "2026-01", amounts: [ada("-1")] }] }],
    [{ periods: [{ month: "2026-01", amounts: [ada("1"), ada("2")] }] }],
    [{ periods: [{ month: "2026-01", amounts: [ada("1")] }, { month: "2026-01", amounts: [ada("2")] }] }],
  ])("rejects invalid input %j before loading the commitment", async (body) => {
    const res = await POST(request(body), context());
    expect(res.status).toBe(400);
    expect(mocks.commitment).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves nothing when one period cannot be scaled or a token is unknown", async () => {
    const tooFine = await POST(request({
      periods: [{ month: "2026-01", amounts: [ada("1")] }, { month: "2026-02", amounts: [ada("1.0000001")] }],
    }), context());
    expect(tooFine.status).toBe(400);
    mocks.tokens.mockRejectedValueOnce(new BadRequestError("No token with the unit … exists on this network"));
    const unknown = await POST(request({ periods: [{ month: "2026-01", amounts: [{ unit: "ab".repeat(30), amount: "1" }] }] }), context());
    expect(unknown.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("surfaces a refusal of the save", async () => {
    mocks.save.mockRejectedValue(new BadRequestError("Quarterly periods start in January, April, July or October"));
    const res = await POST(request({ periods: [{ month: "2026-02", amounts: [ada("1")] }] }), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Quarterly periods start in January, April, July or October" });
  });
});

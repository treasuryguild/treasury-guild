import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  source: vi.fn(),
  tokens: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/funding/access", () => ({ requireFundingSourceAdmin: mocks.source, resolveFundingTokens: mocks.tokens }));
vi.mock("@/lib/db/funding", () => ({ createFundingCommitment: mocks.create }));
import { POST } from "./route";

const SOURCE = "30000000-0000-4000-8000-000000000001";
const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
const context = { params: Promise.resolve({}) };
const request = (value: object) => new Request("http://localhost/api/funding/commitments", {
  method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1admin" });
  mocks.source.mockResolvedValue({ id: SOURCE, community_id: "com" });
  mocks.tokens.mockResolvedValue(new Map([["lovelace", { ticker: "ADA", decimals: 6 }], [AGIX, { ticker: "AGIX", decimals: 8 }]]));
  mocks.create.mockImplementation(async (row: object) => ({ id: "new", ...row }));
});

describe("POST /api/funding/commitments", () => {
  it("scales amounts with the token's real decimals", async () => {
    const res = await POST(request({
      sourceId: SOURCE, name: "Monthly allocation", kind: "recurring", cadence: "monthly", startsOn: "2026-01", endsOn: "2026-12",
      amounts: [{ unit: "lovelace", amount: "20000" }, { unit: AGIX, amount: "211800.72389063" }],
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "recurring", cadence: "monthly", starts_on: "2026-01-01", ends_on: "2026-12-01", community_id: "com",
      amounts: [
        { unit: "lovelace", amount: "20000000000", asset_label: "ADA", decimals: 6 },
        { unit: AGIX, amount: "21180072389063", asset_label: "AGIX", decimals: 8 },
      ],
    }));
  });

  it("creates a schedule with no amounts of its own", async () => {
    await POST(request({ sourceId: SOURCE, name: "Release plan", kind: "schedule", cadence: "monthly" }), context);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ kind: "schedule", amounts: [], starts_on: null }));
  });

  it("refuses bad shapes, too many decimals, unknown tokens and non-admins", async () => {
    expect((await POST(request({ sourceId: SOURCE, name: "X", kind: "one_off", cadence: "monthly", amounts: [{ unit: "lovelace", amount: "1" }] }), context)).status).toBe(400);
    expect((await POST(request({ sourceId: SOURCE, name: "X", kind: "recurring", cadence: "quarterly", startsOn: "2026-02", amounts: [{ unit: "lovelace", amount: "1" }] }), context)).status).toBe(400);
    expect((await POST(request({ sourceId: SOURCE, name: "X", kind: "one_off", amounts: [{ unit: "lovelace", amount: "1.0000001" }] }), context)).status).toBe(400);
    mocks.tokens.mockRejectedValueOnce(new BadRequestError("No token with the unit … exists on this network"));
    expect((await POST(request({ sourceId: SOURCE, name: "X", kind: "one_off", amounts: [{ unit: "ab".repeat(30), amount: "1" }] }), context)).status).toBe(400);
    mocks.source.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await POST(request({ sourceId: SOURCE, name: "X", kind: "one_off", amounts: [{ unit: "lovelace", amount: "1" }] }), context)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

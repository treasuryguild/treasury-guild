import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyImportPlan } from "@/lib/legacyHistory/types";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  wallet: vi.fn(),
  importRow: vi.fn(),
  rate: vi.fn(),
  plan: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/legacyHistory/access", () => ({
  requireLegacyWalletAdmin: mocks.wallet,
  requireLegacyImportAdmin: mocks.importRow,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/legacyHistory/run", () => ({ planLegacyUpload: mocks.plan }));
import { POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WALLET_ID = "30000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/legacy-history/preview", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

const row = (line: number) => ({
  line, recipientRef: "f39ntm", task: "T", paidOn: "2026-09-15", budgetMonth: "2026-09-01", workgroupRef: "gov",
  workgroupId: "w", amounts: [], dedupeKey: "k", status: "new" as const, duplicateOfLine: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1admin" });
  mocks.wallet.mockResolvedValue({ id: WALLET_ID, community_id: COMMUNITY, name: "Old" });
});

describe("POST /api/legacy-history/preview", () => {
  it("returns the plan with long clean runs cut short", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(i + 2));
    rows[140] = { ...rows[140]!, status: "invalid" as never };
    const plan: LegacyImportPlan = {
      tickers: [], workgroups: [], rows, issues: [],
      counts: { lines: 150, new: 149, duplicates: 0, fileDuplicates: 0, invalid: 1 }, totals: [], ready: false,
    };
    mocks.plan.mockResolvedValue(plan);
    const res = await POST(request({
      communityId: COMMUNITY, legacyWalletId: WALLET_ID, fileName: "f.csv", csv: "x", tickerUnits: { AGIX: "ab".repeat(30) },
    }), context);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowsTruncated).toBe(true);
    expect(body.rows).toHaveLength(101);
    expect(body.rows.at(-1).line).toBe(142);
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ tickerUnits: { AGIX: "ab".repeat(30) } }));
  });

  it("refuses a token unit that is not hex", async () => {
    const res = await POST(request({
      communityId: COMMUNITY, legacyWalletId: WALLET_ID, fileName: "f.csv", csv: "x", tickerUnits: { AGIX: "not-a-unit" },
    }), context);
    expect(res.status).toBe(400);
    expect(mocks.plan).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyIssueCode } from "@/lib/constants";
import { ForbiddenError } from "@/lib/errors";
import type { LegacyImportPlan, PlannedRow } from "@/lib/legacyHistory/types";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  wallet: vi.fn(),
  importRow: vi.fn(),
  rate: vi.fn(),
  plan: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/legacyHistory/access", () => ({
  requireLegacyWalletAdmin: mocks.wallet,
  requireLegacyImportAdmin: mocks.importRow,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/legacyHistory/run", () => ({ planLegacyUpload: mocks.plan }));
vi.mock("@/lib/db/legacyHistory", () => ({ importLegacyHistory: mocks.rpc }));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WALLET_ID = "30000000-0000-4000-8000-000000000001";
const IMPORT_ID = "40000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/legacy-history/import", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });
const upload = (extra: object = {}) => ({
  communityId: COMMUNITY,
  legacyWalletId: WALLET_ID,
  fileName: "history.csv",
  csv: "userId,ADA,task,date,workgroup\nf39ntm,80,Docs,15.09.2026,gov",
  ...extra,
});

const ROW: PlannedRow = {
  line: 2,
  recipientRef: "f39ntm",
  task: "Docs",
  paidOn: "2026-09-15",
  budgetMonth: "2026-09-01",
  workgroupRef: "gov",
  workgroupId: "20000000-0000-4000-8000-000000000001",
  amounts: [{ ticker: "ADA", raw: "80", unit: "lovelace", decimals: 6, quantity: "80000000" }],
  dedupeKey: "a".repeat(64),
  status: "new",
  duplicateOfLine: null,
};
const READY: LegacyImportPlan = {
  tickers: [{ ticker: "ADA", status: "resolved", unit: "lovelace", decimals: 6, source: "ada" }],
  workgroups: [],
  rows: [ROW, { ...ROW, line: 3, status: "duplicate" }],
  issues: [],
  counts: { lines: 2, new: 1, duplicates: 1, fileDuplicates: 0, invalid: 0 },
  totals: [],
  ready: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.wallet.mockResolvedValue({ id: WALLET_ID, community_id: COMMUNITY, name: "Old" });
  mocks.importRow.mockResolvedValue({ id: IMPORT_ID, legacy_wallet_id: WALLET_ID, community_id: COMMUNITY });
  mocks.plan.mockResolvedValue(READY);
  mocks.rpc.mockResolvedValue({ importId: IMPORT_ID, inserted: 1, skipped: 0, replaced: false });
});

describe("POST /api/legacy-history/import", () => {
  it("is admin-only and writes nothing otherwise", async () => {
    mocks.wallet.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request(upload()), context);
    expect(res.status).toBe(403);
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("writes the server's own plan, never rows sent with the request", async () => {
    const res = await POST(request(upload({ rows: [{ lineNo: 99, task: "forged" }] })), context);
    expect(res.status).toBe(200);
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({
      communityId: COMMUNITY, walletId: WALLET_ID, replaceImportId: null, includeDuplicates: false,
    }));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const args = mocks.rpc.mock.calls[0]![0];
    expect(args.rows.map((r: { lineNo: number }) => r.lineNo)).toEqual([2]);
    expect(args).toMatchObject({ walletId: WALLET_ID, actor: ADMIN, fileName: "history.csv", includeDuplicates: false });
    expect(mocks.rate).toHaveBeenCalledWith("legacyHistory", ADMIN);
  });

  it("includes duplicates only when asked", async () => {
    await POST(request(upload({ includeDuplicates: true })), context);
    const args = mocks.rpc.mock.calls[0]![0];
    expect(args.rows.map((r: { lineNo: number }) => r.lineNo)).toEqual([2, 3]);
    expect(args.includeDuplicates).toBe(true);
  });

  it("refuses a plan that is not ready", async () => {
    mocks.plan.mockResolvedValue({
      ...READY,
      ready: false,
      issues: [{ code: LegacyIssueCode.UnresolvedTicker, line: null, severity: "error", column: "AGIX" }],
    });
    const res = await POST(request(upload()), context);
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps a wallet or a replaced import of another community out", async () => {
    mocks.wallet.mockResolvedValue({ id: WALLET_ID, community_id: "10000000-0000-4000-8000-000000000009", name: "Old" });
    expect((await POST(request(upload()), context)).status).toBe(404);

    mocks.wallet.mockResolvedValue({ id: WALLET_ID, community_id: COMMUNITY, name: "Old" });
    mocks.importRow.mockResolvedValue({ id: IMPORT_ID, legacy_wallet_id: "30000000-0000-4000-8000-000000000009", community_id: COMMUNITY });
    expect((await POST(request(upload({ replaceImportId: IMPORT_ID })), context)).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes a replace of this wallet's import through", async () => {
    await POST(request(upload({ replaceImportId: IMPORT_ID })), context);
    expect(mocks.rpc.mock.calls[0]![0].replaceImportId).toBe(IMPORT_ID);
  });
});

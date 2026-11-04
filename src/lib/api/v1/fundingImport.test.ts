import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { ConflictError, ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  rateLimit: vi.fn(),
  registry: vi.fn(),
  treasuries: vi.fn(),
  tokens: vi.fn(),
  store: vi.fn(),
  loadPayload: vi.fn(),
  deletePayload: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry }));
vi.mock("@/lib/db/treasuries", () => ({ loadCommunityTreasuries: mocks.treasuries }));
vi.mock("@/lib/funding/access", () => ({
  resolveFundingTokens: mocks.tokens,
  requireFundingCommitmentAdmin: vi.fn(),
}));
vi.mock("@/lib/db/agentImports", () => ({
  storeAgentImportPayload: mocks.store,
  loadAgentImportPayload: mocks.loadPayload,
  deleteAgentImportPayload: mocks.deletePayload,
  importAgentFundingSchedule: mocks.write,
}));

import { confirmDraft } from "./drafts";
import { callEndpoint } from "./endpoint";
import { previewFundingSchedule } from "./fundingImport";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["imports:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1 };
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };
const CSV = "month,ada\n2026-03,12.5\n";

let saved: { csv: string; mapping: unknown } | null = null;
let decimals = 6;

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.CRON_SECRET = "cron-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  saved = null;
  decimals = 6;
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("admin");
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.registry.mockResolvedValue([]);
  mocks.treasuries.mockResolvedValue([]);
  mocks.tokens.mockImplementation(async (_id: string, units: string[]) =>
    new Map(units.map((unit) => [unit, { ticker: "ADA", decimals }])));
  mocks.store.mockImplementation(async (row: { csv: string; mapping: unknown }) => {
    saved = { csv: row.csv, mapping: row.mapping };
    return { id: "22222222-2222-4222-8222-222222222222", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  });
  mocks.loadPayload.mockImplementation(async () => saved && ({
    id: "22222222-2222-4222-8222-222222222222",
    community_id: "c1",
    wallet: "addr_w",
    kind: "funding_schedule",
    csv: saved.csv,
    mapping: saved.mapping,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }));
  mocks.deletePayload.mockImplementation(async () => { saved = null; });
  mocks.write.mockResolvedValue({ commitmentId: "cm1", sourceId: "s1", periods: 1, created: true });
});

const preview = (input: Record<string, unknown> = {}) => callEndpoint(previewFundingSchedule, caller, {
  community: "signius", csv: CSV, cadence: "monthly", sourceName: "Catalyst", commitmentName: "Wave 1", ...input,
});
const confirm = (draftToken: string) => callEndpoint(confirmDraft, caller, { draftToken });

describe("funding_schedule_preview", () => {
  it("refuses a member who holds the scope", async () => {
    mocks.role.mockResolvedValue("member");
    await expect(preview()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("asks which token an unmapped column is and mints nothing", async () => {
    const res = await preview({ csv: "month,widgets\n2026-03,12.5\n" }) as { ready: boolean; draftToken?: string; questions: { message: string }[] };
    expect(res.ready).toBe(false);
    expect(res.draftToken).toBeUndefined();
    expect(res.questions.some((q) => /widgets/i.test(q.message))).toBe(true);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("stores the original file and a draft once the schedule is settled", async () => {
    const res = await preview() as { ready: boolean; draftToken: string; periods: number; totals: { amount: string }[] };
    expect(res.ready).toBe(true);
    expect(res.periods).toBe(1);
    expect(res.totals[0]?.amount).toBe("12.5");
    expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ kind: "funding_schedule", csv: CSV }));
    expect(mocks.rateLimit).toHaveBeenCalledWith("fundingImport", "addr_w");
    expect(mocks.write).not.toHaveBeenCalled();
  });
});

describe("funding_schedule_import confirm", () => {
  it("writes the periods and drops the file", async () => {
    const previewed = await preview() as { draftToken: string };
    const res = await confirm(previewed.draftToken) as { created: boolean };
    expect(res.created).toBe(true);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({
      communityId: "c1",
      sourceName: "Catalyst",
      commitmentName: "Wave 1",
      cadence: "monthly",
    }));
    expect(mocks.write.mock.calls[0]![0].periods).toEqual([
      expect.objectContaining({ startsOn: "2026-03-01" }),
    ]);
    expect(mocks.deletePayload).toHaveBeenCalled();
  });

  it("refuses when the totals no longer match the preview", async () => {
    const previewed = await preview() as { draftToken: string };
    decimals = 8;
    await expect(confirm(previewed.draftToken)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("reads the schedule back when the file is already gone", async () => {
    const previewed = await preview() as { draftToken: string };
    await confirm(previewed.draftToken);
    mocks.write.mockResolvedValue({ commitmentId: "cm1", sourceId: "s1", periods: 1, created: false });
    const again = await confirm(previewed.draftToken) as { created: boolean };
    expect(again.created).toBe(false);
    expect(mocks.write.mock.calls.at(-1)![0].periods).toEqual([]);
  });
});

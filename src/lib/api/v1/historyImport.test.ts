import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { ConflictError, ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  rateLimit: vi.fn(),
  wallets: vi.fn(),
  wallet: vi.fn(),
  context: vi.fn(),
  governance: vi.fn(),
  plan: vi.fn(),
  store: vi.fn(),
  loadPayload: vi.fn(),
  deletePayload: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/api/v1/importAdmin", () => ({
  requireImportAdmin: vi.fn(async (_caller: unknown, slug: string) => {
    const community = await mocks.community(slug);
    const role = await mocks.role();
    if (role !== "admin" && role !== "owner") throw new ForbiddenError("Only a community admin can import payment history or a funding schedule");
    return community;
  }),
}));
vi.mock("@/lib/legacyHistory/access", () => ({ requireLegacyAddressNetwork: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/legacyHistory", () => ({
  loadLegacyWallets: mocks.wallets,
  loadLegacyWallet: mocks.wallet,
  loadLegacyImportContext: mocks.context,
}));
vi.mock("@/lib/db/governance", () => ({ loadGovernanceSettings: mocks.governance }));
vi.mock("@/lib/legacyHistory/run", () => ({ planAgentHistory: mocks.plan }));
vi.mock("@/lib/db/agentImports", () => ({
  storeAgentImportPayload: mocks.store,
  loadAgentImportPayload: mocks.loadPayload,
  deleteAgentImportPayload: mocks.deletePayload,
}));
const loadByDraft = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/legacyHistory/agentConfirm", () => ({
  stageAgentLegacyHistory: mocks.write,
  loadLegacyImportByDraft: loadByDraft,
}));

import { confirmDraft } from "./drafts";
import { callEndpoint } from "./endpoint";
import { previewPaymentHistory } from "./historyImport";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["imports:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1 };
const COMMUNITY = { id: "c1", slug: "swarm", name: "Swarm", network: 0, visibility: "private" };
const WALLET_ADDR = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";
const PAYEE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const TX = "f".repeat(64);
const CSV = `userId,ADA,task,date,workgroup,txHash,outputIndex\n${PAYEE},10,Poster,2024-01-15,Design,${TX},0\n`;
const NAME_CSV = `Name,ADA,task,date,workgroup,txHash,outputIndex\nAlice,10,Poster,2024-01-15,Design,${TX},0\n`;
const PLAN = {
  tickers: [{ ticker: "ADA", status: "resolved", unit: "lovelace", decimals: 6 }],
  workgroups: [{ name: "Design", status: "resolved", workgroup: { id: "wg-1", name: "Design", archived: false } }],
  rows: [{
    status: "new", line: 2, dedupeKey: "a".repeat(64), budgetMonth: "2024-01-01",
    workgroupId: "wg-1", workgroupRef: "design", recipientRef: "addr1qx2fxv2umy",
    task: "Poster", paidOn: "2024-01-15",
    amounts: [{ unit: "lovelace", ticker: "ADA", decimals: 6, quantity: "10000000" }],
  }],
  issues: [],
  counts: { lines: 1, new: 1, duplicates: 0, fileDuplicates: 0, invalid: 0 },
  totals: [{ workgroupId: "wg-1", unit: "lovelace", ticker: "ADA", amount: "10000000", decimals: 6 }],
  ready: true,
};

let saved: { csv: string; mapping: unknown } | null = null;

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.CRON_SECRET = "cron-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  saved = null;
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("admin");
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.wallets.mockResolvedValue([]);
  mocks.context.mockResolvedValue({ workgroups: [], aliases: new Map() });
  mocks.governance.mockResolvedValue({ enabled: false });
  mocks.plan.mockResolvedValue(PLAN);
  mocks.store.mockImplementation(async (row: { csv: string; mapping: unknown }) => {
    saved = { csv: row.csv, mapping: row.mapping };
    return { id: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  });
  mocks.loadPayload.mockImplementation(async () => saved && ({
    id: "11111111-1111-4111-8111-111111111111",
    community_id: "c1",
    wallet: "addr_w",
    kind: "legacy_history",
    csv: saved.csv,
    mapping: saved.mapping,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }));
  mocks.deletePayload.mockImplementation(async () => { saved = null; });
  loadByDraft.mockResolvedValue(null);
  mocks.write.mockResolvedValue({
    importId: "i1", legacyWalletId: "w1", state: "pending_signatures", planHash: "ph", signatures: 0, required: 1, skipped: 0, created: true,
  });
});

const preview = (input: Record<string, unknown> = {}) =>
  callEndpoint(previewPaymentHistory, caller, {
    community: "swarm", csv: CSV, walletName: "Old wallet", walletAddress: WALLET_ADDR, ...input,
  });
const confirm = (draftToken: string) => callEndpoint(confirmDraft, caller, { draftToken });

describe("payment_history_preview", () => {
  it("refuses a member who holds the scope", async () => {
    mocks.role.mockResolvedValue("member");
    await expect(preview()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("asks about a name column and mints nothing", async () => {
    const res = await preview({ csv: NAME_CSV }) as { ready: boolean; draftToken?: string; questions: { message: string }[] };
    expect(res.ready).toBe(false);
    expect(res.draftToken).toBeUndefined();
    expect(res.questions.some((q) => /do not invent/i.test(q.message))).toBe(true);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("stores the original file and a draft once the plan is ready", async () => {
    const res = await preview() as { ready: boolean; draftToken: string; counts: { new: number }; totals: { amount: string }[] };
    expect(res.ready).toBe(true);
    expect(res.draftToken).toEqual(expect.any(String));
    expect(res.counts.new).toBe(1);
    expect(res.totals[0]?.amount).toBe("10");
    expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ kind: "legacy_history", csv: CSV, wallet: "addr_w" }));
    expect(mocks.rateLimit).toHaveBeenCalledWith("legacyHistory", "addr_w");
    expect(mocks.write).not.toHaveBeenCalled();
  });
});

describe("legacy_history_import confirm", () => {
  it("writes the planned rows and drops the file", async () => {
    const previewed = await preview() as { draftToken: string };
    const res = await confirm(previewed.draftToken) as { created: boolean; inserted: number };
    expect(res.created).toBe(true);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({
      draftId: expect.any(String),
      communityId: "c1",
      actor: "addr_w",
      walletName: "Old wallet",
      walletAddress: WALLET_ADDR,
      skipExisting: true,
    }));
    expect(mocks.write.mock.calls[0]![0].rows).toHaveLength(1);
    expect(mocks.deletePayload).toHaveBeenCalled();
    expect(saved).toBeNull();
  });

  it("refuses when the plan no longer matches the preview", async () => {
    const previewed = await preview() as { draftToken: string };
    mocks.plan.mockResolvedValue({ ...PLAN, counts: { ...PLAN.counts, new: 2 } });
    await expect(confirm(previewed.draftToken)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.deletePayload).not.toHaveBeenCalled();
  });

  it("reads the import back when the file is already gone", async () => {
    const previewed = await preview() as { draftToken: string };
    await confirm(previewed.draftToken);
    loadByDraft.mockResolvedValue({
      id: "i1",
      community_id: "c1",
      legacy_wallet_id: "w1",
      state: "pending_signatures",
      plan_hash: "ph",
      line_count: 1,
    });
    const again = await confirm(previewed.draftToken) as { created: boolean };
    expect(again.created).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChainImportStatus } from "@/lib/constants";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  run: vi.fn(),
  external: vi.fn(),
  treasury: vi.fn(),
  mark: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/chainImport/run", () => ({ importExternalTxs: mocks.run }));
vi.mock("@/lib/db/chainImport", () => ({
  loadExternalTx: mocks.external,
  loadImportTreasury: mocks.treasury,
  markExternalTx: mocks.mark,
}));
import { POST } from "./route";

const WALLET = "addr_test1admin";
const HASH = "ab".repeat(32);
const TREASURY = { id: "t1", community_id: "c1", address: "addr_test1treasury", network: 0 };
const ISSUES = [{ code: "workgroup_missing", name: "Docs" }];
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/chain-import/resolve", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.external.mockResolvedValue({ tx_hash: HASH, treasury_id: "t1", import_issues: ISSUES });
  mocks.treasury.mockResolvedValue(TREASURY);
  mocks.run.mockResolvedValue({ imported: [HASH], blocked: [] });
});

describe("POST /api/chain-import/resolve", () => {
  it("is for admins of the transaction's own community", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({ txHash: HASH, action: "retry" }), context);
    expect(res.status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith("c1", WALLET);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("says so when the transaction is no longer waiting", async () => {
    mocks.external.mockResolvedValue(null);
    const res = await POST(request({ txHash: HASH, action: "retry" }), context);
    expect(res.status).toBe(404);
  });

  it("retries exactly that transaction", async () => {
    const res = await POST(request({ txHash: HASH.toUpperCase(), action: "retry" }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: [HASH], blocked: [] });
    expect(mocks.run).toHaveBeenCalledWith(TREASURY, { hashes: [HASH], asNewNumbers: undefined, limit: 1 });
  });

  it("imports the chosen tasks under new numbers", async () => {
    await POST(request({ txHash: HASH, action: "new_number", chainNumbers: [51] }), context);
    expect(mocks.run).toHaveBeenCalledWith(TREASURY, { hashes: [HASH], asNewNumbers: [51], limit: 1 });

    const none = await POST(request({ txHash: HASH, action: "new_number" }), context);
    expect(none.status).toBe(400);
  });

  it("ignores without importing, keeping the reasons", async () => {
    const res = await POST(request({ txHash: HASH, action: "ignore" }), context);
    expect(res.status).toBe(200);
    expect(mocks.mark).toHaveBeenCalledWith(HASH, ChainImportStatus.Ignored, ISSUES);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([{}, { txHash: "nope", action: "retry" }, { txHash: HASH, action: "delete" }])(
    "rejects invalid input %j",
    async (body) => {
      const res = await POST(request(body), context);
      expect(res.status).toBe(400);
    },
  );
});

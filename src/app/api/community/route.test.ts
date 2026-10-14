import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  requireAdmin: vi.fn(),
  registry: vi.fn(),
  walletAssets: vi.fn(),
  update: vi.fn(),
  treasuries: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry }));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.walletAssets }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  serviceClient: () => ({
    from: (table: string) => ({
      update: (patch: unknown) => ({ eq: () => mocks.update(table, patch) }),
      select: () => ({ eq: () => mocks.treasuries() }),
    }),
  }),
}));
import { PATCH } from "./route";

const UNIT = "a".repeat(56) + "48454c4c4f";
const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/community", {
  method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.requireAdmin.mockResolvedValue(undefined);
  mocks.registry.mockResolvedValue([]);
  mocks.update.mockResolvedValue({ error: null });
  mocks.treasuries.mockResolvedValue({ data: [], error: null });
});

describe("community settings API", () => {
  it("denies non-admins before writing", async () => {
    mocks.requireAdmin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await PATCH(request({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: "lovelace" }), context)).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("stores ADA as the main spending token without consulting the chain", async () => {
    expect((await PATCH(request({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: "lovelace" }), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("communities", { spending_unit: "lovelace" });
    expect(mocks.registry).not.toHaveBeenCalled();
    expect(mocks.walletAssets).not.toHaveBeenCalled();
  });

  it("accepts a token the community has paid out without reading wallets", async () => {
    mocks.registry.mockResolvedValue([{ fieldName: "HELLO", unit: UNIT, decimals: 0 }]);
    expect((await PATCH(request({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: UNIT }), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("communities", { spending_unit: UNIT });
    expect(mocks.walletAssets).not.toHaveBeenCalled();
  });

  it("accepts a token held by any treasury wallet, on that wallet's network", async () => {
    mocks.treasuries.mockResolvedValue({ data: [
      { address: "addr_test1_first", network: 0 },
      { address: "addr1_second", network: 1 },
    ], error: null });
    mocks.walletAssets
      .mockRejectedValueOnce(new Error("koios down"))
      .mockResolvedValueOnce({ lovelace: 0n, utxoCount: 1, tokens: [{ unit: UNIT }] });
    expect((await PATCH(request({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: UNIT }), context)).status).toBe(200);
    expect(mocks.walletAssets).toHaveBeenCalledWith(0, "addr_test1_first");
    expect(mocks.walletAssets).toHaveBeenCalledWith(1, "addr1_second");
    expect(mocks.update).toHaveBeenCalledWith("communities", { spending_unit: UNIT });
  });

  it("rejects a token no treasury holds and nothing was paid in", async () => {
    mocks.treasuries.mockResolvedValue({ data: [{ address: "addr1_only", network: 1 }], error: null });
    mocks.walletAssets.mockResolvedValue({ lovelace: 0n, utxoCount: 1, tokens: [{ unit: "b".repeat(56) }] });
    const result = await PATCH(request({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: UNIT }), context);
    expect(result.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed unit without touching the database", async () => {
    expect((await PATCH(request({ communityId: "10000000-0000-4000-8000-000000000001", spendingUnit: "ADA" }), context)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

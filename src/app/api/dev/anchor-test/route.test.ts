import { serializeAddress } from "@meshsdk/core-cst";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env.server";
import type * as TreasuriesModule from "@/lib/db/treasuries";
import type * as TxModule from "@/lib/tx";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), devWallets: vi.fn(), list: vi.fn(), context: vi.fn(), noPending: vi.fn(), withTx: vi.fn(),
  build: vi.fn(), script: vi.fn(), provider: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/env.server", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  devWallets: mocks.devWallets,
}));
vi.mock("@/lib/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  loadBuildContext: mocks.context,
}));
vi.mock("@/lib/db/transactions", () => ({ assertNoPendingTx: mocks.noPending, withTransactionRow: mocks.withTx }));
vi.mock("@/lib/db/treasuries", async (importOriginal) => ({
  ...(await importOriginal<typeof TreasuriesModule>()),
  listTreasuriesForWallet: mocks.list,
}));
vi.mock("@/lib/cardano/anchorBuilder", () => ({ buildAnchorTx: mocks.build }));
vi.mock("@/lib/treasury", () => ({ resolveTreasuryScript: mocks.script }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));
import { GET, POST } from "./route";

const DEV = "addr_test1dev";
const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
const TREASURY = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";
const HASH = "f".repeat(64);
const PROVIDER = { name: "koios-preprod" };
const context = { params: Promise.resolve({}) };
const get = () => GET(new Request("http://localhost/api/dev/anchor-test"), context);
const post = (body: object = { treasuryId: TREASURY_ID }, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/dev/anchor-test", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
}), context);

const plainTreasury = {
  id: TREASURY_ID, community_id: "community", address: TREASURY, network: 0,
  template: "plain", script_type: "atLeast", required: 2, lock_slot: null, lock_until: null,
  recovery_script_type: null, recovery_required: null, cosigner_kind: null,
};
const SIGNERS = [{ wallet_address: DEV, signer_group: "base" }];
const buildContext = (overrides: object = {}) => ({
  treasury: plainTreasury, signers: SIGNERS, role: "member", isSigner: true, callerGroups: new Set(["base"]),
  communitySlug: "signius", network: 0, ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: DEV });
  mocks.devWallets.mockReturnValue([DEV, "addr_test1lead"]);
  mocks.list.mockResolvedValue([]);
  mocks.context.mockResolvedValue(buildContext());
  mocks.noPending.mockResolvedValue(undefined);
  mocks.script.mockReturnValue({ address: TREASURY, scriptCbor: "8200" });
  mocks.provider.mockReturnValue(PROVIDER);
  mocks.build.mockResolvedValue({ unsignedTxHex: "84a0", txHash: HASH });
  mocks.withTx.mockImplementation(async (_row: unknown, fn: (tx: { id: string }) => Promise<unknown>) => fn({ id: "tx-1" }));
});

function nothingBuilt() {
  expect(mocks.build).not.toHaveBeenCalled();
  expect(mocks.withTx).not.toHaveBeenCalled();
}

describe("developer access", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("refuses wallets that are not on the allowlist, and everyone when it is empty", async () => {
    mocks.session.mockResolvedValue({ wallet: "addr_test1stranger" });
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Developer access required" });
    expect((await post()).status).toBe(403);
    mocks.session.mockResolvedValue({ wallet: DEV });
    mocks.devWallets.mockReturnValue([]);
    expect((await get()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    nothingBuilt();
  });
});

describe("GET /api/dev/anchor-test", () => {
  it("lists the treasuries of the developer's own communities", async () => {
    mocks.list.mockResolvedValue([
      { id: TREASURY_ID, name: "Main", network: 0, communities: { name: "Signius", slug: "signius" } },
      { id: "t2", name: "Ops", network: 1, communities: { name: "Guild", slug: "guild" } },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ treasuries: [
      { id: TREASURY_ID, name: "Main", network: 0, communityName: "Signius", slug: "signius" },
      { id: "t2", name: "Ops", network: 1, communityName: "Guild", slug: "guild" },
    ] });
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(DEV);
  });
});

describe("POST /api/dev/anchor-test", () => {
  it("builds the phase-0 test record as a pending anchor transaction on the treasury's own network", async () => {
    const record = { v: 1, src: "treasury-guild", c: "signius", test: 1 };
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txId: "tx-1", txHash: HASH, slug: "signius", record });
    expect(mocks.context).toHaveBeenCalledWith(TREASURY_ID, DEV);
    expect(mocks.noPending).toHaveBeenCalledWith(TREASURY_ID);
    expect(mocks.script).toHaveBeenCalledWith(plainTreasury, SIGNERS);
    expect(mocks.provider).toHaveBeenCalledWith(0);
    expect(mocks.build).toHaveBeenCalledExactlyOnceWith({
      treasuryAddress: TREASURY, scriptCbor: "8200", network: 0, provider: PROVIDER, record,
      message: "Treasury Guild anchor test: signius", validFromSlot: null,
    });
    expect(mocks.withTx).toHaveBeenCalledExactlyOnceWith({
      treasury_id: TREASURY_ID, kind: "anchor", spending_path: "base", tx_cbor: "84a0", tx_hash: HASH,
      description: "Anchor test (metadata only)", created_by: DEV,
    }, expect.any(Function));
  });

  it("builds on mainnet for a mainnet community's treasury, never on a deployment default", async () => {
    const MAINNET_TREASURY = serializeAddress({ scriptHash: "e".repeat(56) }, 1);
    mocks.context.mockResolvedValue(buildContext({ treasury: { ...plainTreasury, address: MAINNET_TREASURY, network: 1 }, network: 1 }));
    expect((await post()).status).toBe(200);
    expect(mocks.provider).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ treasuryAddress: MAINNET_TREASURY, network: 1 }));
  });

  it("refuses a cross-site request and a malformed body before loading the treasury", async () => {
    expect((await post({ treasuryId: TREASURY_ID }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post({})).status).toBe(400);
    expect((await post({ treasuryId: "nope" })).status).toBe(400);
    expect((await post({ treasuryId: TREASURY_ID, path: "sideways" })).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
    nothingBuilt();
  });

  it("passes on a missing treasury and a developer outside its community", async () => {
    mocks.context.mockRejectedValueOnce(new NotFoundError("Treasury not found"));
    expect((await post()).status).toBe(404);
    mocks.context.mockRejectedValueOnce(new ForbiddenError("Not a community member"));
    expect((await post()).status).toBe(403);
    expect(mocks.noPending).not.toHaveBeenCalled();
    nothingBuilt();
  });

  it("refuses a developer who is neither an admin nor a base signer of the treasury", async () => {
    for (const groups of [[], ["recovery"], ["cosigner"]]) {
      mocks.context.mockResolvedValue(buildContext({ isSigner: false, callerGroups: new Set(groups) }));
      const res = await post();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Only community admins or treasury signers can build from this treasury" });
    }
    expect(mocks.noPending).not.toHaveBeenCalled();
    nothingBuilt();
  });

  it("lets an admin who signs nothing build", async () => {
    mocks.context.mockResolvedValue(buildContext({ role: "admin", isSigner: false, callerGroups: new Set() }));
    expect((await post()).status).toBe(200);
  });

  it("passes on the one-pending-transaction conflict", async () => {
    mocks.noPending.mockRejectedValue(new ConflictError("A pending transaction already exists for this treasury. Submit or reject it first."));
    expect((await post()).status).toBe(409);
    nothingBuilt();
  });

  it("refuses a path the template lacks, and the recovery path: an anchor is never a recovery payment", async () => {
    expect((await post({ treasuryId: TREASURY_ID, path: "cosigned" })).status).toBe(400);
    mocks.context.mockResolvedValue(buildContext({
      treasury: { ...plainTreasury, template: "clawback", recovery_script_type: "any", recovery_required: 1, lock_slot: 1, lock_until: "2020-01-01T00:00:00.000Z" },
      role: "admin",
    }));
    expect((await post({ treasuryId: TREASURY_ID, path: "recovery" })).status).toBe(400);
    expect(mocks.noPending).not.toHaveBeenCalled();
    nothingBuilt();
  });

  it("builds nothing from a lock-until treasury before its date, and from its lock slot afterwards", async () => {
    const lockUntil = (ms: number) => ({ ...plainTreasury, template: "lock_until", lock_slot: 4242, lock_until: new Date(Date.now() + ms).toISOString() });
    mocks.context.mockResolvedValue(buildContext({ treasury: lockUntil(86_400_000) }));
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/locked until/);
    nothingBuilt();
    mocks.context.mockResolvedValue(buildContext({ treasury: lockUntil(-86_400_000) }));
    expect((await post()).status).toBe(200);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ validFromSlot: 4242 }));
  });

  it("takes the co-signed path of a co-signer treasury by default, and the bypass when asked", async () => {
    mocks.context.mockResolvedValue(buildContext({ treasury: { ...plainTreasury, template: "cosigner", cosigner_kind: "app" } }));
    expect((await post()).status).toBe(200);
    expect(mocks.withTx).toHaveBeenLastCalledWith(expect.objectContaining({ spending_path: "cosigned" }), expect.any(Function));
    expect((await post({ treasuryId: TREASURY_ID, path: "bypass" })).status).toBe(200);
    expect(mocks.withTx).toHaveBeenLastCalledWith(expect.objectContaining({ spending_path: "bypass" }), expect.any(Function));
  });
});

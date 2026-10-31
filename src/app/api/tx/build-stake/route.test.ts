import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TxModule from "@/lib/tx";
import { ConflictError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  context: vi.fn(),
  noPending: vi.fn(),
  withTx: vi.fn(),
  sdk: vi.fn(),
  status: vi.fn(),
  lookup: vi.fn(),
  build: vi.fn(),
  provider: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  loadBuildContext: mocks.context,
}));
vi.mock("@/lib/db/transactions", () => ({
  assertNoPendingTx: mocks.noPending,
  withTransactionRow: mocks.withTx,
}));
vi.mock("@/lib/cardano/sdkTreasury", () => ({ requireSdkStake: mocks.sdk }));
vi.mock("@/lib/cardano/koios", () => ({
  fetchStakeAccountStatus: mocks.status,
  lookupStakePool: mocks.lookup,
}));
vi.mock("@/lib/cardano/stakeBuilder", () => ({ buildStakeTx: mocks.build }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));

import { POST } from "./route";

const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
const HASH = "f".repeat(64);
const context = { params: Promise.resolve({}) };
const request = (body: object, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/tx/build-stake", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
const post = (body: object, headers?: Record<string, string>) =>
  POST(request(body, headers), context);

const plainTreasury = {
  id: TREASURY_ID,
  community_id: "community",
  address: "addr_test1treasury",
  network: 0,
  template: "plain",
  script_type: "atLeast",
  required: 2,
  lock_slot: null,
  lock_until: null,
  recovery_script_type: null,
  recovery_required: null,
  cosigner_kind: null,
  archived_at: null,
};
const buildContext = (overrides: object = {}) => ({
  treasury: plainTreasury,
  signers: [],
  role: "member",
  isSigner: true,
  callerGroups: new Set(["base"]),
  communitySlug: "signius",
  network: 0,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1signer" });
  mocks.context.mockResolvedValue(buildContext());
  mocks.noPending.mockResolvedValue(undefined);
  mocks.sdk.mockReturnValue({
    address: "addr_test1treasury",
    paymentScriptCbor: "pay",
    stakingScriptCbor: "stake",
    rewardAddress: "stake_test1reward",
  });
  mocks.status.mockResolvedValue({ active: false, rewardsAvailable: "0", poolId: null });
  mocks.lookup.mockResolvedValue(null);
  mocks.provider.mockReturnValue({});
  mocks.build.mockResolvedValue({ unsignedTxHex: "84a0", txHash: HASH });
  mocks.withTx.mockImplementation(
    async (_row: unknown, fn: (tx: { id: string }) => Promise<unknown>) => fn({ id: "tx-1" }),
  );
});

describe("POST /api/tx/build-stake", () => {
  it("requires a session and refuses a cross-site request", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect(
      (await post({ treasuryId: TREASURY_ID, action: "register" })).status,
    ).toBe(401);
    expect(
      (
        await post(
          { treasuryId: TREASURY_ID, action: "register" },
          { origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await post({ treasuryId: "nope", action: "register" })).status).toBe(400);
    expect(
      (await post({ treasuryId: TREASURY_ID, action: "delegate" })).status,
    ).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("refuses a member who is not a base signer", async () => {
    mocks.context.mockResolvedValue(
      buildContext({ isSigner: false, callerGroups: new Set(["recovery"]) }),
    );
    const res = await post({ treasuryId: TREASURY_ID, action: "register" });
    expect(res.status).toBe(403);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("refuses when the stake key is already registered", async () => {
    mocks.status.mockResolvedValue({ active: true, rewardsAvailable: "1", poolId: null });
    const res = await post({ treasuryId: TREASURY_ID, action: "register" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already registered/);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("passes on the one-pending-transaction conflict", async () => {
    mocks.noPending.mockRejectedValue(
      new ConflictError(
        "A pending transaction already exists for this treasury. Submit or reject it first.",
      ),
    );
    expect(
      (await post({ treasuryId: TREASURY_ID, action: "register" })).status,
    ).toBe(409);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("builds a register_and_delegate transaction and stores governance_action", async () => {
    mocks.lookup.mockResolvedValue({
      poolId: "pool1abc",
      ticker: "NUTS",
      margin: null,
      fixedCost: null,
      activeStake: null,
      status: "registered",
    });
    mocks.withTx.mockImplementation(
      async (row: Record<string, unknown>, fn: (tx: { id: string }) => Promise<unknown>) => {
        expect(row).toMatchObject({
          treasury_id: TREASURY_ID,
          kind: "stake",
          spending_path: "base",
          tx_cbor: "84a0",
          tx_hash: HASH,
          created_by: "addr_test1signer",
          description: "Stake: register and delegate to NUTS",
          governance_action: {
            kind: "stake",
            action: "register_and_delegate",
            poolId: "pool1abc",
            poolTicker: "NUTS",
          },
        });
        return fn({ id: "tx-1" });
      },
    );
    const res = await post({
      treasuryId: TREASURY_ID,
      action: "register_and_delegate",
      poolId: "pool1abc",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      txId: "tx-1",
      txHash: HASH,
      action: "register_and_delegate",
      rewardAddress: "stake_test1reward",
    });
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "register_and_delegate",
        poolId: "pool1abc",
        stakingScriptCbor: "stake",
      }),
    );
    expect(mocks.lookup).toHaveBeenCalledWith(0, "pool1abc");
  });
});

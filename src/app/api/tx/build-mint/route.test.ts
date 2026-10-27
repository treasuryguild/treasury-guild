import { resolveNativeScriptHash, serializeNativeScript, type NativeScript } from "@meshsdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TxModule from "@/lib/tx";
import { ConflictError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), context: vi.fn(), noPending: vi.fn(), withTx: vi.fn(),
  insert: vi.fn(), lockedPolicy: vi.fn(), build: vi.fn(), treasury: vi.fn(), provider: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  loadBuildContext: mocks.context,
}));
vi.mock("@/lib/db/transactions", () => ({ assertNoPendingTx: mocks.noPending, withTransactionRow: mocks.withTx }));
vi.mock("@/lib/db/mints", () => ({ insertMints: mocks.insert, loadLockedPolicy: mocks.lockedPolicy }));
vi.mock("@/lib/cardano/mintBuilder", () => ({ buildMintTx: mocks.build }));
vi.mock("@/lib/treasury", () => ({ resolveTreasury: mocks.treasury }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.provider }));
import { POST } from "./route";

const TREASURY_ID = "40000000-0000-4000-8000-000000000001";
// Well-formed preprod enterprise addresses (random key hashes).
const TREASURY = "addr_test1vrgtnp74at3atmh96892k32tve99djyv6fs8y3490eakl9qymmwt2";
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const SCRIPT: NativeScript = { type: "sig", keyHash: "ab".repeat(28) };
const POLICY_ID = resolveNativeScriptHash(SCRIPT);
const CID = `Qm${"a".repeat(44)}`;
const HOUR = 60 * 60 * 1000;

const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/tx/build-mint", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const ft = (overrides: object = {}) => ({
  treasuryId: TREASURY_ID, assetKind: "ft", ticker: "gvt", decimals: 2, supply: "1000",
  assets: [{ name: "GuildToken", imageCid: CID, mediaType: "image/png", description: "The guild's token" }],
  ...overrides,
});
const nft = (overrides: object = {}) => ({
  treasuryId: TREASURY_ID, assetKind: "nft",
  assets: [
    { name: "Badge One", imageCid: CID, attributes: { rank: "gold" } },
    { name: "Badge Two", imageCid: CID },
  ],
  ...overrides,
});
const buildContext = (treasury: object = {}, caller: object = {}) => ({
  treasury: {
    id: TREASURY_ID, community_id: "community", address: TREASURY, network: 0,
    template: "plain", lock_until: null, lock_slot: null, ...treasury,
  },
  signers: [], role: "member", isSigner: true, callerGroups: new Set(["base"]), communitySlug: "guild", network: 0,
  ...caller,
});
const error = async (response: Response) => (await response.json()).error as string;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.context.mockResolvedValue(buildContext());
  mocks.noPending.mockResolvedValue(undefined);
  mocks.treasury.mockReturnValue({ paymentScript: SCRIPT, scriptCbor: "00" });
  mocks.provider.mockReturnValue({});
  mocks.build.mockResolvedValue({ unsignedTxHex: "84a0", txHash: "f".repeat(64) });
  mocks.withTx.mockImplementation(async (_row: unknown, fn: (tx: { id: string }) => Promise<unknown>) => fn({ id: "tx-1" }));
  mocks.insert.mockResolvedValue(undefined);
  mocks.lockedPolicy.mockResolvedValue(null);
});

describe("build-mint API", () => {
  it("mints a fungible token under the treasury's own script, to the treasury by default", async () => {
    const response = await POST(request(ft()), context);
    expect(response.status).toBe(200);
    const unit = `${POLICY_ID}${Buffer.from("GuildToken").toString("hex")}`;
    expect(await response.json()).toEqual({
      txId: "tx-1", txHash: "f".repeat(64), policyId: POLICY_ID, lockSlot: null, lockUntil: null, units: [unit],
    });
    expect(mocks.noPending).toHaveBeenCalledWith(TREASURY_ID);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
      treasuryAddress: TREASURY, spendScriptCbor: "00", policyId: POLICY_ID, network: 0, recipient: TREASURY,
      assets: [{ assetNameHex: Buffer.from("GuildToken").toString("hex"), quantity: 100_000n }],
      lockSlot: null, validFromSlot: null,
      metadata721: { [POLICY_ID]: { GuildToken: {
        name: "GuildToken", image: `ipfs://${CID}`, mediaType: "image/png", description: "The guild's token", ticker: "GVT", decimals: 2,
      } } },
    }));
    expect(mocks.withTx).toHaveBeenCalledWith({
      treasury_id: TREASURY_ID, kind: "mint", spending_path: "base", tx_cbor: "84a0", tx_hash: "f".repeat(64),
      description: "Mint: 1000 GVT", created_by: "admin",
    }, expect.any(Function));
    expect(mocks.insert).toHaveBeenCalledWith([expect.objectContaining({
      transaction_id: "tx-1", community_id: "community", treasury_id: TREASURY_ID, asset_kind: "ft",
      policy_id: POLICY_ID, policy_script: SCRIPT, lock_slot: null, lock_until: null,
      asset_name: "GuildToken", quantity: "100000", decimals: 2, ticker: "GVT", image_cid: CID,
      recipient: TREASURY, created_by: "admin",
    })]);
  });

  it("mints NFTs one of each, to a named recipient", async () => {
    const response = await POST(request(nft({ recipient: ` ${ALICE} ` })), context);
    expect(response.status).toBe(200);
    expect((await response.json()).units).toHaveLength(2);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
      recipient: ALICE,
      assets: [expect.objectContaining({ quantity: 1n }), expect.objectContaining({ quantity: 1n })],
    }));
    expect(mocks.withTx).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Mint: 2 NFTs (Badge One, Badge Two)" }), expect.any(Function),
    );
    expect(mocks.insert).toHaveBeenCalledWith([
      expect.objectContaining({ asset_kind: "nft", asset_name: "Badge One", quantity: "1", decimals: 0, ticker: null, recipient: ALICE }),
      expect.objectContaining({ asset_name: "Badge Two", quantity: "1" }),
    ]);
  });

  describe("who builds, on which path", () => {
    it("refuses members who are neither admins nor base signers", async () => {
      for (const groups of [[], ["recovery"], ["cosigner"]]) {
        mocks.context.mockResolvedValue(buildContext({}, { isSigner: false, callerGroups: new Set(groups) }));
        const response = await POST(request(ft()), context);
        expect(response.status).toBe(403);
        expect(await error(response)).toBe("Only treasury signers can start a mint");
      }
      expect(mocks.noPending).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    });

    it("refuses an admin who signs nothing", async () => {
      mocks.context.mockResolvedValue(buildContext({}, { role: "admin", isSigner: false, callerGroups: new Set() }));
      expect((await POST(request(ft()), context)).status).toBe(403);
      expect(mocks.build).not.toHaveBeenCalled();
    });

    it("takes the co-signed path of a co-signer treasury by default, and the bypass when asked", async () => {
      mocks.context.mockResolvedValue(buildContext({ template: "cosigner", cosigner_kind: "app" }));
      expect((await POST(request(ft()), context)).status).toBe(200);
      expect(mocks.withTx).toHaveBeenLastCalledWith(expect.objectContaining({ spending_path: "cosigned" }), expect.any(Function));
      expect((await POST(request(ft({ path: "bypass" })), context)).status).toBe(200);
      expect(mocks.withTx).toHaveBeenLastCalledWith(expect.objectContaining({ spending_path: "bypass" }), expect.any(Function));
    });

    it("refuses a path the template lacks, and the recovery path, which builds payments only", async () => {
      expect((await POST(request(ft({ path: "cosigned" })), context)).status).toBe(400);
      mocks.context.mockResolvedValue(buildContext(
        { template: "clawback", lock_until: new Date(Date.now() - HOUR).toISOString(), lock_slot: 100 },
        { isSigner: false, callerGroups: new Set(["recovery"]) },
      ));
      const response = await POST(request(ft({ path: "recovery" })), context);
      expect(response.status).toBe(400);
      expect(await error(response)).toContain("payments only");
      expect(mocks.build).not.toHaveBeenCalled();
    });

    it("builds nothing from a lock-until treasury before its date, and from its lock slot afterwards", async () => {
      mocks.context.mockResolvedValue(buildContext({ template: "lock_until", lock_until: new Date(Date.now() + HOUR).toISOString(), lock_slot: 100 }));
      expect((await POST(request(ft()), context)).status).toBe(400);
      expect(mocks.build).not.toHaveBeenCalled();
      mocks.context.mockResolvedValue(buildContext({ template: "lock_until", lock_until: new Date(Date.now() - HOUR).toISOString(), lock_slot: 100 }));
      expect((await POST(request(ft()), context)).status).toBe(200);
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ validFromSlot: 100 }));
    });

    it("surfaces a pending transaction as a conflict", async () => {
      mocks.noPending.mockRejectedValue(new ConflictError("A pending transaction already exists for this treasury."));
      expect((await POST(request(ft()), context)).status).toBe(409);
      expect(mocks.build).not.toHaveBeenCalled();
    });
  });

  describe("the policy", () => {
    it("wraps the treasury script in a time lock for a new locked policy", async () => {
      const lockUntil = new Date(Date.now() + 2 * HOUR).toISOString();
      const response = await POST(request(ft({ policy: { mode: "locked", lockUntil } })), context);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.lockUntil).toBe(lockUntil);
      expect(json.lockSlot).toBeGreaterThan(0);
      const forge: NativeScript = { type: "all", scripts: [SCRIPT, { type: "before", slot: String(json.lockSlot) }] };
      expect(json.policyId).toBe(resolveNativeScriptHash(forge));
      expect(json.policyId).not.toBe(POLICY_ID);
      expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ lockSlot: json.lockSlot, policyId: json.policyId }));
      expect(mocks.insert).toHaveBeenCalledWith([expect.objectContaining({ policy_script: forge, lock_slot: json.lockSlot, lock_until: lockUntil })]);
      expect(mocks.lockedPolicy).not.toHaveBeenCalled();
    });

    it("continues a locked policy this treasury used before, with its stored date", async () => {
      const first = await (await POST(request(ft({ policy: { mode: "locked", lockUntil: new Date(Date.now() + 2 * HOUR).toISOString() } })), context)).json();
      mocks.lockedPolicy.mockResolvedValue({ lock_until: "2030-01-01T00:00:00.000Z" });
      const response = await POST(request(ft({ policy: { mode: "locked", lockSlot: first.lockSlot } })), context);
      expect(response.status).toBe(200);
      expect(mocks.lockedPolicy).toHaveBeenCalledWith("community", TREASURY_ID, first.lockSlot);
      expect(await response.json()).toMatchObject({ policyId: first.policyId, lockSlot: first.lockSlot, lockUntil: "2030-01-01T00:00:00.000Z" });
    });

    it("refuses a lock too soon, an unknown or closed policy, and a locked policy with no date", async () => {
      const locked = (policy: object) => POST(request(ft({ policy: { mode: "locked", ...policy } })), context);
      expect(await error(await locked({ lockUntil: new Date(Date.now() + HOUR / 2).toISOString() }))).toBe("Policy lock must be at least one hour in the future");
      expect(await error(await locked({ lockUntil: "someday" }))).toBe("Invalid lockUntil date");
      expect(await error(await locked({}))).toBe("Locked policy needs lockUntil or lockSlot");
      expect(await error(await locked({ lockSlot: 5 }))).toBe("Unknown locked policy for this treasury");
      mocks.lockedPolicy.mockResolvedValue({ lock_until: "2020-01-01T00:00:00.000Z" });
      const closed = await locked({ lockSlot: 5 });
      expect(closed.status).toBe(400);
      expect(await error(closed)).toBe("This policy is already locked; it cannot mint any more");
      expect(mocks.build).not.toHaveBeenCalled();
    });
  });

  describe("what it refuses to mint", () => {
    const refusal = async (body: object) => {
      const response = await POST(request(body), context);
      expect(response.status).toBe(400);
      return error(response);
    };

    it("checks the asset counts before loading anything", async () => {
      expect(await refusal(ft({ assets: [{ name: "A", imageCid: CID }, { name: "B", imageCid: CID }] }))).toBe("A fungible mint defines exactly one asset");
      const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `Badge ${i}`, imageCid: CID }));
      expect(await refusal(nft({ assets: eleven }))).toBe("At most 10 NFTs per transaction");
      await refusal(nft({ assets: [] }));
      await refusal(ft({ path: "sideways" }));
      expect(mocks.context).not.toHaveBeenCalled();
    });

    it("checks the recipient's address and network", async () => {
      expect(await refusal(ft({ recipient: "not-an-address" }))).toBe("Invalid recipient address");
      const mainnet = serializeNativeScript(SCRIPT, undefined, 1).address;
      expect(await refusal(ft({ recipient: mainnet }))).toBe("Recipient address is on a different network");
    });

    it("checks the fungible fields", async () => {
      expect(await refusal(ft({ ticker: "too long ticker" }))).toContain("Ticker must be");
      expect(await refusal(ft({ supply: "0" }))).toBe("Supply must be greater than zero");
      await refusal(ft({ supply: "lots" }));
      await refusal(ft({ supply: "1.005" }));
      expect(await refusal(ft({ url: "ftp://example.org" }))).toBe("Invalid website URL");
    });

    it("checks each asset's name, image and media type", async () => {
      expect(await refusal(nft({ assets: [{ name: "", imageCid: CID }] }))).toBe("Asset name is required");
      expect(await refusal(nft({ assets: [{ name: "Badge", imageCid: "not-a-cid" }] }))).toBe("Badge: image CID is invalid");
      expect(await refusal(nft({ assets: [{ name: "Badge", imageCid: CID, mediaType: "text/html" }] }))).toBe("Badge: unsupported media type");
      expect(await refusal(nft({ assets: [{ name: "Badge", imageCid: CID }, { name: "Badge", imageCid: CID }] }))).toBe("Duplicate asset name: Badge");
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.withTx).not.toHaveBeenCalled();
    });
  });
});

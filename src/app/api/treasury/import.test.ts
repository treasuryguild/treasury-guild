import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Membership from "@/lib/db/membership";
import type * as Treasuries from "@/lib/db/treasuries";
import { serializeNativeScript } from "@meshsdk/core";
import { serializeAddress } from "@meshsdk/core-cst";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireAdmin: vi.fn(), insert: vi.fn(), single: vi.fn(), rpc: vi.fn(),
  count: vi.fn(), members: vi.fn(), addMember: vi.fn(), promote: vi.fn(), link: vi.fn(),
  memberRole: vi.fn(), cosignerKey: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin, requireMember: vi.fn(), memberRole: mocks.memberRole }));
vi.mock("@/lib/db/cosigner", () => ({ insertCosignerKey: mocks.cosignerKey }));
vi.mock("@/lib/db/client", () => ({
  check: vi.fn(), rows: (result: { data: unknown[] }) => result.data,
  serviceClient: () => ({
    from: () => ({ insert: mocks.insert, select: () => ({ eq: mocks.members }) }),
    rpc: mocks.rpc,
  }),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: async () => ({ id: "10000000-0000-4000-8000-000000000001", network: 0 }) }));
vi.mock("@/lib/db/membership", async (importOriginal) => ({
  ...(await importOriginal<typeof Membership>()),
  addMember: mocks.addMember, promoteMembersToAdmin: mocks.promote,
}));
vi.mock("@/lib/db/treasuries", async (importOriginal) => ({
  ...(await importOriginal<typeof Treasuries>()),
  countCommunityTreasuries: mocks.count, loadTreasuryWithSigners: vi.fn(),
}));
vi.mock("@/lib/db/workgroups", () => ({ workgroupCommunityId: async () => "10000000-0000-4000-8000-000000000001", requireActiveWorkgroup: vi.fn() }));
vi.mock("@/lib/db/workgroupRouting", () => ({ setWorkgroupTreasury: mocks.link }));
import { POST } from "./route";
import { POST as preview } from "./import/preview/route";

const hashA = "b".repeat(56);
const hashB = "a".repeat(56);
const addrA = serializeAddress({ pubKeyHash: hashA }, 0);
const addrB = serializeAddress({ pubKeyHash: hashB }, 0);
const imported = serializeNativeScript({
  type: "all", scripts: [hashA, hashB].map((keyHash) => ({ type: "sig", keyHash })),
}, undefined, 0, true);
const source = { type: "cbor", cbor: imported.scriptCbor };
const context = { params: Promise.resolve({}) };
const request = (extra: object = {}) => new Request("http://localhost/api/treasury", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ communityId: "10000000-0000-4000-8000-000000000001", name: "Imported", source, signers: [{ address: addrA }, { address: addrB }], ...extra }),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: addrA });
  mocks.count.mockResolvedValue(0);
  mocks.insert.mockReturnValue({ select: () => ({ single: mocks.single }) });
  mocks.single.mockResolvedValue({ data: { id: "treasury-1" }, error: null });
  mocks.rpc.mockResolvedValue({ data: 0, error: null });
  mocks.members.mockResolvedValue({ data: [{ wallet_address: addrB }], error: null });
});

describe("import treasury API", () => {
  it("previews the exact address and fills known wallets without writes", async () => {
    const response = await preview(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      address: imported.address, scriptCbor: imported.scriptCbor, template: "plain", scriptType: "all", required: 2,
      recovery: null, lockSlot: null, lockUntil: null,
      signers: [{ keyHash: hashA, address: addrA, group: "base" }, { keyHash: hashB, address: addrB, group: "base" }],
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("imports exact script bytes and takes the rule from CBOR, ignoring client overrides", async () => {
    const response = await POST(request({ required: 1, scriptType: "any" }), context);
    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      script_cbor: imported.scriptCbor, address: imported.address, required: 2, script_type: "all", network: 0,
      template: "plain", lock_slot: null, lock_until: null, recovery_script_type: null, recovery_required: null, cosigner_kind: null,
    }));
    expect(mocks.insert).toHaveBeenNthCalledWith(2, [
      { treasury_id: "treasury-1", wallet_address: addrA, key_hash: hashA, display_name: null, signer_group: "base" },
      { treasury_id: "treasury-1", wallet_address: addrB, key_hash: hashB, display_name: null, signer_group: "base" },
    ]);
    expect(mocks.promote).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", [addrA, addrB]);
  });

  it.each([
    { signers: [{ address: addrA }] },
    { signers: [{ address: addrA }, { address: serializeAddress({ pubKeyHash: "c".repeat(56) }, 0) }] },
    { signers: [{ address: addrA }, { address: serializeAddress({ pubKeyHash: hashB }, 1) }] },
    { signers: [{ address: addrA }, { address: "bad-address" }] },
    { signers: [{ address: addrA }, { address: addrA }] },
    { source: { type: "cbor", cbor: "deadbeef" } },
    { source: { type: "unknown", cbor: imported.scriptCbor } },
  ])("rejects invalid imports before writing %#", async (extra) => {
    expect((await POST(request(extra), context)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("requires the importing admin to sign for the first treasury", async () => {
    mocks.session.mockResolvedValue({ wallet: serializeAddress({ pubKeyHash: "c".repeat(56) }, 0) });
    expect((await POST(request(), context)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
    mocks.count.mockResolvedValue(1);
    expect((await POST(request(), context)).status).toBe(200);
  });

  it("restricts both preview and import to admins", async () => {
    mocks.requireAdmin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await preview(request(), context)).status).toBe(403);
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("reports an already registered address as a conflict", async () => {
    mocks.single.mockResolvedValue({ data: null, error: { code: "23505" } });
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "A treasury with this address already exists" });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
});

describe("templated treasuries", () => {
  const addrC = serializeAddress({ pubKeyHash: "c".repeat(56) }, 0);
  const addrD = serializeAddress({ pubKeyHash: "d".repeat(56) }, 0);
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const create = (extra: object) => new Request("http://localhost/api/treasury", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      communityId: "10000000-0000-4000-8000-000000000001", name: "Templated", required: 2,
      signers: [{ address: addrA }, { address: addrB }], ...extra,
    }),
  });

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    mocks.memberRole.mockResolvedValue("member");
    mocks.cosignerKey.mockResolvedValue(undefined);
  });

  it("creates a clawback treasury with its lock and recovery group, promoting base signers only", async () => {
    const response = await POST(create({
      template: "clawback", lockUntil: soon, recovery: { scriptType: "any", signers: [{ address: addrC, name: "Carol" }] },
    }), context);
    expect(response.status).toBe(200);
    const treasury = mocks.insert.mock.calls[0]![0];
    expect(treasury).toMatchObject({ template: "clawback", recovery_script_type: "any", recovery_required: 1, required: 2, script_type: "atLeast", cosigner_kind: null });
    expect(treasury.lock_slot).toBeGreaterThan(0);
    expect(Math.abs(Date.parse(treasury.lock_until) - Date.parse(soon))).toBeLessThan(2000);
    expect(mocks.insert).toHaveBeenNthCalledWith(2, expect.arrayContaining([
      expect.objectContaining({ wallet_address: addrA, signer_group: "base" }),
      expect.objectContaining({ wallet_address: addrB, signer_group: "base" }),
      expect.objectContaining({ wallet_address: addrC, signer_group: "recovery", display_name: "Carol" }),
    ]));
    expect(mocks.promote).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", [addrA, addrB]);
    expect(mocks.addMember).not.toHaveBeenCalledWith(expect.anything(), addrC, expect.anything());
  });

  it("creates an app co-signer treasury with a generated key and its signer row", async () => {
    // 1 of 2: a base rule that already needs every signer cannot take a co-signer.
    const response = await POST(create({ template: "cosigner", cosigner: { kind: "app" }, required: 1 }), context);
    expect(response.status).toBe(200);
    expect(mocks.insert.mock.calls[0]![0]).toMatchObject({ template: "cosigner", cosigner_kind: "app", lock_slot: null, required: 1 });
    expect(mocks.cosignerKey).toHaveBeenCalledWith(expect.objectContaining({
      treasury_id: "treasury-1", key_hash: expect.stringMatching(/^[0-9a-f]{56}$/), encrypted_key: expect.stringMatching(/^v1:/),
    }));
    const rows = mocks.insert.mock.calls[1]![0] as { signer_group: string; display_name: string | null; wallet_address: string }[];
    const cosigner = rows.find((r) => r.signer_group === "cosigner")!;
    expect(cosigner.display_name).toBe("Treasury Guild co-signer");
    expect(cosigner.wallet_address.startsWith("addr_test1")).toBe(true);
    expect(mocks.promote).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001", [addrA, addrB]);
  });

  it.each([
    ["a lock date too soon", { template: "lock_until", lockUntil: new Date(Date.now() + 60_000).toISOString() }],
    ["a clawback without recovery signers", { template: "clawback", lockUntil: soon }],
    ["a key in two groups", { template: "clawback", lockUntil: soon, recovery: { signers: [{ address: addrA }] } }],
    ["a co-signer on a base rule that needs every signer", { template: "cosigner", scriptType: "all", cosigner: { kind: "member", address: addrC } }],
    ["a co-signer who is also a base signer", { template: "cosigner", cosigner: { kind: "member", address: addrB } }],
    ["a lock date on a plain treasury", { lockUntil: soon }],
  ])("refuses %s before writing", async (_name, extra) => {
    expect((await POST(create(extra), context)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses recovery signers and member co-signers who are not members yet", async () => {
    mocks.memberRole.mockResolvedValue(null);
    expect((await POST(create({ template: "clawback", lockUntil: soon, recovery: { signers: [{ address: addrD }] } }), context)).status).toBe(400);
    expect((await POST(create({ template: "cosigner", cosigner: { kind: "member", address: addrD } }), context)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

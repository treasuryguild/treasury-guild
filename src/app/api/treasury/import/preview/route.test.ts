import { serializeNativeScript, type NativeScript } from "@meshsdk/core";
import { serializeAddress } from "@meshsdk/core-cst";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slotTime } from "@/lib/cardano/slots";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), admin: vi.fn(), community: vi.fn(), members: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/membership", () => ({ communityMemberWallets: mocks.members }));
import { POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const SLOT = 120_000_000;
// Deliberately not in sorted order: an import keeps the script's own key order.
const [hashA, hashB, hashC, hashD] = ["b", "a", "c", "d"].map((c) => c.repeat(56)) as [string, string, string, string];
const address = (keyHash: string, network = 0) => serializeAddress({ pubKeyHash: keyHash }, network);
const [addrA, addrB, addrC, addrD] = [hashA, hashB, hashC, hashD].map((h) => address(h)) as [string, string, string, string];
const sig = (keyHash: string): NativeScript => ({ type: "sig", keyHash });
const serialize = (script: NativeScript, network = 0) => serializeNativeScript(script, undefined, network, true);

const PLAIN: NativeScript = { type: "atLeast", required: 2, scripts: [sig(hashA), sig(hashB), sig(hashC)] };
const CLAWBACK: NativeScript = { type: "any", scripts: [
  { type: "atLeast", required: 1, scripts: [sig(hashA), sig(hashB)] },
  { type: "all", scripts: [{ type: "any", scripts: [sig(hashC), sig(hashD)] }, { type: "after", slot: String(SLOT) }] },
] };
const LOCK_UNTIL: NativeScript = { type: "all", scripts: [{ type: "all", scripts: [sig(hashA), sig(hashB)] }, { type: "after", slot: String(SLOT) }] };
const COSIGNER: NativeScript = { type: "any", scripts: [
  { type: "all", scripts: [{ type: "atLeast", required: 1, scripts: [sig(hashA), sig(hashB)] }, sig(hashC)] },
  { type: "all", scripts: [sig(hashA), sig(hashB)] },
] };

const context = { params: Promise.resolve({}) };
const post = (body: object, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/treasury/import/preview", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
}), context);
const preview = (script: NativeScript) => post({ communityId: COMMUNITY, source: { type: "cbor", cbor: serialize(script).scriptCbor } });
const refusal = async (script: NativeScript) => {
  const res = await preview(script);
  expect(res.status).toBe(400);
  return (await res.json()).error as string;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: addrA });
  mocks.admin.mockResolvedValue("admin");
  mocks.community.mockResolvedValue({ id: COMMUNITY, network: 0 });
  mocks.members.mockResolvedValue([addrB, addrC, addrD]);
});

describe("POST /api/treasury/import/preview", () => {
  it("previews a plain multisig: its exact address and bytes, signers in script order with the known wallets filled in", async () => {
    const { address: scriptAddress, scriptCbor } = serialize(PLAIN);
    mocks.members.mockResolvedValue([addrB]);
    const res = await post({ communityId: COMMUNITY, source: { type: "cbor", cbor: ` ${scriptCbor!.toUpperCase()}\n` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      address: scriptAddress, scriptCbor, stakeCredentialHash: null, suggestedName: null,
      template: "plain", scriptType: "atLeast", required: 2,
      recovery: null, lockSlot: null, lockUntil: null,
      signers: [
        { keyHash: hashA, address: addrA, group: "base", name: "" },
        { keyHash: hashB, address: addrB, group: "base", name: "" },
        { keyHash: hashC, address: "", group: "base", name: "" },
      ],
    });
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, addrA);
    expect(mocks.community).toHaveBeenCalledWith(COMMUNITY);
    expect(mocks.members).toHaveBeenCalledWith(COMMUNITY);
  });

  it("previews a clawback script with its recovery group and lock date", async () => {
    const res = await preview(CLAWBACK);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      address: serialize(CLAWBACK).address, template: "clawback", scriptType: "atLeast", required: 1,
      recovery: { scriptType: "any", required: 1 }, lockSlot: SLOT, lockUntil: slotTime(0, SLOT),
      signers: [
        { keyHash: hashA, address: addrA, group: "base" }, { keyHash: hashB, address: addrB, group: "base" },
        { keyHash: hashC, address: addrC, group: "recovery" }, { keyHash: hashD, address: addrD, group: "recovery" },
      ],
    });
  });

  it("previews a lock-until script", async () => {
    expect(await (await preview(LOCK_UNTIL)).json()).toMatchObject({
      address: serialize(LOCK_UNTIL).address, template: "lock_until", scriptType: "all", required: 2,
      recovery: null, lockSlot: SLOT, lockUntil: slotTime(0, SLOT),
      signers: [{ keyHash: hashA, group: "base" }, { keyHash: hashB, group: "base" }],
    });
  });

  it("previews a co-signer script with the co-signer in its own group", async () => {
    expect(await (await preview(COSIGNER)).json()).toMatchObject({
      address: serialize(COSIGNER).address, template: "cosigner", scriptType: "atLeast", required: 1,
      recovery: null, lockSlot: null, lockUntil: null,
      signers: [
        { keyHash: hashA, address: addrA, group: "base" }, { keyHash: hashB, address: addrB, group: "base" },
        { keyHash: hashC, address: addrC, group: "cosigner" },
      ],
    });
  });

  it("takes the network from the community: a mainnet address and lock date, and only mainnet wallets as known signers", async () => {
    mocks.community.mockResolvedValue({ id: COMMUNITY, network: 1 });
    mocks.session.mockResolvedValue({ wallet: address(hashA, 1) });
    mocks.members.mockResolvedValue([addrB, address(hashC, 1), "not-an-address"]);
    const json = await (await preview(CLAWBACK)).json();
    expect(json.address).toBe(serialize(CLAWBACK, 1).address);
    expect(json.address.startsWith("addr1")).toBe(true);
    expect(json.lockUntil).toBe(slotTime(1, SLOT));
    expect(json.signers).toEqual([
      { keyHash: hashA, address: address(hashA, 1), group: "base", name: "" }, { keyHash: hashB, address: "", group: "base", name: "" },
      { keyHash: hashC, address: address(hashC, 1), group: "recovery", name: "" }, { keyHash: hashD, address: "", group: "recovery", name: "" },
    ]);
  });

  it("refuses every script that is not one of the four template shapes", async () => {
    const unsupported = "Import supports a flat all, any or at-least multisig, a clawback, a lock-until or a co-signer script only";
    const others: NativeScript[] = [
      sig(hashA),
      { type: "all", scripts: [{ type: "all", scripts: [sig(hashA)] }, { type: "before", slot: String(SLOT) }] },
      { type: "any", scripts: [{ type: "any", scripts: [sig(hashA)] }, sig(hashB)] },
      { type: "all", scripts: [sig(hashA), { type: "any", scripts: [sig(hashB), sig(hashC)] }] },
      { type: "any", scripts: [
        { type: "all", scripts: [{ type: "any", scripts: [sig(hashA), sig(hashB)] }, sig(hashC)] },
        { type: "all", scripts: [sig(hashA), sig(hashD)] },
      ] },
    ];
    for (const script of others) expect(await refusal(script)).toBe(unsupported);
    expect(mocks.community).not.toHaveBeenCalled();
    expect(mocks.members).not.toHaveBeenCalled();
  });

  it("refuses a template shape whose groups make no sense", async () => {
    expect(await refusal({ type: "atLeast", required: 3, scripts: [sig(hashA), sig(hashB)] }))
      .toBe("The base group's required signatures must be between 1 and its number of signers");
    expect(await refusal({ type: "all", scripts: [sig(hashA), sig(hashA)] })).toBe("A key can appear in the script only once");
    expect(await refusal({ type: "any", scripts: [
      { type: "all", scripts: [{ type: "all", scripts: [sig(hashA), sig(hashB)] }, sig(hashC)] },
      { type: "all", scripts: [sig(hashA), sig(hashB)] },
    ] })).toBe("Every base signer already has to sign, so a co-signer would add nothing");
  });

  it("refuses input that is not native-script CBOR hex, or no CBOR source at all", async () => {
    const cbor = (value: string) => post({ communityId: COMMUNITY, source: { type: "cbor", cbor: value } });
    const hexOnly = await cbor("not hex at all");
    expect(hexOnly.status).toBe(400);
    expect((await hexOnly.json()).error).toBe("Paste a native script as CBOR hex (up to 16 KB)");
    const notScript = await cbor("deadbeef");
    expect(notScript.status).toBe(400);
    expect((await notScript.json()).error).toBe("Invalid native-script CBOR");
    expect(mocks.community).not.toHaveBeenCalled();
    mocks.admin.mockClear();
    const { scriptCbor } = serialize(PLAIN);
    for (const body of [
      {}, { communityId: COMMUNITY }, { communityId: "nope", source: { type: "cbor", cbor: scriptCbor } },
      { communityId: COMMUNITY, source: { type: "address", cbor: scriptCbor } }, { communityId: COMMUNITY, source: { type: "cbor", cbor: "" } },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await preview(PLAIN)).status).toBe(401);
    const { scriptCbor } = serialize(PLAIN);
    expect((await post({ communityId: COMMUNITY, source: { type: "cbor", cbor: scriptCbor } }, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("is for admins only: nobody else learns the members' addresses", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await preview(PLAIN)).status).toBe(403);
    expect(mocks.community).not.toHaveBeenCalled();
    expect(mocks.members).not.toHaveBeenCalled();
  });

  it("answers 404 for a community that is gone", async () => {
    mocks.community.mockRejectedValue(new NotFoundError("Community not found"));
    expect((await preview(PLAIN)).status).toBe(404);
    expect(mocks.members).not.toHaveBeenCalled();
  });
});

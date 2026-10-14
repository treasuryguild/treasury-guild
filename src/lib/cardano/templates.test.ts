import { describe, expect, it } from "vitest";
import { serializeNativeScript } from "@meshsdk/core";
import { csl } from "./csl";
import { decodeNativeScriptFromCsl } from "./nativeScriptUtils";
import {
  cosignerAllowed,
  groupRequired,
  shapeFromDecoded,
  shapeKeyHashes,
  shapeProblem,
  sortedGroup,
  templateScript,
  type KeyGroup,
  type TreasuryShape,
} from "./templates";
import type { DecodedNativeScript } from "./types";

const k = (c: string) => c.repeat(56);
const base: KeyGroup = { scriptType: "atLeast", required: 2, keyHashes: [k("a"), k("b"), k("c")] };
const recovery: KeyGroup = { scriptType: "any", required: 1, keyHashes: [k("d"), k("e")] };

const shapes: Record<string, TreasuryShape> = {
  plain: { template: "plain", base, recovery: null, lockSlot: null, cosignerKeyHash: null },
  clawback: { template: "clawback", base, recovery, lockSlot: 123_456_789, cosignerKeyHash: null },
  lock_until: { template: "lock_until", base, recovery: null, lockSlot: 42, cosignerKeyHash: null },
  cosigner: { template: "cosigner", base, recovery: null, lockSlot: null, cosignerKeyHash: k("f") },
};

const encode = (shape: TreasuryShape) => serializeNativeScript(templateScript(shape)).scriptCbor!;
const decode = (cbor: string) => decodeNativeScriptFromCsl(csl.NativeScript.from_hex(cbor));

describe("templateScript", () => {
  it("builds the four documented shapes", () => {
    expect(templateScript(shapes.plain!)).toEqual({
      type: "atLeast", required: 2, scripts: base.keyHashes.map((keyHash) => ({ type: "sig", keyHash })),
    });
    expect(templateScript(shapes.lock_until!)).toEqual({
      type: "all", scripts: [templateScript(shapes.plain!), { type: "after", slot: "42" }],
    });
    expect(templateScript(shapes.clawback!)).toEqual({
      type: "any",
      scripts: [
        templateScript(shapes.plain!),
        { type: "all", scripts: [{ type: "any", scripts: recovery.keyHashes.map((keyHash) => ({ type: "sig", keyHash })) }, { type: "after", slot: "123456789" }] },
      ],
    });
    expect(templateScript(shapes.cosigner!)).toEqual({
      type: "any",
      scripts: [
        { type: "all", scripts: [templateScript(shapes.plain!), { type: "sig", keyHash: k("f") }] },
        { type: "all", scripts: base.keyHashes.map((keyHash) => ({ type: "sig", keyHash })) },
      ],
    });
  });

  it.each(Object.keys(shapes))("%s round-trips through CBOR byte for byte and derives an address on both networks", (name) => {
    const shape = shapes[name]!;
    const cbor = encode(shape);
    const decoded = shapeFromDecoded(decode(cbor));
    expect(decoded).toEqual(shape);
    expect(encode(decoded!)).toBe(cbor);
    expect(serializeNativeScript(templateScript(shape), undefined, 0, true).address.startsWith("addr_test1")).toBe(true);
    expect(serializeNativeScript(templateScript(shape), undefined, 1, true).address.startsWith("addr1")).toBe(true);
    expect(shapeProblem(shape)).toBeNull();
  });
});

describe("shapeFromDecoded", () => {
  const sig = (keyHash: string): DecodedNativeScript => ({ type: "sig", keyHash });
  const flat: DecodedNativeScript = { type: "atLeast", required: 2, scripts: base.keyHashes.map(sig) };
  const after: DecodedNativeScript = { type: "timelockStart", slot: "42" };

  it.each<[string, DecodedNativeScript]>([
    ["a before lock", { type: "all", scripts: [flat, { type: "timelockExpiry", slot: "42" }] }],
    ["a lock on the wrong side", { type: "all", scripts: [after, flat] }],
    ["a zero slot", { type: "all", scripts: [flat, { type: "timelockStart", slot: "0" }] }],
    ["a nested group without a lock", { type: "all", scripts: [flat, { type: "any", scripts: [sig(k("d"))] }] }],
    ["three branches", { type: "any", scripts: [flat, flat, flat] }],
    ["a clawback whose recovery branch has no lock", { type: "any", scripts: [flat, { type: "all", scripts: [{ type: "any", scripts: [sig(k("d"))] }] }] }],
    ["a co-signer branch that is not every base key", { type: "any", scripts: [{ type: "all", scripts: [flat, sig(k("f"))] }, { type: "all", scripts: [sig(k("a")), sig(k("b"))] }] }],
    ["a co-signer branch in another order", { type: "any", scripts: [{ type: "all", scripts: [flat, sig(k("f"))] }, { type: "all", scripts: [sig(k("c")), sig(k("b")), sig(k("a"))] }] }],
    ["a co-signer bypass that is not all", { type: "any", scripts: [{ type: "all", scripts: [flat, sig(k("f"))] }, { type: "atLeast", required: 3, scripts: base.keyHashes.map(sig) }] }],
    ["a bare sig", sig(k("a"))],
  ])("refuses %s", (_name, node) => {
    expect(shapeFromDecoded(node)).toBeNull();
  });

  it("keeps an imported key order and lowercases keys", () => {
    const node: DecodedNativeScript = { type: "all", scripts: [k("B").toUpperCase(), k("a")].map(sig) };
    expect(shapeFromDecoded(node)?.base).toEqual({ scriptType: "all", required: 2, keyHashes: [k("b"), k("a")] });
  });
});

describe("shapeProblem", () => {
  it("refuses empty or out-of-range groups, a repeated key and a pointless co-signer", () => {
    expect(shapeProblem({ ...shapes.plain!, base: { scriptType: "all", required: 0, keyHashes: [] } })).toMatch(/at least one signer/);
    expect(shapeProblem({ ...shapes.plain!, base: { ...base, required: 4 } })).toMatch(/between 1 and/);
    expect(shapeProblem({ ...shapes.clawback!, recovery: { scriptType: "atLeast", required: 0, keyHashes: [k("d")] } })).toMatch(/recovery group/);
    expect(shapeProblem({ ...shapes.clawback!, recovery: { ...recovery, keyHashes: [k("a"), k("d")] } })).toMatch(/only once/);
    expect(shapeProblem({ ...shapes.cosigner!, cosignerKeyHash: k("a") })).toMatch(/only once/);
    expect(shapeProblem({ ...shapes.cosigner!, base: { ...base, required: 3 } })).toMatch(/add nothing/);
    expect(shapeProblem({ ...shapes.cosigner!, base: { scriptType: "all", required: 3, keyHashes: base.keyHashes } })).toMatch(/add nothing/);
  });
});

describe("group helpers", () => {
  it("sorts keys for new wallets and counts what each rule needs", () => {
    expect(sortedGroup({ scriptType: "any", required: 1, keyHashes: [k("c"), k("a"), k("b")] }).keyHashes).toEqual([k("a"), k("b"), k("c")]);
    expect(groupRequired(base)).toBe(2);
    expect(groupRequired({ scriptType: "all", required: 1, keyHashes: base.keyHashes })).toBe(3);
    expect(groupRequired({ scriptType: "any", required: 3, keyHashes: base.keyHashes })).toBe(1);
    expect(cosignerAllowed(base)).toBe(true);
    expect(cosignerAllowed({ scriptType: "any", required: 1, keyHashes: [k("a")] })).toBe(false);
    expect(shapeKeyHashes(shapes.clawback!)).toEqual([...base.keyHashes, ...recovery.keyHashes]);
    expect(shapeKeyHashes(shapes.cosigner!)).toEqual([...base.keyHashes, k("f")]);
  });
});

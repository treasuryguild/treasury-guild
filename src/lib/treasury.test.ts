import { describe, expect, it } from "vitest";
import { resolveNativeScriptHash, serializeNativeScript, type NativeScript } from "@meshsdk/core";
import { MultisigWallet, paymentKeyHash } from "./cardano/multisigSDK";
import { templateScript } from "./cardano/templates";
import type { TreasuryRow, TreasurySignerRow } from "./db/types";
import { InvariantError } from "./errors";
import { describeTreasury, resolveTreasury, resolveTreasuryScript } from "./treasury";

const ADDR_A =
  "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const hashA = paymentKeyHash(ADDR_A);
const hashB = "a".repeat(56);
const hashC = "0".repeat(56);
const stakeA = "c".repeat(56);
const stakeB = "d".repeat(56);
const stakeC = "1".repeat(56);
const drepA = "e".repeat(56);
const drepB = "f".repeat(56);
const drepC = "2".repeat(56);

const expected = new MultisigWallet(
  "Test",
  [hashA, hashB, hashC].map((keyHash) => ({ keyHash, role: 0, name: "" })),
  "",
  2,
  0,
).getScript();

const signerRow = (
  key_hash: string,
  i: number,
  signer_group: TreasurySignerRow["signer_group"] = "base",
  extras: Pick<TreasurySignerRow, "stake_key_hash" | "drep_key_hash"> = {
    stake_key_hash: null,
    drep_key_hash: null,
  },
): TreasurySignerRow => ({
  treasury_id: "t1",
  wallet_address: `addr_test1signer${i}`,
  key_hash,
  display_name: null,
  signer_group,
  ...extras,
});
const signers: TreasurySignerRow[] = [hashC, hashA, hashB].map((key_hash, i) => signerRow(key_hash, i));

function treasury(address: string): TreasuryRow {
  return {
    id: "t1",
    community_id: "c1",
    name: "Test",
    network: 0,
    required: 2,
    script_type: "atLeast",
    address,
    script_cbor: expected.scriptCbor ?? "",
    stake_credential_hash: null,
    template: "plain",
    lock_slot: null,
    lock_until: null,
    recovery_script_type: null,
    recovery_required: null,
    cosigner_kind: null,
    archived_at: null,
    archived_by: null,
  };
}

describe("resolveTreasury", () => {
  it("preserves an imported script's address, witness bytes and signer order", () => {
    const paymentScript: NativeScript = {
      type: "atLeast", required: 2,
      scripts: [hashB, hashA, hashC].map((keyHash) => ({ type: "sig", keyHash })),
    };
    const imported = serializeNativeScript(paymentScript, undefined, 0, true);
    const row = { ...treasury(imported.address), script_cbor: imported.scriptCbor! };
    const resolved = resolveTreasury(row, signers);
    expect(resolved.scriptCbor).toBe(imported.scriptCbor);
    expect(resolved.paymentScript).toEqual(paymentScript);
    expect(resolved.wallet.getScript().address).toBe(imported.address);
    expect(describeTreasury(row, signers).signers.map((s) => s.keyHash)).toEqual([hashB, hashA, hashC]);
  });

  it("rejects drift between stored script, signer keys and threshold", () => {
    expect(() => resolveTreasury(treasury(expected.address), signers.slice(1))).toThrow(InvariantError);
    expect(() => resolveTreasury({ ...treasury(expected.address), required: 1 }, signers)).toThrow(InvariantError);
    expect(() => resolveTreasury({ ...treasury(expected.address), template: "cosigner", cosigner_kind: "app" }, signers)).toThrow(InvariantError);
    expect(() => resolveTreasury(treasury(expected.address), [...signers, signerRow("d".repeat(56), 9, "recovery")])).toThrow(InvariantError);
  });

  it("derives byte-identical script CBOR from DB rows regardless of signer order", () => {
    const resolved = resolveTreasury(treasury(expected.address), signers);
    expect(resolved.scriptCbor).toBe(expected.scriptCbor);
    expect(resolved.address).toBe(expected.address);
    expect(resolved.paymentScript).toEqual({
      type: "atLeast",
      required: 2,
      scripts: [hashC, hashA, hashB]
        .sort((a, b) => a.localeCompare(b))
        .map((keyHash) => ({ type: "sig", keyHash })),
    });
    expect(resolved.shape.template).toBe("plain");
    expect(resolveTreasuryScript(treasury(expected.address), signers).scriptCbor).toBe(
      expected.scriptCbor,
    );
  });

  it("refuses to spend when the derived address no longer matches", () => {
    expect(() => resolveTreasury(treasury("addr_test1somethingelse"), signers)).toThrow(
      InvariantError,
    );
  });
});

describe("templated treasuries", () => {
  const base = { scriptType: "atLeast" as const, required: 2, keyHashes: [hashA, hashB, hashC].sort() };
  const recoveryKeys = ["d".repeat(56), "e".repeat(56)];
  const cosignerKey = "f".repeat(56);

  it("resolves a clawback treasury with its grouped signers and refuses a drifted lock or group", () => {
    const shape = { template: "clawback" as const, base, recovery: { scriptType: "any" as const, required: 1, keyHashes: recoveryKeys }, lockSlot: 5000, cosignerKeyHash: null };
    const built = serializeNativeScript(templateScript(shape), undefined, 0, true);
    const row: TreasuryRow = {
      ...treasury(built.address), script_cbor: built.scriptCbor!, template: "clawback",
      lock_slot: 5000, lock_until: "2027-01-01T00:00:00.000Z", recovery_script_type: "any", recovery_required: 1,
    };
    const grouped = [...signers, ...recoveryKeys.map((k, i) => signerRow(k, 10 + i, "recovery"))];
    const resolved = resolveTreasury(row, grouped);
    expect(resolved.shape).toEqual(shape);
    expect(resolved.address).toBe(built.address);
    const details = describeTreasury(row, grouped);
    expect(details.template).toBe("clawback");
    expect(details.recovery).toEqual({ scriptType: "any", required: 1 });
    expect(details.signers.map((s) => s.group)).toEqual(["base", "base", "base", "recovery", "recovery"]);
    expect(() => resolveTreasury({ ...row, lock_slot: 5001 }, grouped)).toThrow(InvariantError);
    expect(() => resolveTreasury({ ...row, recovery_script_type: "all" }, grouped)).toThrow(InvariantError);
    expect(() => resolveTreasury(row, [...signers, signerRow(recoveryKeys[0]!, 10, "recovery")])).toThrow(InvariantError);
    expect(() => resolveTreasury(row, [...signers, ...recoveryKeys.map((k, i) => signerRow(k, 10 + i, "base"))])).toThrow(InvariantError);
  });

  it("resolves a co-signer treasury and names its co-signer", () => {
    const shape = { template: "cosigner" as const, base, recovery: null, lockSlot: null, cosignerKeyHash: cosignerKey };
    const built = serializeNativeScript(templateScript(shape), undefined, 0, true);
    const row: TreasuryRow = { ...treasury(built.address), script_cbor: built.scriptCbor!, template: "cosigner", cosigner_kind: "app" };
    const grouped = [...signers, signerRow(cosignerKey, 20, "cosigner")];
    expect(resolveTreasury(row, grouped).shape).toEqual(shape);
    expect(describeTreasury(row, grouped).cosigner).toEqual({ kind: "app", keyHash: cosignerKey, walletAddress: "addr_test1signer20" });
    expect(() => resolveTreasury({ ...row, cosigner_kind: null }, grouped)).toThrow(InvariantError);
    expect(() => resolveTreasury(row, signers)).toThrow(InvariantError);
  });
});

describe("describeTreasury", () => {
  it("returns the re-derived script, its hash and signers in script order", () => {
    const details = describeTreasury(treasury(expected.address), signers);
    const resolved = resolveTreasury(treasury(expected.address), signers);
    expect(details).toMatchObject({
      id: "t1",
      name: "Test",
      network: 0,
      address: expected.address,
      scriptType: "atLeast",
      required: 2,
      template: "plain",
      lockSlot: null,
      recovery: null,
      cosigner: null,
      scriptCbor: expected.scriptCbor,
      nativeScript: resolved.paymentScript,
      stakeScript: null,
      drepScript: null,
      cip1854Metadata: null,
      stakeCredentialHash: null,
      stakeAddress: null,
      dRepId: null,
      sdk: false,
      canStake: false,
      canDrep: false,
    });
    expect(details.scriptHash).toMatch(/^[0-9a-f]{56}$/);
    // Signers mirror the `sig` leaves of the script, not the DB row order.
    expect(details.signers.map((s) => s.keyHash)).toEqual(
      resolved.paymentScript.type === "atLeast"
        ? resolved.paymentScript.scripts.map((s) => (s.type === "sig" ? s.keyHash : ""))
        : [],
    );
    expect(details.signers[0]).toEqual({
      walletAddress: "addr_test1signer0",
      keyHash: hashC,
      displayName: null,
      group: "base",
      stakeKeyHash: null,
      drepKeyHash: null,
    });
  });

  it("refuses a drifted treasury like resolveTreasury does", () => {
    expect(() => describeTreasury(treasury("addr_test1somethingelse"), signers)).toThrow(
      InvariantError,
    );
  });

  it("exposes stake/DRep scripts and CIP-1854 metadata for an SDK treasury", () => {
    const paymentHashes = [hashA, hashB, hashC];
    const stakeHashes = [stakeA, stakeB, stakeC];
    const sdkWallet = new MultisigWallet(
      "SDK",
      [
        ...paymentHashes.map((keyHash) => ({ keyHash, role: 0, name: "" })),
        ...stakeHashes.map((keyHash) => ({ keyHash, role: 2, name: "" })),
      ],
      "",
      2,
      0,
    );
    const built = sdkWallet.getScript();
    const row = { ...treasury(built.address), name: "SDK", script_cbor: built.scriptCbor ?? "" };
    const sdkSigners = paymentHashes.map((key_hash, i) =>
      signerRow(key_hash, i, "base", { stake_key_hash: stakeHashes[i]!, drep_key_hash: null }),
    );

    const details = describeTreasury(row, sdkSigners);
    const { wallet } = resolveTreasury(row, sdkSigners);
    const stakeNative = wallet.buildScript(2)!;
    const stakeCbor = wallet.getStakingScript()!;
    const drepCbor = wallet.getDRepScript()!;

    expect(details.sdk).toBe(true);
    expect(details.canStake).toBe(true);
    expect(details.canDrep).toBe(true);
    expect(details.stakeScript).toEqual({
      nativeScript: stakeNative,
      scriptCbor: stakeCbor,
      scriptHash: resolveNativeScriptHash(stakeNative),
    });
    expect(details.drepScript).toEqual({
      nativeScript: details.nativeScript,
      scriptCbor: drepCbor,
      scriptHash: details.scriptHash,
      paymentFallback: true,
    });
    expect(details.drepScript?.scriptCbor).toBe(details.scriptCbor);
    expect(details.cip1854Metadata).toEqual(wallet.getJsonMetadata());
    expect(details.signers.map((s) => s.stakeKeyHash)).toEqual(
      expect.arrayContaining(stakeHashes),
    );
  });

  it("marks dedicated DRep keys without paymentFallback", () => {
    const paymentHashes = [hashA, hashB, hashC];
    const stakeHashes = [stakeA, stakeB, stakeC];
    const drepHashes = [drepA, drepB, drepC];
    const sdkWallet = new MultisigWallet(
      "SDK DRep",
      [
        ...paymentHashes.map((keyHash) => ({ keyHash, role: 0, name: "" })),
        ...stakeHashes.map((keyHash) => ({ keyHash, role: 2, name: "" })),
        ...drepHashes.map((keyHash) => ({ keyHash, role: 3, name: "" })),
      ],
      "",
      2,
      0,
    );
    const built = sdkWallet.getScript();
    const row = {
      ...treasury(built.address),
      name: "SDK DRep",
      script_cbor: built.scriptCbor ?? "",
    };
    const sdkSigners = paymentHashes.map((key_hash, i) =>
      signerRow(key_hash, i, "base", {
        stake_key_hash: stakeHashes[i]!,
        drep_key_hash: drepHashes[i]!,
      }),
    );

    const details = describeTreasury(row, sdkSigners);
    const { wallet } = resolveTreasury(row, sdkSigners);
    const drepNative = wallet.buildScript(3)!;
    expect(details.drepScript).toEqual({
      nativeScript: drepNative,
      scriptCbor: wallet.getDRepScript(),
      scriptHash: resolveNativeScriptHash(drepNative),
      paymentFallback: false,
    });
    expect(details.drepScript?.scriptCbor).not.toBe(details.scriptCbor);
    expect(details.signers.every((s) => s.drepKeyHash)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  defaultPath,
  describeTemplate,
  lockOpen,
  pathOffered,
  pathParticipants,
  pathRule,
  pathsOfTemplate,
  signerCounts,
  type PathSigner,
  type PathTreasury,
} from "./spendingPaths";

const signers: PathSigner[] = [
  { wallet_address: "addr_a", signer_group: "base" },
  { wallet_address: "addr_b", signer_group: "base" },
  { wallet_address: "addr_c", signer_group: "base" },
  { wallet_address: "addr_r1", signer_group: "recovery" },
  { wallet_address: "addr_r2", signer_group: "recovery" },
  { wallet_address: "addr_co", signer_group: "cosigner" },
];

const plain: PathTreasury = {
  template: "plain", script_type: "atLeast", required: 2,
  recovery_script_type: null, recovery_required: null, lock_until: null, cosigner_kind: null,
};
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();
const clawback: PathTreasury = { ...plain, template: "clawback", recovery_script_type: "any", recovery_required: 1, lock_until: future };
const locked: PathTreasury = { ...plain, template: "lock_until", lock_until: future };
const cosigner: PathTreasury = { ...plain, template: "cosigner", cosigner_kind: "member" };

describe("paths of a template", () => {
  it("lists what each template offers and its default", () => {
    expect(pathsOfTemplate("plain")).toEqual(["base"]);
    expect(pathsOfTemplate("clawback")).toEqual(["base", "recovery"]);
    expect(pathsOfTemplate("lock_until")).toEqual(["base"]);
    expect(pathsOfTemplate("cosigner")).toEqual(["cosigned", "bypass"]);
    expect(defaultPath("plain")).toBe("base");
    expect(defaultPath("cosigner")).toBe("cosigned");
  });
});

describe("pathRule", () => {
  it("takes the group of the path and the co-signer when co-signed", () => {
    expect(pathRule(plain, signers, "base")).toEqual({ scriptType: "atLeast", required: 2, members: ["addr_a", "addr_b", "addr_c"], alsoRequired: [] });
    expect(pathRule(clawback, signers, "recovery")).toEqual({ scriptType: "any", required: 1, members: ["addr_r1", "addr_r2"], alsoRequired: [] });
    expect(pathRule(cosigner, signers, "cosigned")).toEqual({ scriptType: "atLeast", required: 2, members: ["addr_a", "addr_b", "addr_c"], alsoRequired: ["addr_co"] });
    expect(pathRule(cosigner, signers, "bypass")).toEqual({ scriptType: "all", required: 3, members: ["addr_a", "addr_b", "addr_c"], alsoRequired: [] });
    expect(pathParticipants(pathRule(cosigner, signers, "cosigned"))).toEqual(["addr_a", "addr_b", "addr_c", "addr_co"]);
  });
});

describe("pathOffered", () => {
  const now = Date.now();
  it("refuses a path the template lacks", () => {
    expect(pathOffered(plain, "recovery", "payment", now)).toEqual({ ok: false, reason: expect.stringMatching(/does not offer/) });
    expect(pathOffered(cosigner, "base", "payment", now).ok).toBe(false);
    expect(pathOffered(plain, "base", "payout", now)).toEqual({ ok: true });
  });
  it("holds a lock-until treasury until the date", () => {
    expect(pathOffered(locked, "base", "payout", now)).toEqual({ ok: false, reason: expect.stringMatching(/locked until/) });
    expect(pathOffered({ ...locked, lock_until: past }, "base", "payout", now)).toEqual({ ok: true });
    expect(lockOpen(locked, now)).toBe(false);
    expect(lockOpen(plain, now)).toBe(true);
  });
  it("opens recovery from the date, for payments only; the base path is never held", () => {
    expect(pathOffered(clawback, "base", "payout", now)).toEqual({ ok: true });
    expect(pathOffered(clawback, "recovery", "payment", now)).toEqual({ ok: false, reason: expect.stringMatching(/from/) });
    const open = { ...clawback, lock_until: past };
    expect(pathOffered(open, "recovery", "payment", now)).toEqual({ ok: true });
    expect(pathOffered(open, "recovery", "payout", now)).toEqual({ ok: false, reason: expect.stringMatching(/payments only/) });
    expect(pathOffered(open, "recovery", "anchor", now).ok).toBe(false);
  });
  it("offers both co-signer paths at any time", () => {
    expect(pathOffered(cosigner, "cosigned", "mint", now)).toEqual({ ok: true });
    expect(pathOffered(cosigner, "bypass", "anchor", now)).toEqual({ ok: true });
  });
});

describe("describeTemplate", () => {
  it("says the base rule and what the template adds", () => {
    expect(describeTemplate(plain)).toBe("2 of N");
    expect(describeTemplate(plain, { base: 3 })).toBe("2 of 3");
    expect(describeTemplate(clawback, { base: 3 })).toMatch(/^2 of 3 · recovery from /);
    expect(describeTemplate(locked)).toMatch(/^2 of N · locked until /);
    expect(describeTemplate(cosigner, { base: 3 })).toBe("2 of 3 + co-signer");
  });

  it("counts the signers of each group from the embedded rows", () => {
    expect(signerCounts(signers)).toEqual({ base: 3, recovery: 2, cosigner: 1 });
    expect(describeTemplate(cosigner, signerCounts(signers))).toBe("2 of 3 + co-signer");
    expect(signerCounts([])).toEqual({});
  });
});

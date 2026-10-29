import { describe, expect, it } from "vitest";
import { MultisigWallet } from "./multisigSDK";

const PAY = ["1".repeat(56), "2".repeat(56)];
const STAKE = ["3".repeat(56), "4".repeat(56)];
const DREP = ["5".repeat(56), "6".repeat(56)];

function wallet(extra: { keyHash: string; role: number; name: string }[] = []) {
  return new MultisigWallet(
    "W",
    [
      ...PAY.map((keyHash) => ({ keyHash, role: 0, name: "" })),
      ...STAKE.map((keyHash) => ({ keyHash, role: 2, name: "" })),
      ...extra,
    ],
    "",
    2,
    0,
  );
}

describe("MultisigWallet DRep helpers", () => {
  it("falls back to the payment script when role-3 is incomplete", () => {
    const w = wallet();
    expect(w.drepEnabled()).toBe(false);
    expect(w.getDRepScript()).toBe(w.getPaymentScript());
    expect(w.getDRepId()).toMatch(/^drep/);
  });

  it("uses a dedicated DRep script when role-3 is complete", () => {
    const w = wallet(DREP.map((keyHash) => ({ keyHash, role: 3, name: "" })));
    expect(w.drepEnabled()).toBe(true);
    expect(w.getDRepScript()).not.toBe(w.getPaymentScript());
    expect(w.getStakingScript()).toBeTruthy();
    expect(w.getStakeAddress()).toMatch(/^stake/);
  });
});

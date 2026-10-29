import { describe, expect, it } from "vitest";
import { TreasuryTemplate } from "@/lib/constants";
import { MultisigWallet } from "./multisigSDK";
import { canDrep, canStake, canVote, isSdkTreasury } from "./sdkCapabilities";

const PAY_A = "a".repeat(56);
const PAY_B = "b".repeat(56);
const STAKE_A = "c".repeat(56);
const STAKE_B = "d".repeat(56);
const DREP_A = "e".repeat(56);
const DREP_B = "f".repeat(56);

function wallet(keys: { keyHash: string; role: number }[]) {
  return new MultisigWallet(
    "Test",
    keys.map((k) => ({ ...k, name: "" })),
    "",
    2,
    0,
  );
}

const plain = { template: TreasuryTemplate.Plain };
const clawback = { template: TreasuryTemplate.Clawback };

describe("sdkCapabilities", () => {
  const legacy = wallet([
    { keyHash: PAY_A, role: 0 },
    { keyHash: PAY_B, role: 0 },
  ]);
  const sdk = wallet([
    { keyHash: PAY_A, role: 0 },
    { keyHash: PAY_B, role: 0 },
    { keyHash: STAKE_A, role: 2 },
    { keyHash: STAKE_B, role: 2 },
  ]);
  const sdkWithDrep = wallet([
    { keyHash: PAY_A, role: 0 },
    { keyHash: PAY_B, role: 0 },
    { keyHash: STAKE_A, role: 2 },
    { keyHash: STAKE_B, role: 2 },
    { keyHash: DREP_A, role: 3 },
    { keyHash: DREP_B, role: 3 },
  ]);

  it("treats only plain + complete stake keys as SDK", () => {
    expect(isSdkTreasury(plain, legacy)).toBe(false);
    expect(isSdkTreasury(plain, sdk)).toBe(true);
    expect(isSdkTreasury(clawback, sdk)).toBe(false);
  });

  it("allows staking only on SDK treasuries with a stake script", () => {
    expect(canStake(plain, legacy)).toBe(false);
    expect(canStake(plain, sdk)).toBe(true);
    expect(canStake(clawback, sdk)).toBe(false);
  });

  it("allows DRep/vote on SDK treasuries with payment-script fallback", () => {
    expect(canDrep(plain, legacy)).toBe(false);
    expect(canDrep(plain, sdk)).toBe(true);
    expect(canVote(plain, sdk)).toBe(true);
    expect(sdk.getDRepScript()).toBe(sdk.getPaymentScript());
    expect(canDrep(plain, sdkWithDrep)).toBe(true);
    expect(sdkWithDrep.getDRepScript()).not.toBe(sdkWithDrep.getPaymentScript());
  });
});

import { describe, expect, it } from "vitest";
import { classifyPoolRewardWithdraw, isPoolRewardsBufferPurpose } from "./classify";

const POOL_A = {
  id: "pool-a",
  fundingSourceId: "fs-a",
  rewardAddresses: ["stake1reward"],
  treasuryIds: ["treas-1"] as string[],
};

const POOL_B = {
  id: "pool-b",
  fundingSourceId: "fs-b",
  rewardAddresses: ["stake1other"],
  treasuryIds: [] as string[],
};

describe("classifyPoolRewardWithdraw", () => {
  it("books a matching withdraw into the mapped treasury", () => {
    expect(
      classifyPoolRewardWithdraw({
        treasuryId: "treas-1",
        withdrawals: [{ stakeAddr: "stake1reward", amount: "2500000" }],
        pools: [POOL_A, POOL_B],
      }),
    ).toEqual({
      stakePoolId: "pool-a",
      fundingSourceId: "fs-a",
      amountLovelace: "2500000",
    });
  });

  it("sums multiple withdrawals for the same pool", () => {
    expect(
      classifyPoolRewardWithdraw({
        treasuryId: "treas-1",
        withdrawals: [
          { stakeAddr: "stake1reward", amount: "100" },
          { stakeAddr: "stake1reward", amount: "50" },
        ],
        pools: [POOL_A],
      })?.amountLovelace,
    ).toBe("150");
  });

  it("ignores an unrelated treasury when the pool lists destinations", () => {
    expect(
      classifyPoolRewardWithdraw({
        treasuryId: "treas-other",
        withdrawals: [{ stakeAddr: "stake1reward", amount: "2500000" }],
        pools: [POOL_A],
      }),
    ).toBeNull();
  });

  it("allows any treasury when the pool has no community_treasury mapping", () => {
    expect(
      classifyPoolRewardWithdraw({
        treasuryId: "any",
        withdrawals: [{ stakeAddr: "stake1other", amount: "9" }],
        pools: [POOL_B],
      }),
    ).toMatchObject({ stakePoolId: "pool-b", amountLovelace: "9" });
  });

  it("ignores zero and unknown stake addresses", () => {
    expect(
      classifyPoolRewardWithdraw({
        treasuryId: "treas-1",
        withdrawals: [
          { stakeAddr: "stake1reward", amount: "0" },
          { stakeAddr: "stake1nope", amount: "100" },
        ],
        pools: [POOL_A],
      }),
    ).toBeNull();
  });
});

describe("isPoolRewardsBufferPurpose", () => {
  it("recognises pool_rewards floats", () => {
    expect(isPoolRewardsBufferPurpose("pool_rewards")).toBe(true);
    expect(isPoolRewardsBufferPurpose("dex")).toBe(false);
    expect(isPoolRewardsBufferPurpose(null)).toBe(false);
  });
});

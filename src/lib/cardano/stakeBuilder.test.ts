import { beforeEach, describe, expect, it, vi } from "vitest";
import { StakeAction } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
}));
vi.mock("./certTxBuilder", () => ({ completeCertTx: mocks.complete }));

import { buildStakeTx } from "./stakeBuilder";

function fakeBuilder() {
  const calls: string[] = [];
  const self = {
    calls,
    registerStakeCertificate: (addr: string) => {
      calls.push(`register:${addr}`);
      return self;
    },
    delegateStakeCertificate: (addr: string, pool: string) => {
      calls.push(`delegate:${addr}:${pool}`);
      return self;
    },
    deregisterStakeCertificate: (addr: string) => {
      calls.push(`deregister:${addr}`);
      return self;
    },
    withdrawal: (addr: string, amount: string) => {
      calls.push(`withdraw:${addr}:${amount}`);
      return self;
    },
    withdrawalScript: (cbor: string) => {
      calls.push(`withdrawalScript:${cbor}`);
      return self;
    },
    voteDelegationCertificate: (drep: unknown, addr: string) => {
      calls.push(`voteDelegation:${JSON.stringify(drep)}:${addr}`);
      return self;
    },
    certificateScript: (cbor: string) => {
      calls.push(`certificateScript:${cbor}`);
      return self;
    },
  };
  return self;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.complete.mockImplementation(async (opts: { apply: (b: ReturnType<typeof fakeBuilder>) => void }) => {
    const builder = fakeBuilder();
    opts.apply(builder);
    return { unsignedTxHex: "84a0", txHash: "f".repeat(64), builder };
  });
});

const base = {
  treasuryAddress: "addr_test1treasury",
  paymentScriptCbor: "pay",
  stakingScriptCbor: "stake",
  rewardAddress: "stake_test1reward",
  network: 0 as const,
  provider: {} as never,
};

describe("buildStakeTx", () => {
  it("registers and delegates with both certificates and the stake script", async () => {
    const result = await buildStakeTx({
      ...base,
      action: StakeAction.RegisterAndDelegate,
      poolId: "pool1abc",
    });
    expect(result.txHash).toHaveLength(64);
    const { builder } = await mocks.complete.mock.results[0]!.value;
    expect(builder.calls).toEqual([
      "register:stake_test1reward",
      "certificateScript:stake",
      "delegate:stake_test1reward:pool1abc",
      "certificateScript:stake",
    ]);
    expect(mocks.complete.mock.calls[0]![0].depositLovelace).toBe(2_000_000n);
  });

  it("withdraws through withdrawalScript (not certificateScript alone)", async () => {
    await buildStakeTx({
      ...base,
      action: StakeAction.Withdraw,
      rewards: "5000000",
    });
    const { builder } = await mocks.complete.mock.results[0]!.value;
    expect(builder.calls).toEqual([
      "withdraw:stake_test1reward:5000000",
      "withdrawalScript:stake",
    ]);
  });

  it("refuses a zero reward withdrawal", async () => {
    await expect(
      buildStakeTx({ ...base, action: StakeAction.Withdraw, rewards: "0" }),
    ).rejects.toThrow(/No rewards/);
  });

  it("vote-delegates always_abstain", async () => {
    await buildStakeTx({
      ...base,
      action: StakeAction.VoteDelegation,
      dRepId: "always_abstain",
    });
    const { builder } = await mocks.complete.mock.results[0]!.value;
    expect(builder.calls[0]).toContain("alwaysAbstain");
    expect(builder.calls).toContain("certificateScript:stake");
  });
});

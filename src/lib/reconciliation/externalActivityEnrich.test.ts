import { beforeEach, describe, expect, it, vi } from "vitest";
import { StakeAction, TxKind } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  lookupStakePool: vi.fn(),
  lookupDrep: vi.fn(),
}));
vi.mock("@/lib/cardano/koios", () => ({
  lookupStakePool: mocks.lookupStakePool,
  lookupDrep: mocks.lookupDrep,
}));

import {
  enrichStakeActivityLabels,
  stakeActivityLabelsChanged,
  stakeActivityNeedsLabels,
} from "./externalActivityEnrich";

beforeEach(() => {
  mocks.lookupStakePool.mockReset();
  mocks.lookupDrep.mockReset();
});

describe("stakeActivityNeedsLabels", () => {
  it("is false for null, non-stake, and already-labeled stake", () => {
    expect(stakeActivityNeedsLabels(null)).toBe(false);
    expect(stakeActivityNeedsLabels({ kind: TxKind.Registration })).toBe(false);
    expect(
      stakeActivityNeedsLabels({
        kind: TxKind.Stake,
        action: StakeAction.Delegate,
        poolId: "pool1",
        poolTicker: "ABC",
      }),
    ).toBe(false);
    expect(
      stakeActivityNeedsLabels({
        kind: TxKind.Stake,
        action: StakeAction.VoteDelegation,
        dRepId: "always_abstain",
      }),
    ).toBe(false);
  });

  it("is true when pool or DRep labels are missing", () => {
    expect(
      stakeActivityNeedsLabels({
        kind: TxKind.Stake,
        action: StakeAction.Delegate,
        poolId: "pool1",
      }),
    ).toBe(true);
    expect(
      stakeActivityNeedsLabels({
        kind: TxKind.Stake,
        action: StakeAction.VoteDelegation,
        dRepId: "drep1medusa",
      }),
    ).toBe(true);
  });
});

describe("enrichStakeActivityLabels", () => {
  it("fills ticker and DRep name from Koios", async () => {
    mocks.lookupStakePool.mockResolvedValue({ ticker: "SIG" });
    mocks.lookupDrep.mockResolvedValue({ givenName: "Medusa" });
    expect(
      await enrichStakeActivityLabels(
        {
          kind: TxKind.Stake,
          action: StakeAction.VoteDelegation,
          poolId: "pool1abc",
          dRepId: "drep1medusa",
        },
        0,
      ),
    ).toEqual({
      kind: TxKind.Stake,
      action: StakeAction.VoteDelegation,
      poolId: "pool1abc",
      dRepId: "drep1medusa",
      poolTicker: "SIG",
      dRepName: "Medusa",
    });
  });

  it("is a no-op when labels are already set or activity is not stake", async () => {
    const labeled = {
      kind: TxKind.Stake,
      action: StakeAction.Delegate,
      poolId: "pool1",
      poolTicker: "SIG",
    };
    expect(await enrichStakeActivityLabels(labeled, 0)).toBe(labeled);
    expect(mocks.lookupStakePool).not.toHaveBeenCalled();

    const reg = { kind: TxKind.Registration };
    expect(await enrichStakeActivityLabels(reg, 0)).toBe(reg);
    expect(await enrichStakeActivityLabels(null, 0)).toBeNull();
  });

  it("keeps ids when lookups fail", async () => {
    mocks.lookupDrep.mockRejectedValue(new Error("koios 503"));
    const activity = {
      kind: TxKind.Stake,
      action: StakeAction.VoteDelegation,
      dRepId: "drep1medusa",
    };
    expect(await enrichStakeActivityLabels(activity, 0)).toEqual(activity);
  });
});

describe("stakeActivityLabelsChanged", () => {
  it("detects newly filled ticker or name", () => {
    expect(
      stakeActivityLabelsChanged(
        { kind: TxKind.Stake, action: StakeAction.Delegate, poolId: "p1" },
        {
          kind: TxKind.Stake,
          action: StakeAction.Delegate,
          poolId: "p1",
          poolTicker: "SIG",
        },
      ),
    ).toBe(true);
    expect(
      stakeActivityLabelsChanged(
        {
          kind: TxKind.Stake,
          action: StakeAction.Delegate,
          poolId: "p1",
          poolTicker: "SIG",
        },
        {
          kind: TxKind.Stake,
          action: StakeAction.Delegate,
          poolId: "p1",
          poolTicker: "SIG",
        },
      ),
    ).toBe(false);
  });
});

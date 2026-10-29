import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignerGroup } from "@/lib/constants";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("./payoutBuilder", () => ({ completeTreasuryTx: mocks.complete }));

import { buildRegistrationTx, registrationRecord } from "./registrationBuilder";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.complete.mockResolvedValue({ unsignedTxHex: "84a0", txHash: "f".repeat(64) });
});

describe("registrationRecord", () => {
  it("builds label-1854 metadata from treasury signers", () => {
    const record = registrationRecord(
      { name: "Main" },
      [{
        key_hash: "a".repeat(56),
        stake_key_hash: null,
        drep_key_hash: null,
        display_name: "Alice",
        signer_group: SignerGroup.Base,
      }],
    );
    expect(record).toEqual({
      types: [0],
      name: "Main",
      participants: { ["a".repeat(56)]: { name: "Alice" } },
    });
  });
});

describe("buildRegistrationTx", () => {
  const BASE = {
    treasuryAddress: "addr_test1treasury",
    scriptCbor: "00",
    network: 0 as const,
    provider: {} as never,
    record: { types: [0], name: "Main", participants: { ["a".repeat(56)]: { name: "Alice" } } },
    message: "Treasury Guild registration: signius 2026-10-29",
  };

  it("completes a change-only transaction with label 1854 and CIP-20", async () => {
    expect(await buildRegistrationTx(BASE)).toEqual({ unsignedTxHex: "84a0", txHash: "f".repeat(64) });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      treasuryAddress: BASE.treasuryAddress,
      outputs: [],
      metadata: [
        ["1854", BASE.record],
        ["674", expect.anything()],
      ],
    }));
  });

  it("forwards the lock slot", async () => {
    await buildRegistrationTx({ ...BASE, validFromSlot: 123_456 });
    expect(mocks.complete.mock.calls[0]?.[0].validFromSlot).toBe(123_456);
  });
});

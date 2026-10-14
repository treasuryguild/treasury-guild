import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IFetcher } from "@meshsdk/common";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("./payoutBuilder", () => ({ completeTreasuryTx: mocks.complete }));

import { buildAnchorTx } from "./anchorBuilder";

const BASE = {
  treasuryAddress: "addr_test1treasury",
  scriptCbor: "8201828200581c",
  network: 0 as const,
  provider: {} as IFetcher,
  record: { v: 1, src: "guild-vault", c: "signius", a: [[1, "proposed", "a".repeat(64), "b".repeat(64)]] },
  message: "Guild Vault: anchor of proposal #1",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.complete.mockResolvedValue({ unsignedTxHex: "84a0", txHash: "f".repeat(64) });
});

describe("buildAnchorTx", () => {
  it("builds a metadata-only transaction: no outputs, the 190002 record and a CIP-20 message", async () => {
    expect(await buildAnchorTx(BASE)).toEqual({ unsignedTxHex: "84a0", txHash: "f".repeat(64) });
    const opts = mocks.complete.mock.calls[0]![0];
    expect(opts).toMatchObject({
      treasuryAddress: "addr_test1treasury", scriptCbor: BASE.scriptCbor, network: 0, provider: BASE.provider, outputs: [], totalByUnit: new Map(),
    });
    expect(opts.metadata).toEqual([
      ["190002", BASE.record],
      ["674", { msg: ["Guild Vault: anchor of proposal #1"] }],
    ]);
  });

  it("passes the lock slot through, so a lock-until or recovery path can spend", async () => {
    await buildAnchorTx({ ...BASE, validFromSlot: 123_456 });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ validFromSlot: 123_456 }));
  });

  it("refuses a record over the metadata budget before touching the chain", async () => {
    const record = { ...BASE.record, a: Array.from({ length: 400 }, (_, n) => [n, "proposed", "a".repeat(64), "b".repeat(64)]) };
    await expect(buildAnchorTx({ ...BASE, record })).rejects.toThrow(/^Anchor record too large/);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

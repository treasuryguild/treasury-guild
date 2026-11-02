// One treasury's sync: the poll, then the chain import (also when the poll
// found nothing: the backfill), combined into one result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainImportRunResult } from "@/lib/chainImport/run";
import { ChainImportIssueCode } from "@/lib/constants";
import type { PollResult } from "./poll";

const mocks = vi.hoisted(() => ({
  pollTreasury: vi.fn(),
  importExternalTxs: vi.fn(),
  classifyUnlabeledExternalTxs: vi.fn(),
  enrichIncompleteExternalLabels: vi.fn(),
}));
vi.mock("@/lib/reconciliation/poll", () => ({ pollTreasury: mocks.pollTreasury }));
vi.mock("@/lib/chainImport/run", () => ({ importExternalTxs: mocks.importExternalTxs }));
vi.mock("@/lib/reconciliation/classifyExternal", () => ({
  classifyUnlabeledExternalTxs: mocks.classifyUnlabeledExternalTxs,
  enrichIncompleteExternalLabels: mocks.enrichIncompleteExternalLabels,
}));

import { syncTreasury } from "./syncTreasury";

const TREASURY = { id: "t-1", community_id: "c-1", address: "addr_test1_treasury", network: 0 };
const NOTHING_NEW: PollResult = { newIncoming: 0, confirmed: 0, newExternal: 0 };
const POLLED: PollResult = { newIncoming: 2, confirmed: 1, newExternal: 3 };
const IMPORTED: ChainImportRunResult = {
  imported: ["h-1", "h-2"],
  blocked: [{ txHash: "h-3", issues: [{ code: ChainImportIssueCode.BadMetadata, detail: "p is not a list" }] }],
};
const NONE_IMPORTED: ChainImportRunResult = { imported: [], blocked: [] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.pollTreasury.mockResolvedValue(POLLED);
  mocks.importExternalTxs.mockResolvedValue(IMPORTED);
  mocks.classifyUnlabeledExternalTxs.mockResolvedValue({ classified: 0 });
  mocks.enrichIncompleteExternalLabels.mockResolvedValue({ enriched: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncTreasury", () => {
  it("polls, then imports, classifies, enriches labels, and reports all as one result", async () => {
    mocks.classifyUnlabeledExternalTxs.mockResolvedValue({ classified: 4 });
    mocks.enrichIncompleteExternalLabels.mockResolvedValue({ enriched: 2 });
    expect(await syncTreasury(TREASURY)).toEqual({
      newIncoming: 2, confirmed: 1, newExternal: 3, imported: 2, importBlocked: 1,
      classified: 4, labelsEnriched: 2,
    });
    expect(mocks.pollTreasury).toHaveBeenCalledExactlyOnceWith(TREASURY);
    expect(mocks.importExternalTxs).toHaveBeenCalledExactlyOnceWith(TREASURY);
    expect(mocks.classifyUnlabeledExternalTxs).toHaveBeenCalledExactlyOnceWith(TREASURY);
    expect(mocks.enrichIncompleteExternalLabels).toHaveBeenCalledExactlyOnceWith(TREASURY);
    expect(mocks.pollTreasury.mock.invocationCallOrder[0]!).toBeLessThan(mocks.importExternalTxs.mock.invocationCallOrder[0]!);
    expect(mocks.importExternalTxs.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.classifyUnlabeledExternalTxs.mock.invocationCallOrder[0]!,
    );
    expect(mocks.classifyUnlabeledExternalTxs.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.enrichIncompleteExternalLabels.mock.invocationCallOrder[0]!,
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("runs the import even when the poll found nothing new (the backfill)", async () => {
    mocks.pollTreasury.mockResolvedValue(NOTHING_NEW);
    expect(await syncTreasury(TREASURY)).toEqual({
      ...NOTHING_NEW, imported: 2, importBlocked: 1, classified: 0, labelsEnriched: 0,
    });
    expect(mocks.importExternalTxs).toHaveBeenCalledExactlyOnceWith(TREASURY);
    expect(mocks.classifyUnlabeledExternalTxs).toHaveBeenCalledExactlyOnceWith(TREASURY);
    expect(mocks.enrichIncompleteExternalLabels).toHaveBeenCalledExactlyOnceWith(TREASURY);
  });

  it("reports zero imports when nothing was importable", async () => {
    mocks.importExternalTxs.mockResolvedValue(NONE_IMPORTED);
    expect(await syncTreasury(TREASURY)).toEqual({
      ...POLLED, imported: 0, importBlocked: 0, classified: 0, labelsEnriched: 0,
    });
  });

  it("keeps the poll's result and logs when the import throws, then still classifies", async () => {
    const err = new Error("koios tx_cbor 503");
    mocks.importExternalTxs.mockRejectedValue(err);
    mocks.classifyUnlabeledExternalTxs.mockResolvedValue({ classified: 2 });
    expect(await syncTreasury(TREASURY)).toEqual({
      ...POLLED, imported: 0, importBlocked: 0, classified: 2, labelsEnriched: 0,
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("chain import for treasury t-1 failed", err);
    expect(mocks.classifyUnlabeledExternalTxs).toHaveBeenCalledExactlyOnceWith(TREASURY);
  });

  it("keeps import counts and logs when classify throws, then still enriches", async () => {
    const err = new Error("koios tx_info 503");
    mocks.classifyUnlabeledExternalTxs.mockRejectedValue(err);
    mocks.enrichIncompleteExternalLabels.mockResolvedValue({ enriched: 1 });
    expect(await syncTreasury(TREASURY)).toEqual({
      ...POLLED, imported: 2, importBlocked: 1, classified: 0, labelsEnriched: 1,
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "external activity classify for treasury t-1 failed",
      err,
    );
    expect(mocks.enrichIncompleteExternalLabels).toHaveBeenCalledExactlyOnceWith(TREASURY);
  });

  it("keeps classify counts and logs when label enrich throws", async () => {
    const err = new Error("koios pool 503");
    mocks.enrichIncompleteExternalLabels.mockRejectedValue(err);
    expect(await syncTreasury(TREASURY)).toEqual({
      ...POLLED, imported: 2, importBlocked: 1, classified: 0, labelsEnriched: 0,
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "external label enrich for treasury t-1 failed",
      err,
    );
  });

  it("lets a poll failure through and never imports on top of it", async () => {
    mocks.pollTreasury.mockRejectedValue(new Error("koios 503"));
    await expect(syncTreasury(TREASURY)).rejects.toThrow("koios 503");
    expect(mocks.importExternalTxs).not.toHaveBeenCalled();
    expect(mocks.classifyUnlabeledExternalTxs).not.toHaveBeenCalled();
    expect(mocks.enrichIncompleteExternalLabels).not.toHaveBeenCalled();
  });
});

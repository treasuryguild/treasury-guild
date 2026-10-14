import { describe, expect, it } from "vitest";
import { CHAIN_SYNC_STALE_MS, staleBefore } from "./staleSync";

describe("staleBefore", () => {
  it("is the staleness window before now, as an ISO timestamp", () => {
    const now = new Date("2026-09-16T10:02:00.000Z");
    expect(staleBefore(now)).toBe("2026-09-16T10:00:00.000Z");
    expect(CHAIN_SYNC_STALE_MS).toBe(120_000);
  });
});

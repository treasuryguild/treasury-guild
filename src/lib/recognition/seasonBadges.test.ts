import { describe, expect, it } from "vitest";
import { seasonBadgeDrafts } from "./seasonBadges";

describe("seasonBadgeDrafts", () => {
  it("builds one draft per wallet with season traits", () => {
    const drafts = seasonBadgeDrafts("2026-Q2", ["addr_a", "addr_b"], "Guild");
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.traits.season).toBe("2026-Q2");
    expect(drafts[0]!.traits.tier).toBe("Exemplar");
    expect(drafts[0]!.recipientWallet).toBe("addr_a");
    expect(new TextEncoder().encode(drafts[0]!.name).length).toBeLessThanOrEqual(32);
  });
});

import { describe, expect, it } from "vitest";
import { inviteExpiresAt } from "./options";

describe("inviteExpiresAt", () => {
  it("returns null when the invite never expires", () => {
    expect(inviteExpiresAt(null, 0)).toBeNull();
  });

  it("adds whole days from now", () => {
    expect(inviteExpiresAt(7, Date.UTC(2026, 0, 1))).toBe("2026-01-08T00:00:00.000Z");
    expect(inviteExpiresAt(30, Date.UTC(2026, 0, 1))).toBe("2026-01-31T00:00:00.000Z");
  });
});

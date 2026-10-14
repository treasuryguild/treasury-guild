import { describe, expect, it } from "vitest";
import { INSTALL_CLAIM_WINDOW_MS, installationClaim } from "./installClaim";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("installationClaim", () => {
  it("never moves an installation another community holds", () => {
    expect(installationClaim({ community_id: "b" }, "a", { created_at: ago(1000) }, NOW)).toBe("taken");
  });

  it("updates the community's own installation however old", () => {
    expect(installationClaim({ community_id: "a" }, "a", { created_at: ago(400 * 86_400_000) }, NOW)).toBe("update");
  });

  it("claims an unbound installation GitHub just created or updated", () => {
    expect(installationClaim(null, "a", { created_at: ago(60_000) }, NOW)).toBe("insert");
    expect(installationClaim(null, "a", { created_at: ago(90 * 86_400_000), updated_at: ago(60_000) }, NOW)).toBe("insert");
  });

  it("refuses an unbound installation outside the window or without dates", () => {
    expect(installationClaim(null, "a", { created_at: ago(INSTALL_CLAIM_WINDOW_MS + 1) }, NOW)).toBe("stale");
    expect(installationClaim(null, "a", {}, NOW)).toBe("stale");
    expect(installationClaim(null, "a", { created_at: "not a date" }, NOW)).toBe("stale");
  });
});

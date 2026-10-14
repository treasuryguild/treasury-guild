import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({ loadIntegrationSecrets: mocks.load, saveIntegrationSecrets: mocks.save }));

import { connectionAccessToken, expiresAt, EXPIRY_MARGIN_MS } from "./token";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

describe("expiresAt", () => {
  it("adds the lifetime in seconds to now", () => {
    expect(expiresAt(60, NOW)).toBe("2026-09-30T12:01:00.000Z");
    expect(expiresAt(7200, NOW)).toBe("2026-09-30T14:00:00.000Z");
  });

  it("defaults to an hour when the provider sends no lifetime", () => {
    expect(expiresAt(undefined, NOW)).toBe("2026-09-30T13:00:00.000Z");
  });

  it("keeps a zero lifetime as zero: already expired, not an hour", () => {
    expect(expiresAt(0, NOW)).toBe("2026-09-30T12:00:00.000Z");
  });

  it("counts from the current time by default", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      expect(expiresAt(30)).toBe("2026-09-30T12:00:30.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connectionAccessToken", () => {
  const secrets = (expiresInMs: number, access = "old-access") => ({
    access_token: access,
    refresh_token: "old-refresh",
    expires_at: new Date(NOW + expiresInMs).toISOString(),
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the stored token while it is valid beyond the margin", async () => {
    mocks.load.mockResolvedValue(secrets(EXPIRY_MARGIN_MS + 1));
    const refresh = vi.fn();
    expect(await connectionAccessToken("int-1", "Zoom", refresh)).toBe("old-access");
    expect(mocks.load).toHaveBeenCalledWith("int-1");
    expect(refresh).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refreshes at the margin and saves the new pair before using it", async () => {
    const current = secrets(EXPIRY_MARGIN_MS);
    const fresh = { access_token: "new-access", refresh_token: "new-refresh", expires_at: new Date(NOW + 3_600_000).toISOString() };
    mocks.load.mockResolvedValue(current);
    mocks.save.mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(fresh);
    expect(await connectionAccessToken("int-1", "Zoom", refresh)).toBe("new-access");
    expect(refresh).toHaveBeenCalledWith(current);
    expect(mocks.save).toHaveBeenCalledWith("int-1", fresh);
  });

  it("refreshes an expired token", async () => {
    mocks.load.mockResolvedValue(secrets(-1000));
    mocks.save.mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue({ ...secrets(3_600_000, "new-access") });
    expect(await connectionAccessToken("int-1", "Google", refresh)).toBe("new-access");
  });

  it("does not hand out a rotated token whose save failed", async () => {
    mocks.load.mockResolvedValue(secrets(0));
    mocks.save.mockRejectedValue(new Error("db down"));
    const refresh = vi.fn().mockResolvedValue(secrets(3_600_000, "new-access"));
    await expect(connectionAccessToken("int-1", "Zoom", refresh)).rejects.toThrow("db down");
  });

  it("asks for a reconnect when the connection has no tokens", async () => {
    mocks.load.mockResolvedValue(null);
    const refresh = vi.fn();
    await expect(connectionAccessToken("int-1", "Zoom", refresh)).rejects.toThrow(UpstreamError);
    await expect(connectionAccessToken("int-1", "Zoom", refresh)).rejects.toThrow(
      "The Zoom account is connected without tokens: connect it again",
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

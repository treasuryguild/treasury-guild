import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { signOAuthState, signPayload, verifyOAuthState, verifyPayload } from "./state";

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", "test-secret").update(body).digest("hex");
  return `${body}.${mac}`;
}

describe("OAuth state", () => {
  it("round-trips wallet and returnTo", () => {
    const state = signOAuthState("github-link", { wallet: "addr1abc", returnTo: "/settings" });
    expect(verifyOAuthState("github-link", state)).toEqual({
      wallet: "addr1abc",
      returnTo: "/settings",
    });
  });

  it("rejects a payload signed for different contents", () => {
    const state = signOAuthState("github-link", { wallet: "addr1abc", returnTo: "/settings" });
    const mac = state.slice(state.lastIndexOf(".") + 1);
    const forged = Buffer.from(
      JSON.stringify({
        wallet: "addr1evil",
        returnTo: "/settings",
        purpose: "github-link",
        exp: Date.now() + 600_000,
      }),
    ).toString("base64url");
    expect(verifyOAuthState("github-link", `${forged}.${mac}`)).toBeNull();
  });

  it("rejects a state issued for another flow", () => {
    const state = signOAuthState("discord-link", { wallet: "addr1abc", returnTo: "/settings" });
    expect(verifyOAuthState("discord-link", state)).not.toBeNull();
    expect(verifyOAuthState("google-link", state)).toBeNull();
    expect(verifyOAuthState("github-link", state)).toBeNull();
    // A state signed before purposes existed carries none.
    const legacy = sign({ wallet: "addr1abc", returnTo: "/settings", exp: Date.now() + 600_000 });
    expect(verifyOAuthState("github-link", legacy)).toBeNull();
  });

  it("binds the install state to its community and purpose", () => {
    const state = signOAuthState("github-install", {
      wallet: "addr1abc",
      returnTo: "/c/demo/settings/github",
      communityId: "community-1",
    });
    expect(verifyOAuthState("github-install", state)?.communityId).toBe("community-1");
    expect(verifyOAuthState("github-link", state)).toBeNull();
    // The old install state was a bare "<communityId>.<mac>" that never expired.
    const mac = createHmac("sha256", "test-secret").update("community-1").digest("hex");
    expect(verifyOAuthState("github-install", `community-1.${mac}`)).toBeNull();
  });

  it("without OAUTH_STATE_SECRET, signs with a key derived from CRON_SECRET, not CRON_SECRET itself", () => {
    delete process.env.OAUTH_STATE_SECRET;
    try {
      const state = signOAuthState("github-link", { wallet: "addr1abc", returnTo: "/settings" });
      expect(verifyOAuthState("github-link", state)?.wallet).toBe("addr1abc");
      const body = Buffer.from(
        JSON.stringify({ wallet: "addr1evil", returnTo: "/", purpose: "github-link", exp: Date.now() + 60_000 }),
      ).toString("base64url");
      const cronMac = createHmac("sha256", "cron-secret").update(body).digest("hex");
      expect(verifyOAuthState("github-link", `${body}.${cronMac}`)).toBeNull();
    } finally {
      process.env.OAUTH_STATE_SECRET = "test-secret";
    }
  });

  it("rejects a truncated or garbage state", () => {
    expect(verifyOAuthState("github-link", "")).toBeNull();
    expect(verifyOAuthState("github-link", "no-dot")).toBeNull();
    expect(verifyOAuthState("github-link", "a.b")).toBeNull();
  });

  it("rejects an expired state", () => {
    const state = sign({
      wallet: "addr1abc",
      returnTo: "/settings",
      purpose: "github-link",
      exp: Date.now() - 1000,
    });
    expect(verifyOAuthState("github-link", state)).toBeNull();
  });

  it("rejects a validly signed state missing the expiry", () => {
    const state = sign({ wallet: "addr1abc", returnTo: "/settings", purpose: "github-link" });
    expect(verifyOAuthState("github-link", state)).toBeNull();
  });
});

describe("signPayload / verifyPayload", () => {
  it("round-trips any payload with its purpose and expiry", () => {
    const before = Date.now();
    const token = signPayload("mcp-authorize", { clientId: "c1", scopes: ["communities:read"] }, 60_000);
    const payload = verifyPayload("mcp-authorize", token);
    expect(payload).toMatchObject({ clientId: "c1", scopes: ["communities:read"], purpose: "mcp-authorize" });
    expect(payload!.exp).toBeGreaterThanOrEqual(before + 60_000);
    expect(payload!.exp).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("is <base64url json>.<hex hmac-sha256 of the body> under the state secret", () => {
    const token = signPayload("zoom-host", { a: 1 }, 1000);
    const [body, mac] = token.split(".");
    expect(JSON.parse(Buffer.from(body!, "base64url").toString("utf8"))).toMatchObject({ a: 1, purpose: "zoom-host" });
    expect(mac).toBe(createHmac("sha256", "test-secret").update(body!).digest("hex"));
  });

  it("refuses a value signed for another purpose", () => {
    const token = signPayload("mcp-authorize", { clientId: "c1" }, 60_000);
    expect(verifyPayload("github-link", token)).toBeNull();
    expect(verifyPayload("zoom-host", token)).toBeNull();
  });

  it("does not let the payload choose its own purpose or expiry", () => {
    const token = signPayload("github-link", { purpose: "mcp-authorize", exp: Date.now() + 10 ** 9 }, 1000);
    expect(verifyPayload("mcp-authorize", token)).toBeNull();
    const payload = verifyPayload("github-link", token);
    expect(payload?.purpose).toBe("github-link");
    expect(payload!.exp as number).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("refuses a tampered body, a tampered mac and a mac under another key", () => {
    const token = signPayload("mcp-authorize", { clientId: "c1" }, 60_000);
    const dot = token.lastIndexOf(".");
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const forgedBody = Buffer.from(
      JSON.stringify({ clientId: "evil", purpose: "mcp-authorize", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(verifyPayload("mcp-authorize", `${forgedBody}.${mac}`)).toBeNull();
    const flipped = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
    expect(verifyPayload("mcp-authorize", `${body}.${flipped}`)).toBeNull();
    expect(verifyPayload("mcp-authorize", `${body}.${mac.slice(0, -1)}`)).toBeNull();
    expect(verifyPayload("mcp-authorize", `${body}.`)).toBeNull();
    const otherKey = createHmac("sha256", "other-secret").update(body).digest("hex");
    expect(verifyPayload("mcp-authorize", `${body}.${otherKey}`)).toBeNull();
  });

  it("refuses an expired value: a negative ttl, or time moving past exp", () => {
    expect(verifyPayload("mcp-authorize", signPayload("mcp-authorize", {}, -1))).toBeNull();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const token = signPayload("mcp-authorize", { clientId: "c1" }, 60_000);
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      // `exp` itself is still accepted (the check is `exp < now`).
      expect(verifyPayload("mcp-authorize", token)).not.toBeNull();
      vi.setSystemTime(new Date("2026-01-01T00:01:00.001Z"));
      expect(verifyPayload("mcp-authorize", token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses correctly signed bodies that are not a JSON object with a numeric exp", () => {
    const signed = (raw: string) => {
      const body = Buffer.from(raw).toString("base64url");
      return `${body}.${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    };
    expect(verifyPayload("github-link", signed("not json"))).toBeNull();
    expect(verifyPayload("github-link", signed("null"))).toBeNull();
    expect(verifyPayload("github-link", signed(JSON.stringify("github-link")))).toBeNull();
    expect(verifyPayload("github-link", signed(JSON.stringify({ purpose: "github-link", exp: String(Date.now() + 60_000) })))).toBeNull();
    // The same shape with a numeric exp is what passes.
    expect(verifyPayload("github-link", signed(JSON.stringify({ purpose: "github-link", exp: Date.now() + 60_000 })))).not.toBeNull();
  });
});

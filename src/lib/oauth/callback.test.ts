import { beforeAll, describe, expect, it } from "vitest";
import { safeReturnTo } from "@/lib/api/schemas";
import { oauthRedirect, readOAuthCallback, readOAuthReturn } from "./callback";
import { signOAuthState } from "./state";

beforeAll(() => {
  process.env.CRON_SECRET = "test-secret";
  process.env.APP_URL = "https://vault.test";
});

const redirect = oauthRedirect("zoom");
const wallet = "addr_test1abc";

function callback(query: Record<string, string>, session: { wallet: string } | null = { wallet }, needsCommunity = true) {
  const req = new Request(`https://vault.test/api/zoom/oauth-callback?${new URLSearchParams(query)}`);
  return readOAuthCallback(req, session, { purpose: "zoom-host", fallback: "/", redirect, needsCommunity });
}

function outcome(result: ReturnType<typeof callback>): Record<string, string> {
  if (result.ok) throw new Error("expected a redirect");
  return Object.fromEntries(new URL(result.response.headers.get("location")!).searchParams);
}

const state = () => signOAuthState("zoom-host", { wallet, returnTo: "/c/demo/calls", communityId: "c1" });

describe("readOAuthCallback", () => {
  it("accepts the wallet that started the flow and returns its state", () => {
    const result = callback({ code: "abc", state: state() });
    expect(result).toMatchObject({ ok: true, code: "abc", wallet, returnTo: "/c/demo/calls" });
  });

  it("reports a declined consent as cancelled and other provider errors as errors", () => {
    expect(outcome(callback({ error: "access_denied", state: state() }))).toEqual({ zoom: "cancelled", reason: "access_denied" });
    expect(outcome(callback({ error: "redirect_uri_mismatch" }))).toEqual({ zoom: "error", reason: "redirect_uri_mismatch" });
  });

  it("refuses a missing code, a foreign state, no session and another wallet", () => {
    expect(outcome(callback({ state: state() })).reason).toBe("no_code");
    const foreign = signOAuthState("google-host", { wallet, returnTo: "/", communityId: "c1" });
    expect(outcome(callback({ code: "abc", state: foreign })).reason).toBe("bad_state");
    expect(outcome(callback({ code: "abc", state: state() }, null)).reason).toBe("no_session");
    expect(outcome(callback({ code: "abc", state: state() }, { wallet: "addr_test1other" })).reason).toBe("wallet_mismatch");
  });

  it("requires a community only for community flows", () => {
    const personal = signOAuthState("zoom-host", { wallet, returnTo: "/settings" });
    expect(outcome(callback({ code: "abc", state: personal })).reason).toBe("bad_state");
    expect(callback({ code: "abc", state: personal }, { wallet }, false).ok).toBe(true);
  });

  it("returns to where the flow started, on this deployment", () => {
    const result = callback({ state: state() });
    if (result.ok) throw new Error("expected a redirect");
    expect(result.response.headers.get("location")).toMatch(/^https:\/\/vault\.test\/c\/demo\/calls\?/);
  });
});

describe("safeReturnTo", () => {
  it("keeps app paths and falls back for anything else", () => {
    expect(safeReturnTo("/c/demo/settings", "/")).toBe("/c/demo/settings");
    expect(safeReturnTo(undefined, "/settings")).toBe("/settings");
    expect(safeReturnTo("https://evil.test", "/")).toBe("/");
    expect(safeReturnTo("//evil.test", "/")).toBe("/");
    // Protocol-relative: new URL("//3232235777", base) is https://192.168.1.1/.
    expect(safeReturnTo("//3232235777/x", "/")).toBe("/");
  });
});

describe("readOAuthReturn", () => {
  const installRedirect = oauthRedirect("github");
  const installState = () =>
    signOAuthState("github-install", { wallet, returnTo: "/c/demo/settings/github", communityId: "c1" });

  function installReturn(query: Record<string, string>, session: { wallet: string } | null = { wallet }, needsCommunity = true) {
    const req = new Request(`https://vault.test/api/github/setup?${new URLSearchParams(query)}`);
    return readOAuthReturn(req, session, { purpose: "github-install", fallback: "/settings", redirect: installRedirect, needsCommunity });
  }

  function query(result: ReturnType<typeof installReturn>): Record<string, string> {
    if (result.ok) throw new Error("expected a redirect");
    return Object.fromEntries(new URL(result.response.headers.get("location")!).searchParams);
  }

  it("needs no code: the state and the session wallet are enough", () => {
    const result = installReturn({ state: installState(), installation_id: "42" });
    expect(result).toEqual({
      ok: true,
      state: { wallet, returnTo: "/c/demo/settings/github", communityId: "c1" },
      wallet,
      returnTo: "/c/demo/settings/github",
    });
    // Unlike readOAuthCallback, the result carries no code even when one is sent.
    expect(installReturn({ state: installState(), code: "abc" })).not.toHaveProperty("code");
  });

  it("still reports provider errors, cancelled only for access_denied", () => {
    expect(query(installReturn({ error: "access_denied", state: installState() }))).toEqual({ github: "cancelled", reason: "access_denied" });
    expect(query(installReturn({ error: "server_error", state: installState() }))).toEqual({ github: "error", reason: "server_error" });
  });

  it("refuses a missing, garbage or foreign state, and returns to the fallback", () => {
    const missing = installReturn({ installation_id: "42" });
    expect(query(missing)).toEqual({ github: "error", reason: "bad_state" });
    if (missing.ok) throw new Error("expected a redirect");
    expect(new URL(missing.response.headers.get("location")!).pathname).toBe("/settings");
    expect(query(installReturn({ state: "garbage.mac" })).reason).toBe("bad_state");
    const link = signOAuthState("github-link", { wallet, returnTo: "/settings", communityId: "c1" });
    expect(query(installReturn({ state: link })).reason).toBe("bad_state");
  });

  it("refuses a state without a community when one is needed", () => {
    const bare = signOAuthState("github-install", { wallet, returnTo: "/settings" });
    expect(query(installReturn({ state: bare })).reason).toBe("bad_state");
    expect(installReturn({ state: bare }, { wallet }, false).ok).toBe(true);
  });

  it("refuses no session and a session of another wallet", () => {
    expect(query(installReturn({ state: installState() }, null)).reason).toBe("no_session");
    expect(query(installReturn({ state: installState() }, { wallet: "addr_test1other" })).reason).toBe("wallet_mismatch");
  });

  it("reports a provider error ahead of a bad state or a missing session", () => {
    expect(query(installReturn({ error: "access_denied" }, null))).toEqual({ github: "cancelled", reason: "access_denied" });
  });
});

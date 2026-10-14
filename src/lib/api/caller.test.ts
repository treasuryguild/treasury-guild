import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import type { ApiScope } from "@/lib/mcp/scopes";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), findGrant: vi.fn(), touchGrant: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => null }));
vi.mock("@/lib/db/oauth", () => ({ findOAuthGrant: mocks.findGrant, touchOAuthGrant: mocks.touchGrant }));
vi.mock("@/lib/oauthServer/accessToken", () => ({ verifyAccessToken: mocks.verify }));

import { bearerToken, callerFromAccessToken, requireScope, type ApiCaller } from "./caller";

const withAuth = (value?: string) =>
  new Request("http://localhost/api/v1/communities", value === undefined ? undefined : { headers: { authorization: value } });

const CREATED = "2026-09-28T10:00:00.000Z";
const claims = { wallet: "addr_w", clientId: "c1", scopes: ["communities:read"], grantCreatedAt: Date.parse(CREATED) };
const grant = { wallet_address: "addr_w", client_id: "c1", scopes: ["communities:read"], created_at: CREATED };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockResolvedValue(claims);
  mocks.findGrant.mockResolvedValue(grant);
  mocks.touchGrant.mockResolvedValue(undefined);
});

describe("bearerToken", () => {
  it("reads the credential of a Bearer header", () => {
    expect(bearerToken(withAuth("Bearer abc.def.ghi"))).toBe("abc.def.ghi");
  });

  it("takes the scheme case-insensitively and trims the token", () => {
    expect(bearerToken(withAuth("bearer abc"))).toBe("abc");
    expect(bearerToken(withAuth("BEARER abc"))).toBe("abc");
    expect(bearerToken(withAuth("Bearer    abc  "))).toBe("abc");
  });

  it("is null without a header", () => {
    expect(bearerToken(withAuth())).toBeNull();
  });

  it("is null for another scheme", () => {
    expect(bearerToken(withAuth("Basic dXNlcjpwYXNz"))).toBeNull();
    expect(bearerToken(withAuth("Token abc"))).toBeNull();
    expect(bearerToken(withAuth("Bearerabc"))).toBeNull();
  });

  it("is null for a Bearer header with no credential", () => {
    expect(bearerToken(withAuth("Bearer"))).toBeNull();
    expect(bearerToken(withAuth("Bearer "))).toBeNull();
    expect(bearerToken(withAuth("Bearer    "))).toBeNull();
  });
});

describe("requireScope", () => {
  const caller = (scopes: ApiScope[]): ApiCaller => ({ wallet: "addr_w", scopes, clientId: "c1", via: "oauth" });

  it("passes a caller holding the scope", () => {
    expect(() => requireScope(caller(["communities:read"]), "communities:read")).not.toThrow();
  });

  it("refuses a caller without it, naming the scope", () => {
    expect(() => requireScope(caller([]), "communities:read")).toThrow(ForbiddenError);
    expect(() => requireScope(caller([]), "communities:read")).toThrow(
      "This connection was not granted the communities:read permission",
    );
  });
});

describe("callerFromAccessToken", () => {
  it("resolves the caller of a token issued under the stored grant", async () => {
    expect(await callerFromAccessToken("tok")).toEqual({
      wallet: "addr_w",
      scopes: ["communities:read"],
      clientId: "c1",
      via: "oauth",
      grantCreatedAt: Date.parse(grant.created_at),
    });
    expect(mocks.verify).toHaveBeenCalledWith("tok");
    expect(mocks.findGrant).toHaveBeenCalledWith("addr_w", "c1");
    expect(mocks.touchGrant).toHaveBeenCalledWith(grant);
  });

  it("is null for a token that does not verify, without reading the grant", async () => {
    mocks.verify.mockResolvedValue(null);
    expect(await callerFromAccessToken("tok")).toBeNull();
    expect(mocks.findGrant).not.toHaveBeenCalled();
  });

  it("is null once the grant is gone (Disconnect)", async () => {
    mocks.findGrant.mockResolvedValue(null);
    expect(await callerFromAccessToken("tok")).toBeNull();
    expect(mocks.touchGrant).not.toHaveBeenCalled();
  });

  it("is null for a token of an earlier grant: re-approval never revives it", async () => {
    mocks.findGrant.mockResolvedValue({ ...grant, created_at: "2026-09-29T10:00:00.000Z" });
    expect(await callerFromAccessToken("tok")).toBeNull();
    expect(mocks.touchGrant).not.toHaveBeenCalled();
  });

  it("is null when the grant no longer holds any of the token's scopes", async () => {
    mocks.findGrant.mockResolvedValue({ ...grant, scopes: [] });
    expect(await callerFromAccessToken("tok")).toBeNull();
    mocks.findGrant.mockResolvedValue({ ...grant, scopes: ["retired:scope"] });
    expect(await callerFromAccessToken("tok")).toBeNull();
  });

  it("never gains a scope the token was not issued with", async () => {
    mocks.verify.mockResolvedValue({ ...claims, scopes: [] });
    expect(await callerFromAccessToken("tok")).toBeNull();
  });

  it("does not fail the request when stamping the grant fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.touchGrant.mockRejectedValue(new Error("db down"));
    expect((await callerFromAccessToken("tok"))?.wallet).toBe("addr_w");
    await Promise.resolve();
    await Promise.resolve();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

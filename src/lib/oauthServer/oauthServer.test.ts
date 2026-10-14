import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { mintSessionJwt, verifySessionJwt } from "@/lib/auth/jwt";
import { parseApiScopes } from "@/lib/mcp/scopes";
import { generateOpaqueToken, hashToken, mintAccessToken, verifyAccessToken } from "./accessToken";
import { authorizationResponseUrl, authorizeParams, requestedScopes, validateAuthorizeRequest, type AuthorizeParams } from "./authorize";
import { consentErrorMessage } from "./consentErrors";
import { isValidCodeChallenge, isValidCodeVerifier, verifyCodeChallenge } from "./pkce";
import { findMatchingRedirectUri, isAcceptableRedirectUri, isLoopbackRedirect, isMetadataUrlClientId, redirectUriMatches } from "./redirects";
import { decodeAuthorizationRequest, encodeAuthorizationRequest } from "./request";

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.SUPABASE_JWT_SECRET = "supabase-secret";
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
});

const VERIFIER = "a".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

describe("PKCE", () => {
  it("accepts the S256 challenge of its verifier only", () => {
    expect(isValidCodeChallenge(CHALLENGE)).toBe(true);
    expect(verifyCodeChallenge(VERIFIER, CHALLENGE)).toBe(true);
    expect(verifyCodeChallenge("b".repeat(43), CHALLENGE)).toBe(false);
    // `plain` (verifier == challenge) is not a thing here.
    expect(verifyCodeChallenge(VERIFIER, VERIFIER)).toBe(false);
    expect(verifyCodeChallenge("short", CHALLENGE)).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("accepts https and loopback http, nothing else", () => {
    expect(isAcceptableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://127.0.0.1:5173/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://evil.test/callback")).toBe(false);
    expect(isAcceptableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAcceptableRedirectUri("https://claude.ai/cb#frag")).toBe(false);
  });

  it("ignores only the port, only of a loopback redirect", () => {
    expect(redirectUriMatches("http://127.0.0.1/callback", "http://127.0.0.1:51763/callback")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1/callback", "http://127.0.0.1:51763/other")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1/callback", "http://localhost:51763/callback")).toBe(false);
    expect(redirectUriMatches("https://a.test/cb", "https://a.test:8443/cb")).toBe(false);
    expect(findMatchingRedirectUri(["https://a.test/cb"], "https://a.test/cb2")).toBeNull();
  });

  it("recognises a metadata-document client id: https, a path, the default port", () => {
    expect(isMetadataUrlClientId("https://claude.ai/oauth/client.json")).toBe(true);
    expect(isMetadataUrlClientId("https://claude.ai")).toBe(false);
    expect(isMetadataUrlClientId("https://claude.ai:8443/client.json")).toBe(false);
    expect(isMetadataUrlClientId("gv-123")).toBe(false);
  });
});

describe("scopes", () => {
  it("drops unknown names and defaults an empty request to every read scope", () => {
    expect(parseApiScopes("communities:read wallets:write")).toEqual(["communities:read"]);
    expect(requestedScopes(null)).toEqual(["communities:read"]);
    expect(requestedScopes("unknown")).toEqual([]);
  });

  it("asks for a write scope only when the request names it", () => {
    expect(requestedScopes("proposals:write communities:read")).toEqual(["communities:read", "proposals:write"]);
    expect(requestedScopes("")).not.toContain("proposals:write");
  });
});

describe("access tokens", () => {
  it("round-trip wallet, client and scopes", async () => {
    const { token, expiresIn } = await mintAccessToken({ wallet: "addr_w", clientId: "c1", scopes: ["communities:read"], grantCreatedAt: 1_790_000_000_000 });
    expect(expiresIn).toBe(3600);
    expect(await verifyAccessToken(token)).toMatchObject({ wallet: "addr_w", clientId: "c1", scopes: ["communities:read"], grantCreatedAt: 1_790_000_000_000 });
  });

  it("are never session JWTs, and session JWTs never access tokens", async () => {
    const { token } = await mintAccessToken({ wallet: "addr_w", clientId: "c1", scopes: ["communities:read"], grantCreatedAt: 1_790_000_000_000 });
    expect(await verifySessionJwt(token)).toBeNull();
    expect(await verifyAccessToken(await mintSessionJwt("addr_w"))).toBeNull();
  });

  it("are refused for another audience or without the access-token type", async () => {
    const key = new TextEncoder().encode("mcp-secret");
    const base = () => new SignJWT({ typ: "tg_mcp_at", cid: "c1", scope: "communities:read" })
      .setSubject("addr_w").setIssuer("http://localhost:3000").setIssuedAt().setExpirationTime("1h");
    const otherAudience = await base().setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setAudience("https://elsewhere.test/api/mcp").sign(key);
    const noHeaderType = await base().setProtectedHeader({ alg: "HS256" })
      .setAudience("http://localhost:3000/api/mcp").sign(key);
    const wrongKey = await base().setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setAudience("http://localhost:3000/api/mcp").sign(new TextEncoder().encode("other"));
    expect(await verifyAccessToken(otherAudience)).toBeNull();
    expect(await verifyAccessToken(noHeaderType)).toBeNull();
    expect(await verifyAccessToken(wrongKey)).toBeNull();
  });
});

describe("authorization request handle", () => {
  const request = {
    clientId: "c1", clientName: "Claude", verifiedDomain: null, redirectUri: "https://claude.ai/cb",
    codeChallenge: CHALLENGE, scopes: ["communities:read" as const], resource: "http://localhost:3000/api/mcp", state: "s",
  };

  it("round-trips and rejects tampering", () => {
    const handle = encodeAuthorizationRequest(request);
    expect(decodeAuthorizationRequest(handle)).toEqual(request);
    const [body, mac] = handle.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), redirectUri: "https://evil.test" })).toString("base64url");
    expect(decodeAuthorizationRequest(`${forged}.${mac}`)).toBeNull();
  });
});

describe("validateAuthorizeRequest", () => {
  const client = {
    client_id: "c1", client_name: "Claude", is_metadata_url: false,
    redirect_uris: ["https://claude.ai/cb", "http://127.0.0.1/cb"],
  };
  const RESOURCE = "http://localhost:3000/api/mcp";
  const params = (over: Partial<AuthorizeParams> = {}): AuthorizeParams => ({
    clientId: "c1", redirectUri: "https://claude.ai/cb", responseType: "code", codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256", scope: "communities:read", state: "xyz", resource: RESOURCE, ...over,
  });

  it("accepts a well-formed request", () => {
    const outcome = validateAuthorizeRequest(params({ redirectUri: "http://127.0.0.1:4242/cb" }), client, RESOURCE);
    expect(outcome).toMatchObject({ kind: "ok", request: { redirectUri: "http://127.0.0.1:4242/cb", scopes: ["communities:read"], state: "xyz" } });
  });

  it("never redirects to an unknown client or an unregistered redirect_uri", () => {
    // The consent page is sent a code, never text (the query string is attacker-chosen).
    expect(validateAuthorizeRequest(params(), null, RESOURCE)).toMatchObject({ kind: "render", error: "invalid_client" });
    expect(validateAuthorizeRequest(params({ redirectUri: "https://evil.test/cb" }), client, RESOURCE))
      .toMatchObject({ kind: "render", error: "unregistered_redirect" });
    expect(validateAuthorizeRequest(params({ clientId: null }), client, RESOURCE)).toMatchObject({ error: "invalid_request" });
  });

  it("sends protocol errors back to a registered redirect", () => {
    expect(validateAuthorizeRequest(params({ codeChallengeMethod: "plain" }), client, RESOURCE))
      .toMatchObject({ kind: "bounce", error: "invalid_request" });
    expect(validateAuthorizeRequest(params({ responseType: "token" }), client, RESOURCE))
      .toMatchObject({ kind: "bounce", error: "unsupported_response_type" });
    expect(validateAuthorizeRequest(params({ scope: "wallets:write" }), client, RESOURCE))
      .toMatchObject({ kind: "bounce", error: "invalid_scope" });
    expect(validateAuthorizeRequest(params({ resource: "https://other.test/api/mcp" }), client, RESOURCE))
      .toMatchObject({ kind: "bounce", error: "invalid_target" });
  });

  it("puts code, state and iss on the client's redirect", () => {
    const url = new URL(authorizationResponseUrl("https://claude.ai/cb?x=1", "http://localhost:3000", { code: "k", state: "s" }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ x: "1", code: "k", state: "s", iss: "http://localhost:3000" });
  });
});

describe("client identity on the consent page", () => {
  it("vouches for a metadata-document client by its domain, never for a DCR one", () => {
    const params: AuthorizeParams = {
      clientId: "x", redirectUri: "https://claude.ai/cb", responseType: "code", codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256", scope: null, state: null, resource: null,
    };
    const cimd = { client_id: "https://claude.ai/oauth/client.json", client_name: "Claude", is_metadata_url: true, redirect_uris: ["https://claude.ai/cb"] };
    const dcr = { ...cimd, client_id: "gv-1", is_metadata_url: false };
    expect(validateAuthorizeRequest(params, cimd, "r")).toMatchObject({ request: { verifiedDomain: "claude.ai" } });
    expect(validateAuthorizeRequest(params, dcr, "r")).toMatchObject({ request: { verifiedDomain: null } });
  });
});

describe("consent error messages", () => {
  it("shows fixed text for known codes and a generic sentence for anything else", () => {
    expect(consentErrorMessage("invalid_client")).toBe("Treasury Guild does not know this assistant");
    expect(consentErrorMessage("Your wallet is compromised, visit evil.test")).toBe("the request is not valid");
    expect(consentErrorMessage("toString")).toBe("the request is not valid");
    expect(consentErrorMessage(null)).toBe("the request is not valid");
  });
});

describe("token signing key in production", () => {
  it("refuses to mint without MCP_TOKEN_SECRET instead of deriving one from CRON_SECRET", async () => {
    const env = process.env as Record<string, string | undefined>;
    const { NODE_ENV, MCP_TOKEN_SECRET } = env;
    env.NODE_ENV = "production";
    delete env.MCP_TOKEN_SECRET;
    try {
      await expect(mintAccessToken({ wallet: "w", clientId: "c", scopes: ["communities:read"], grantCreatedAt: 1 }))
        .rejects.toThrow("MCP_TOKEN_SECRET is not configured");
    } finally {
      env.NODE_ENV = NODE_ENV;
      env.MCP_TOKEN_SECRET = MCP_TOKEN_SECRET;
    }
  });
});

describe("isLoopbackRedirect", () => {
  it("is true only for plain http on a literal loopback host, any port", () => {
    expect(isLoopbackRedirect("http://127.0.0.1/callback")).toBe(true);
    expect(isLoopbackRedirect("http://127.0.0.1:51763/callback")).toBe(true);
    expect(isLoopbackRedirect("http://localhost:8080/cb")).toBe(true);
    expect(isLoopbackRedirect("http://[::1]:9000/cb")).toBe(true);
  });

  it("is false for https, look-alike hosts, other schemes and garbage", () => {
    expect(isLoopbackRedirect("https://127.0.0.1/callback")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1.evil.test/callback")).toBe(false);
    expect(isLoopbackRedirect("http://localhost.evil.test/callback")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.2/callback")).toBe(false);
    expect(isLoopbackRedirect("http://user@evil.test/127.0.0.1")).toBe(false);
    expect(isLoopbackRedirect("myapp://localhost/cb")).toBe(false);
    expect(isLoopbackRedirect("not a url")).toBe(false);
    expect(isLoopbackRedirect("")).toBe(false);
  });
});

describe("isValidCodeVerifier", () => {
  it("accepts 43 to 128 characters of the unreserved set", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    expect(isValidCodeVerifier(`${"aZ09-._~".repeat(5)}abc`)).toBe(true);
  });

  it("refuses a verifier that is too short, too long or has other characters", () => {
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("")).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)}/`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)}=`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)} `)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(43)}\n`)).toBe(false);
  });
});

describe("authorizeParams", () => {
  it("reads every OAuth parameter from the query string, decoded", () => {
    const url = new URL("http://localhost:3000/api/oauth/authorize");
    url.searchParams.set("client_id", "https://claude.ai/oauth/client.json");
    url.searchParams.set("redirect_uri", "http://127.0.0.1:4242/cb?x=1");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "communities:read other");
    url.searchParams.set("state", "s t");
    url.searchParams.set("resource", "http://localhost:3000/api/mcp");
    expect(authorizeParams(url)).toEqual({
      clientId: "https://claude.ai/oauth/client.json",
      redirectUri: "http://127.0.0.1:4242/cb?x=1",
      responseType: "code",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      scope: "communities:read other",
      state: "s t",
      resource: "http://localhost:3000/api/mcp",
    });
  });

  it("leaves absent parameters null and ignores unknown ones", () => {
    expect(authorizeParams(new URL("http://localhost:3000/api/oauth/authorize?clientId=camel&extra=1"))).toEqual({
      clientId: null, redirectUri: null, responseType: null, codeChallenge: null,
      codeChallengeMethod: null, scope: null, state: null, resource: null,
    });
  });

  it("takes the first value of a repeated parameter and keeps an empty one as the empty string", () => {
    const params = authorizeParams(new URL("http://localhost:3000/api/oauth/authorize?client_id=a&client_id=b&state="));
    expect(params.clientId).toBe("a");
    expect(params.state).toBe("");
  });
});

describe("opaque tokens", () => {
  it("are 32 random bytes as base64url, different every time", () => {
    const tokens = Array.from({ length: 20 }, () => generateOpaqueToken());
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("are stored as their sha256 hex, never the value itself", () => {
    const token = generateOpaqueToken();
    const hashed = hashToken(token);
    expect(hashed).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashed);
    expect(hashToken(`${token}x`)).not.toBe(hashed);
    // A known vector: the hash is plain, unsalted SHA-256.
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

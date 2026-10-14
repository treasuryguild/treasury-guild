import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthProtocolError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  findCode: vi.fn(),
  consume: vi.fn(),
  findRefresh: vi.fn(),
  claim: vi.fn(),
  link: vi.fn(),
  insertRefresh: vi.fn(),
  endConnection: vi.fn(),
  grant: vi.fn(),
}));
vi.mock("@/lib/db/oauth", () => ({
  findAuthorizationCode: mocks.findCode,
  consumeAuthorizationCode: mocks.consume,
  findRefreshToken: mocks.findRefresh,
  claimRefreshToken: mocks.claim,
  linkRefreshTokenSuccessor: mocks.link,
  insertRefreshToken: mocks.insertRefresh,
  deleteOAuthGrant: mocks.endConnection,
  findOAuthGrant: mocks.grant,
}));
import { verifyAccessToken } from "./accessToken";
import { exchangeAuthorizationCode, exchangeRefreshToken } from "./tokens";

const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const RESOURCE = "http://localhost:3000/api/mcp";
const later = () => new Date(Date.now() + 60_000).toISOString();

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findCode.mockResolvedValue({
    code_hash: "h", client_id: "c1", wallet_address: "addr_w", scopes: ["communities:read"], resource: RESOURCE,
    redirect_uri: "https://claude.ai/cb", code_challenge: CHALLENGE, expires_at: later(), consumed_at: null,
  });
  mocks.consume.mockResolvedValue(true);
  mocks.insertRefresh.mockResolvedValue("new-refresh-id");
  mocks.findRefresh.mockResolvedValue({
    id: "old-id", token_hash: "t", client_id: "c1", wallet_address: "addr_w", scopes: ["communities:read"],
    resource: RESOURCE, expires_at: later(), revoked_at: null, replaced_by: null,
  });
  mocks.claim.mockResolvedValue(true);
  mocks.grant.mockResolvedValue({
    wallet_address: "addr_w", client_id: "c1", scopes: ["communities:read"], created_at: "2026-09-28T10:00:00.5+00:00",
  });
});

async function grantError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OAuthProtocolError);
  return (err as OAuthProtocolError).message;
}

describe("authorization_code grant", () => {
  const redeem = (over: Partial<{ codeVerifier: string; redirectUri: string | null }> = {}) =>
    exchangeAuthorizationCode("c1", { code: "code", codeVerifier: VERIFIER, redirectUri: "https://claude.ai/cb", ...over });

  it("issues an access token for the approving wallet and a refresh token", async () => {
    const response = await redeem();
    expect(response).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "communities:read" });
    expect(await verifyAccessToken(response.access_token)).toMatchObject({ wallet: "addr_w", clientId: "c1", grantCreatedAt: Date.parse("2026-09-28T10:00:00.5+00:00") });
    expect(mocks.insertRefresh).toHaveBeenCalledWith(expect.objectContaining({ wallet_address: "addr_w", client_id: "c1" }));
  });

  it("checks PKCE before claiming, so a wrong verifier does not burn the code", async () => {
    expect(await grantError(redeem({ codeVerifier: "w".repeat(43) }))).toBe("invalid_grant");
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("ends the connection (grant, refresh and access tokens) when a used code comes back", async () => {
    mocks.findCode.mockResolvedValue({ ...(await mocks.findCode()), consumed_at: new Date().toISOString() });
    expect(await grantError(redeem())).toBe("invalid_grant");
    expect(mocks.endConnection).toHaveBeenCalledWith("addr_w", "c1");
  });

  it("treats losing the claim to a concurrent redemption as a replay", async () => {
    mocks.consume.mockResolvedValue(false);
    expect(await grantError(redeem())).toBe("invalid_grant");
    expect(mocks.endConnection).toHaveBeenCalled();
    expect(mocks.insertRefresh).not.toHaveBeenCalled();
  });

  it("gives nothing for a code redeemed after the user disconnected", async () => {
    mocks.grant.mockResolvedValue(null);
    expect(await grantError(redeem())).toBe("invalid_grant");
    expect(mocks.insertRefresh).not.toHaveBeenCalled();
  });

  it("refuses another client's code and a changed redirect_uri", async () => {
    await expect(exchangeAuthorizationCode("c2", { code: "code", codeVerifier: VERIFIER, redirectUri: null }))
      .rejects.toThrow("invalid_grant");
    expect(await grantError(redeem({ redirectUri: "https://claude.ai/other" }))).toBe("invalid_grant");
  });
});

describe("refresh_token grant", () => {
  it("rotates: the old token is claimed and linked to its successor", async () => {
    const response = await exchangeRefreshToken("c1", { refreshToken: "rt", scope: null });
    expect(response.scope).toBe("communities:read");
    expect(mocks.claim).toHaveBeenCalledWith("old-id");
    expect(mocks.link).toHaveBeenCalledWith("old-id", "new-refresh-id");
  });

  it("ends the connection when a rotated token is presented again", async () => {
    mocks.findRefresh.mockResolvedValue({ ...(await mocks.findRefresh()), replaced_by: "next", revoked_at: new Date().toISOString() });
    expect(await grantError(exchangeRefreshToken("c1", { refreshToken: "rt", scope: null }))).toBe("invalid_grant");
    expect(mocks.endConnection).toHaveBeenCalledWith("addr_w", "c1");
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("stops once the user disconnected the assistant", async () => {
    mocks.grant.mockResolvedValue(null);
    expect(await grantError(exchangeRefreshToken("c1", { refreshToken: "rt", scope: null }))).toBe("invalid_grant");
    expect(mocks.insertRefresh).not.toHaveBeenCalled();
  });

  it("can narrow the scope but never widen it", async () => {
    expect(await grantError(exchangeRefreshToken("c1", { refreshToken: "rt", scope: "tasks:write" }))).toBe("invalid_scope");
  });
});

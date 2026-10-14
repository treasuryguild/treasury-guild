import { decodeJwt, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_MINUTES,
  mintAccessJwt,
  mintSessionJwt,
  SESSION_MAX_AGE_SECONDS,
  verifySessionJwt,
} from "./jwt";

const SECRET = "test-supabase-jwt-secret-with-enough-length";
const WALLET = "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const key = (secret = SECRET) => new TextEncoder().encode(secret);

const savedSecret = process.env.SUPABASE_JWT_SECRET;
beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
});
afterEach(() => {
  vi.useRealTimers();
  if (savedSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = savedSecret;
});

describe("mintAccessJwt", () => {
  it("is signed with the Supabase JWT secret (HS256)", async () => {
    const token = await mintAccessJwt(WALLET);
    expect(decodeProtectedHeader(token).alg).toBe("HS256");
    await expect(jwtVerify(token, key())).resolves.toBeDefined();
    await expect(jwtVerify(token, key("another-secret-of-similar-length-000000000"))).rejects.toThrow();
  });

  it("carries the wallet claim and the shape RLS expects", async () => {
    const { payload } = await jwtVerify(await mintAccessJwt(WALLET), key(), { audience: "authenticated", issuer: "treasury-guild" });
    expect(payload.wallet).toBe(WALLET);
    expect(payload.sub).toBe(WALLET);
    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
    expect(payload.iss).toBe("treasury-guild");
  });

  it(`expires ${ACCESS_TOKEN_MINUTES} minutes after it is issued`, async () => {
    expect(ACCESS_TOKEN_MINUTES).toBe(15);
    const before = Math.floor(Date.now() / 1000);
    const claims = decodeJwt(await mintAccessJwt(WALLET));
    const after = Math.floor(Date.now() / 1000);
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
    expect(claims.exp! - claims.iat!).toBe(ACCESS_TOKEN_MINUTES * 60);
  });

  it("verifies until its expiry and not after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const token = await mintAccessJwt(WALLET);
    vi.setSystemTime(new Date("2026-09-30T12:14:00Z"));
    expect(await verifySessionJwt(token)).toEqual({ wallet: WALLET });
    vi.setSystemTime(new Date("2026-09-30T12:16:00Z"));
    expect(await verifySessionJwt(token)).toBeNull();
  });

  it("is shorter-lived than the session token with the same claims", async () => {
    const access = decodeJwt(await mintAccessJwt(WALLET));
    const session = decodeJwt(await mintSessionJwt(WALLET));
    expect(session.exp! - session.iat!).toBe(SESSION_MAX_AGE_SECONDS);
    expect(access.exp! - access.iat!).toBeLessThan(session.exp! - session.iat!);
    expect({ ...access, exp: 0, iat: 0 }).toEqual({ ...session, exp: 0, iat: 0 });
  });
});

describe("verifySessionJwt", () => {
  const forge = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; secret?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setAudience(opts.aud ?? "authenticated")
      .setIssuer(opts.iss ?? "treasury-guild")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key(opts.secret));

  it("reads the wallet of a token it minted", async () => {
    expect(await verifySessionJwt(await mintSessionJwt(WALLET))).toEqual({ wallet: WALLET });
  });

  it("is null for garbage and for a tampered token", async () => {
    expect(await verifySessionJwt("")).toBeNull();
    expect(await verifySessionJwt("not.a.jwt")).toBeNull();
    const token = await mintAccessJwt(WALLET);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const swapped = Buffer.from(JSON.stringify({ ...decodeJwt(token), wallet: "addr_test1other" })).toString("base64url");
    expect(payload).not.toBe(swapped);
    expect(await verifySessionJwt(`${header}.${swapped}.${signature}`)).toBeNull();
  });

  it("is null for a token signed with another secret", async () => {
    expect(await verifySessionJwt(await forge({ wallet: WALLET }, { secret: "some-other-secret-of-similar-length-0000" }))).toBeNull();
  });

  it("is null for another audience or issuer", async () => {
    expect(await verifySessionJwt(await forge({ wallet: WALLET }, { aud: "anon" }))).toBeNull();
    expect(await verifySessionJwt(await forge({ wallet: WALLET }, { iss: "supabase" }))).toBeNull();
  });

  it("is null without a usable wallet claim", async () => {
    expect(await verifySessionJwt(await forge({}))).toBeNull();
    expect(await verifySessionJwt(await forge({ wallet: "" }))).toBeNull();
    expect(await verifySessionJwt(await forge({ wallet: 42 }))).toBeNull();
  });

  it("is null for an unsigned (alg none) token", async () => {
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: "none" })}.${b64({ wallet: WALLET, aud: "authenticated", iss: "treasury-guild", exp: now + 300 })}.`;
    expect(await verifySessionJwt(unsigned)).toBeNull();
  });
});

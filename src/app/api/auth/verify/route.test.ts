import { Address, Ed25519PrivateKey, serializeAddress, signData } from "@meshsdk/core-cst";
import { ready } from "@cardano-sdk/crypto";
import { decodeJwt } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_MAX_AGE_SECONDS, verifySessionJwt } from "@/lib/auth/jwt";
import { TooManyRequestsError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), load: vi.fn(), consume: vi.fn(), contributor: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/auth", () => ({ loadNonce: mocks.load, consumeNonce: mocks.consume }));
vi.mock("@/lib/db/membership", () => ({ ensureContributor: mocks.contributor }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
import { POST } from "./route";

// Keys are hashed while this file loads; libsodium's WASM must be up first.
await ready();

// A throwaway key: the real signature check runs, signed as a CIP-30 wallet would.
const privateKey = Ed25519PrivateKey.fromNormalBytes(Buffer.alloc(32, 7));
const keyHash = String(privateKey.toPublic().hash().hex());
const OTHER_HASH = "ab".repeat(28);
const WALLET = serializeAddress({ pubKeyHash: keyHash, stakeCredentialHash: OTHER_HASH }, 0);
const NONCE = `guild-vault login | vault.test | ${WALLET} | 3f2c8a52-8c0c-4d55-9b57-0d6f6f0c2f11 | 2026-09-30T12:00:00.000Z`;
const sign = (text: string, address = WALLET) => signData(text, { address: Address.fromBech32(address), key: privateKey });
const MINUTE = 60_000;

const context = { params: Promise.resolve({}) };
const request = (body: object, headers: Record<string, string> = {}) => new Request("http://localhost/api/auth/verify", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
});
const login = (overrides: object = {}) => ({ address: WALLET, nonce: NONCE, ...sign(NONCE), ...overrides });
const error = async (response: Response) => (await response.json()).error as string;
/** The session cookie a response sets: its value and its lower-cased attributes. */
function sessionCookie(response: Response): { value: string; attributes: string[] } | null {
  const header = response.headers.getSetCookie().find((c) => c.startsWith("gv_session="));
  if (!header) return null;
  const [pair, ...attributes] = header.split("; ");
  return { value: pair!.slice("gv_session=".length), attributes: attributes.map((a) => a.toLowerCase()) };
}

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = "test-supabase-jwt-secret-with-enough-length";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.load.mockResolvedValue({ nonce: NONCE, expires_at: new Date(Date.now() + 5 * MINUTE).toISOString() });
  mocks.consume.mockResolvedValue(true);
  mocks.contributor.mockResolvedValue({ created: true });
  mocks.rateLimit.mockResolvedValue(undefined);
});

describe("auth verify API", () => {
  it("signs the wallet in: the session is an httpOnly cookie, never part of the body", async () => {
    const response = await POST(request(login(), { "x-nf-client-connection-ip": "203.0.113.7" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wallet: WALLET, firstLogin: true });

    const cookie = sessionCookie(response)!;
    expect(cookie.attributes).toContain("httponly");
    expect(cookie.attributes).toContain("samesite=lax");
    expect(cookie.attributes).toContain("path=/");
    expect(cookie.attributes).toContain(`max-age=${SESSION_MAX_AGE_SECONDS}`);
    expect(SESSION_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(await verifySessionJwt(cookie.value)).toEqual({ wallet: WALLET });
    const claims = decodeJwt(cookie.value);
    expect(claims.exp! - claims.iat!).toBe(SESSION_MAX_AGE_SECONDS);

    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith("authVerifyIp", "203.0.113.7");
    expect(mocks.load).toHaveBeenCalledWith(WALLET, NONCE);
    expect(mocks.consume).toHaveBeenCalledExactlyOnceWith(WALLET, NONCE);
    expect(mocks.contributor).toHaveBeenCalledExactlyOnceWith(WALLET);
  });

  it("reports a returning wallet as not a first login", async () => {
    mocks.contributor.mockResolvedValue({ created: false });
    expect(await (await POST(request(login()), context)).json()).toEqual({ wallet: WALLET, firstLogin: false });
  });

  it("marks the cookie Secure in production only", async () => {
    expect(sessionCookie(await POST(request(login()), context))!.attributes).not.toContain("secure");
    const env = process.env as Record<string, string | undefined>;
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(sessionCookie(await POST(request(login()), context))!.attributes).toContain("secure");
    } finally {
      env.NODE_ENV = nodeEnv;
    }
  });

  describe("what it refuses", () => {
    const refused = async (response: Response, message: string) => {
      expect(response.status).toBe(401);
      expect(await error(response)).toBe(message);
      expect(sessionCookie(response)).toBeNull();
      expect(mocks.contributor).not.toHaveBeenCalled();
    };

    it("refuses a challenge never issued to this address, and an expired one", async () => {
      mocks.load.mockResolvedValue(null);
      await refused(await POST(request(login()), context), "Nonce expired");
      mocks.load.mockResolvedValue({ nonce: NONCE, expires_at: new Date(Date.now() - MINUTE).toISOString() });
      await refused(await POST(request(login()), context), "Nonce expired");
      expect(mocks.consume).not.toHaveBeenCalled();
    });

    it("refuses a signature over another text, and leaves the challenge for its owner", async () => {
      const response = await POST(request(login(sign(NONCE.replace("vault.test", "evil.test")))), context);
      await refused(response, "Invalid signature");
      expect(mocks.consume).not.toHaveBeenCalled();
    });

    it("refuses garbage and a signature made by another key", async () => {
      await refused(await POST(request(login({ key: "zz", signature: "zz" })), context), "Invalid signature");
      const other = Ed25519PrivateKey.fromNormalBytes(Buffer.alloc(32, 9));
      const forged = signData(NONCE, { address: Address.fromBech32(WALLET), key: other });
      await refused(await POST(request(login(forged)), context), "Invalid signature");
      expect(mocks.consume).not.toHaveBeenCalled();
    });

    it("refuses a signature from the address's stake key", async () => {
      // Mesh's checkSignature accepts this; the login needs the payment key.
      const borrowed = serializeAddress({ pubKeyHash: OTHER_HASH, stakeCredentialHash: keyHash }, 0);
      const nonce = NONCE.replace(WALLET, borrowed);
      mocks.load.mockResolvedValue({ nonce, expires_at: new Date(Date.now() + 5 * MINUTE).toISOString() });
      await refused(await POST(request({ address: borrowed, nonce, ...sign(nonce, borrowed) }), context), "Invalid signature");
      expect(mocks.consume).not.toHaveBeenCalled();
    });

    it("refuses an address whose payment part is a script, even signed by its stake key", async () => {
      const scripted = serializeAddress({ scriptHash: OTHER_HASH, stakeCredentialHash: keyHash }, 0);
      const nonce = NONCE.replace(WALLET, scripted);
      mocks.load.mockResolvedValue({ nonce, expires_at: new Date(Date.now() + 5 * MINUTE).toISOString() });
      await refused(await POST(request({ address: scripted, nonce, ...sign(nonce, scripted) }), context), "Invalid signature");
      expect(mocks.consume).not.toHaveBeenCalled();
    });

    it("refuses a good signature whose challenge another request already consumed", async () => {
      mocks.consume.mockResolvedValue(false);
      await refused(await POST(request(login()), context), "Nonce expired");
      expect(mocks.consume).toHaveBeenCalledWith(WALLET, NONCE);
    });

    it("answers 429 over the IP budget before reading the challenge", async () => {
      mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
      const response = await POST(request(login()), context);
      expect(response.status).toBe(429);
      expect(sessionCookie(response)).toBeNull();
      expect(mocks.load).not.toHaveBeenCalled();
    });

    it("refuses an incomplete body before charging anything", async () => {
      for (const body of [{}, { address: WALLET }, login({ key: "" }), login({ signature: undefined }), login({ nonce: undefined }), login({ nonce: "" })]) {
        expect((await POST(request(body), context)).status).toBe(400);
      }
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.load).not.toHaveBeenCalled();
    });

    it("refuses a request that declares another origin", async () => {
      const response = await POST(request(login(), { Origin: "https://evil.test" }), context);
      expect(response.status).toBe(403);
      expect(sessionCookie(response)).toBeNull();
      expect(mocks.load).not.toHaveBeenCalled();
    });
  });
});

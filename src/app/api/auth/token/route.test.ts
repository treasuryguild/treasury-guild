import { decodeJwt } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_MINUTES, mintSessionJwt, SESSION_COOKIE, verifySessionJwt } from "@/lib/auth/jwt";

// The real session reader runs over a mocked cookie jar, so the token in the
// answer can be compared with the cookie's own bytes.
const mocks = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
import { GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const OTHER = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";

const context = { params: Promise.resolve({}) };
const request = () => new Request("http://localhost/api/auth/token");
/** A cookie jar holding `value` as the session cookie (none when undefined). */
function jar(value?: string) {
  mocks.cookies.mockResolvedValue({
    get: (name: string) => (name === SESSION_COOKIE && value !== undefined ? { name, value } : undefined),
  });
}

const savedDevWallets = process.env.DEV_WALLETS;
beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = "test-supabase-jwt-secret-with-enough-length";
});

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.DEV_WALLETS;
  jar();
});
afterEach(() => {
  if (savedDevWallets === undefined) delete process.env.DEV_WALLETS;
  else process.env.DEV_WALLETS = savedDevWallets;
});

describe("auth token API", () => {
  it("answers no token and no wallet without a session cookie", async () => {
    const response = await GET(request(), context);
    expect(await response.json()).toEqual({ token: null, wallet: null, developer: false });
  });

  it("answers no token for a cookie that is not a session this app signed", async () => {
    jar("not.a.jwt");
    expect(await (await GET(request(), context)).json()).toEqual({ token: null, wallet: null, developer: false });
  });

  it("answers no token for an expired session, or one signed with another key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60_000);
    const expired = await mintSessionJwt(WALLET);
    vi.useRealTimers();
    jar(expired);
    expect(await (await GET(request(), context)).json()).toEqual({ token: null, wallet: null, developer: false });

    const secret = process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_JWT_SECRET = "another-secret-entirely-of-enough-length";
    const foreign = await mintSessionJwt(WALLET);
    process.env.SUPABASE_JWT_SECRET = secret;
    jar(foreign);
    expect(await (await GET(request(), context)).json()).toEqual({ token: null, wallet: null, developer: false });
  });

  it("gives the session wallet a fresh 15-minute token, never the cookie's bytes", async () => {
    const cookie = await mintSessionJwt(WALLET);
    jar(cookie);
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string; wallet: string; developer: boolean };
    expect(body).toEqual({ token: expect.any(String), wallet: WALLET, developer: false });

    expect(body.token).not.toBe(cookie);
    // The access token must not verify as a session cookie (kind: rls).
    expect(await verifySessionJwt(body.token)).toBeNull();
    const claims = decodeJwt(body.token);
    expect(claims).toMatchObject({
      wallet: WALLET, sub: WALLET, role: "authenticated", aud: "authenticated", kind: "rls",
    });
    expect(claims.exp! - claims.iat!).toBe(ACCESS_TOKEN_MINUTES * 60);
    expect(ACCESS_TOKEN_MINUTES).toBe(15);
    // The cookie itself is never set, refreshed or echoed by this route.
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("flags a wallet on the DEV_WALLETS allowlist, and only that wallet", async () => {
    process.env.DEV_WALLETS = ` ${OTHER} , ${WALLET}`;
    jar(await mintSessionJwt(WALLET));
    expect(await (await GET(request(), context)).json()).toMatchObject({ wallet: WALLET, developer: true });
    process.env.DEV_WALLETS = OTHER;
    expect(await (await GET(request(), context)).json()).toMatchObject({ wallet: WALLET, developer: false });
  });
});

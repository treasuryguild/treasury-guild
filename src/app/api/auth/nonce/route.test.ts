import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), save: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/auth", () => ({ saveNonce: mocks.save }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
import { POST } from "./route";

// A well-formed preprod enterprise address (random key hash) so the schema's address check passes.
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

const context = { params: Promise.resolve({}) };
const request = (body: object, headers: Record<string, string> = {}) => new Request("http://localhost/api/auth/nonce", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
});

beforeAll(() => {
  process.env.APP_URL = "https://vault.test";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.save.mockResolvedValue(undefined);
  mocks.rateLimit.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("auth nonce API", () => {
  it("issues a challenge naming the site and the address, stored for five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const response = await POST(request({ address: ALICE }), context);
    expect(response.status).toBe(200);
    const { nonce } = await response.json() as { nonce: string };
    const parts = nonce.split(" | ");
    expect(parts).toEqual([
      "guild-vault login", "vault.test", ALICE,
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      "2026-09-30T12:00:00.000Z",
    ]);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(ALICE, nonce, "2026-09-30T12:05:00.000Z");
  });

  it("needs no session and issues a different challenge each time", async () => {
    const first = await (await POST(request({ address: ALICE }), context)).json() as { nonce: string };
    const second = await (await POST(request({ address: ALICE }), context)).json() as { nonce: string };
    expect(first.nonce).not.toBe(second.nonce);
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it("charges the caller's IP only (never the address, whose budget anyone could spend) before storing anything", async () => {
    await POST(request({ address: ALICE }, { "x-nf-client-connection-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }), context);
    expect(mocks.rateLimit.mock.calls).toEqual([["authNonceIp", "203.0.113.7"]]);
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]!);
  });

  it("answers 429 over the IP budget without storing a challenge", async () => {
    mocks.rateLimit.mockRejectedValueOnce(new TooManyRequestsError());
    expect((await POST(request({ address: ALICE }), context)).status).toBe(429);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a missing or malformed address before charging anything", async () => {
    for (const body of [{}, { address: "" }, { address: "not-an-address" }, { address: 42 }]) {
      expect((await POST(request(body), context)).status).toBe(400);
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a request that declares another origin", async () => {
    const response = await POST(request({ address: ALICE }, { Origin: "https://evil.test" }), context);
    expect(response.status).toBe(403);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

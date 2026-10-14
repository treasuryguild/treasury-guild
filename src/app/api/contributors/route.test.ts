import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), limit: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/db/membership", () => ({ ensureContributor: mocks.ensure }));
import { POST } from "./route";

const WALLET = "addr_test1member";
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const post = (body: object, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/contributors", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
}), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.limit.mockResolvedValue(undefined);
  mocks.ensure.mockResolvedValue({ created: true });
});

describe("POST /api/contributors", () => {
  it("registers the address for any signed-in wallet, charged to that wallet's limit", async () => {
    const res = await post({ address: ALICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.limit).toHaveBeenCalledWith("contributorRegister", WALLET);
    expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith(ALICE);
    expect(mocks.limit.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensure.mock.invocationCallOrder[0]!);
  });

  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post({ address: ALICE })).status).toBe(401);
    expect((await post({ address: ALICE }, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("refuses anything but a valid address without charging the limit", async () => {
    for (const body of [{}, { address: "" }, { address: "not-an-address" }, { address: `${ALICE}x` }, { address: 7 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("writes nothing once the wallet is over its limit", async () => {
    mocks.limit.mockRejectedValue(new TooManyRequestsError());
    expect((await post({ address: ALICE })).status).toBe(429);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env.server";

const mocks = vi.hoisted(() => ({ session: vi.fn(), gateway: vi.fn(), jwt: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/env.server", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  pinataGateway: mocks.gateway, pinataJwt: mocks.jwt,
}));
import { GET } from "./route";

const get = () => GET(new Request("http://localhost/api/ipfs/gateway"), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.gateway.mockReturnValue("guild.mypinata.cloud");
});

describe("GET /api/ipfs/gateway", () => {
  it("names the gateway host to anyone, signed in or not, and never reads the Pinata JWT", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gateway: "guild.mypinata.cloud" });
    mocks.session.mockResolvedValue({ wallet: "addr_test1member" });
    expect(await (await get()).json()).toEqual({ gateway: "guild.mypinata.cloud" });
    expect(mocks.jwt).not.toHaveBeenCalled();
  });
});

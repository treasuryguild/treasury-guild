import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "@/lib/config";

const mocks = vi.hoisted(() => ({ session: vi.fn(), network: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  appNetwork: mocks.network,
}));
import { GET } from "./route";

const get = () => GET(new Request("http://localhost/api/health"), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.network.mockReturnValue(0);
});

describe("GET /api/health", () => {
  it("answers without a session, naming the deployment's default network", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, network: "preprod" });
    mocks.network.mockReturnValue(1);
    expect(await (await get()).json()).toEqual({ ok: true, network: "mainnet" });
  });
});

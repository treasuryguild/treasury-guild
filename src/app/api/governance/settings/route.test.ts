import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), admin: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/governance", () => ({ saveGovernanceSettings: mocks.save }));

import { DEFAULT_SETTINGS } from "@/lib/governance/rules";
import { POST } from "./route";

const WALLET = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const SETTINGS = { ...DEFAULT_SETTINGS.budget, enabled: true };
const BODY = { communityId: COMMUNITY, kind: "budget", settings: SETTINGS };
const context = { params: Promise.resolve({}) };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/governance/settings", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
  }), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
});

describe("POST /api/governance/settings", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post(BODY)).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post(BODY, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses an invalid body before checking the role", async () => {
    const withoutEnabled = Object.fromEntries(Object.entries(SETTINGS).filter(([key]) => key !== "enabled"));
    const invalid = [
      {},
      { ...BODY, communityId: "nope" },
      { ...BODY, kind: "coup" },
      { communityId: COMMUNITY, kind: "budget" },
      { ...BODY, settings: withoutEnabled },
      { ...BODY, settings: { ...SETTINGS, thresholdPct: 49 } },
      { ...BODY, settings: { ...SETTINGS, quorumPct: 101 } },
      { ...BODY, settings: { ...SETTINGS, votingHours: 0 } },
      { ...BODY, settings: { ...SETTINGS, method: "dictatorship" } },
      { ...BODY, settings: { ...SETTINGS, lazyCapLovelace: "0" } },
      { ...BODY, settings: { ...SETTINGS, escalateMethod: "lazy" } },
    ];
    for (const body of invalid) expect((await post(body)).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("requires an admin of the community", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await post(BODY)).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves the kind's settings with the session wallet as actor", async () => {
    const res = await post({ ...BODY, actor: "addr_test1other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.save).toHaveBeenCalledWith(COMMUNITY, "budget", SETTINGS, WALLET);
  });

  it("accepts every live kind", async () => {
    for (const kind of ["budget", "workgroup", "task", "decision"] as const) {
      expect((await post({ communityId: COMMUNITY, kind, settings: DEFAULT_SETTINGS[kind] })).status).toBe(200);
      expect(mocks.save).toHaveBeenLastCalledWith(COMMUNITY, kind, DEFAULT_SETTINGS[kind], WALLET);
    }
  });

  it("maps the RPC's refusal to 400", async () => {
    mocks.save.mockRejectedValue(new BadRequestError("Quorum must be between 0 and 100"));
    expect((await post(BODY)).status).toBe(400);
  });
});

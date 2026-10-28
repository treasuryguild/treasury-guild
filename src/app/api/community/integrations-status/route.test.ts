import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { SpendCheckMode } from "@/lib/governance/rules";
import type { IntegrationsStatus } from "@/lib/integrations/status";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  load: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/integrations/loadStatus", () => ({ loadIntegrationsStatus: mocks.load }));

import { GET } from "./route";

const WALLET = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const URL = "http://localhost/api/community/integrations-status";
const context = { params: Promise.resolve({}) };
const get = (query: string) => GET(new Request(`${URL}${query}`), context);

const SAMPLE: IntegrationsStatus = {
  discord: { serverConnected: false, serverLabel: null, channelId: null, lastError: null },
  payoutDiscord: { treasuries: [], rateConfigured: false },
  github: { installationCount: 0, linkedRepoCount: 0, workgroupsMissingRepo: 0, archiveReady: true },
  calls: { zoomConnected: false, googleConnected: false, linkedMeetingCount: 0 },
  records: { documentStore: null, spendCheck: SpendCheckMode.Warn, anyKindEnabled: false },
  treasuryCount: 0,
  checklist: [{ id: "treasury", label: "Create or import a treasury", soft: false }],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.load.mockResolvedValue(SAMPLE);
});

describe("GET /api/community/integrations-status", () => {
  it("requires a session, a valid community id and the admin role", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(401);
    expect((await get("")).status).toBe(400);
    expect((await get("?communityId=nope")).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.admin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("returns the assembled status for an admin", async () => {
    const res = await get(`?communityId=${COMMUNITY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(COMMUNITY);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Incoming from "@/lib/db/incoming";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  incoming: vi.fn(),
  source: vi.fn(),
  commitment: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/incoming", async (importOriginal) => ({
  ...(await importOriginal<typeof Incoming>()),
  loadIncomingWithTreasury: mocks.incoming,
}));
vi.mock("@/lib/db/funding", () => ({ loadFundingSource: mocks.source, loadFundingCommitment: mocks.commitment }));
vi.mock("@/lib/db/client", () => {
  const reconciliations = { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
  const incoming = { update: (values: object) => { mocks.update(values); return { eq: async () => ({ error: null }) }; } };
  return {
    serviceClient: () => ({ from: (table: string) => (table === "reconciliations" ? reconciliations : incoming) }),
    maybe: (res: { data: unknown }) => res.data,
    check: () => undefined,
  };
});
import { PATCH } from "./route";

const TX = "a".repeat(64);
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const SOURCE = "30000000-0000-4000-8000-000000000001";
const COMMITMENT = "40000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const request = (value: object) => new Request("http://localhost/api/reconcile/incoming", {
  method: "PATCH", body: JSON.stringify(value), headers: { "Content-Type": "application/json" },
});
const body = (extra: object = {}) => ({ txHash: TX, incomingType: "contribution", requiresReconciliation: false, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1admin" });
  mocks.admin.mockResolvedValue("admin");
  mocks.incoming.mockResolvedValue({ tx_hash: TX, from_treasury_id: null, treasuries: { id: "t", community_id: COMMUNITY } });
  mocks.source.mockResolvedValue({ id: SOURCE, community_id: COMMUNITY });
  mocks.commitment.mockResolvedValue({ id: COMMITMENT, source_id: SOURCE });
});

describe("PATCH /api/reconcile/incoming funding tags", () => {
  it("ties the whole inflow to a source and commitment", async () => {
    const res = await PATCH(request(body({ fundingSourceId: SOURCE, fundingCommitmentId: COMMITMENT })), context);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ funding_source_id: SOURCE, funding_commitment_id: COMMITMENT }));
  });

  it("leaves the tag alone when the body does not mention it, and clears it with null", async () => {
    await PATCH(request(body()), context);
    expect(mocks.update.mock.calls[0]![0]).not.toHaveProperty("funding_source_id");
    await PATCH(request(body({ fundingSourceId: null })), context);
    expect(mocks.update.mock.calls[1]![0]).toMatchObject({ funding_source_id: null, funding_commitment_id: null });
  });

  it("refuses a source of another community, a commitment of another source, and transfers", async () => {
    mocks.source.mockResolvedValueOnce({ id: SOURCE, community_id: "other" });
    expect((await PATCH(request(body({ fundingSourceId: SOURCE })), context)).status).toBe(404);
    mocks.commitment.mockResolvedValueOnce({ id: COMMITMENT, source_id: "another" });
    expect((await PATCH(request(body({ fundingSourceId: SOURCE, fundingCommitmentId: COMMITMENT })), context)).status).toBe(400);
    mocks.incoming.mockResolvedValueOnce({ tx_hash: TX, from_treasury_id: "t2", treasuries: { id: "t", community_id: COMMUNITY } });
    expect((await PATCH(request(body({ fundingSourceId: SOURCE })), context)).status).toBe(400);
    expect((await PATCH(request(body({ fundingCommitmentId: COMMITMENT })), context)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await PATCH(request(body({ fundingSourceId: SOURCE })), context)).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

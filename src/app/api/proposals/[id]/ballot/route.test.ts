import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), rateLimit: vi.fn(), issue: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/governance/vote", () => ({ issueBallot: mocks.issue, castBallot: vi.fn() }));

import { POST } from "./route";

const WALLET = "addr_test1voter";
const ID = "40000000-0000-4000-8000-000000000001";
const BALLOT = { text: "Guild Vault ballot…", signedAt: "2026-09-30T10:00:00.000Z" };
const post = (body: unknown, headers: Record<string, string> = {}, id = ID) =>
  POST(new Request(`http://localhost/api/proposals/${id}/ballot`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
  }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.issue.mockResolvedValue(BALLOT);
});

describe("POST /api/proposals/[id]/ballot", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post({ choice: "yes" })).status).toBe(401);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post({ choice: "yes" }, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("refuses an invalid body before charging the rate limit", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ choice: "maybe" })).status).toBe(400);
    expect((await post({ choice: "block", reason: 5 })).status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("issues the ballot text for the session wallet's choice", async () => {
    const res = await post({ choice: "block", reason: "Too expensive", voter: "addr_test1other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BALLOT);
    expect(mocks.rateLimit).toHaveBeenCalledWith("proposalVote", WALLET);
    expect(mocks.issue).toHaveBeenCalledWith(ID, WALLET, { choice: "block", reason: "Too expensive" });
  });

  it("stops at the rate limit", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    expect((await post({ choice: "yes" })).status).toBe(429);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("answers 404 for an id the lib does not find (the id is checked there, not in the route)", async () => {
    mocks.issue.mockRejectedValue(new NotFoundError("Proposal not found"));
    expect((await post({ choice: "yes" }, {}, "not-a-uuid")).status).toBe(404);
    expect(mocks.issue).toHaveBeenCalledWith("not-a-uuid", WALLET, { choice: "yes" });
  });
});

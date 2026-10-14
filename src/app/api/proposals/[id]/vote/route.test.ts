import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), rateLimit: vi.fn(), cast: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/governance/vote", () => ({ castBallot: mocks.cast, issueBallot: vi.fn() }));

import { POST } from "./route";

const WALLET = "addr_test1voter";
const ID = "40000000-0000-4000-8000-000000000001";
const VOTE = { choice: "agree", signedAt: "2026-09-30T10:00:00.000Z", key: "a401", signature: "845846A2" };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/proposals/${ID}/vote`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
  }), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.cast.mockResolvedValue({ ok: true, ballotVersion: 3 });
});

describe("POST /api/proposals/[id]/vote", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post(VOTE)).status).toBe(401);
    expect(mocks.cast).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post(VOTE, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.cast).not.toHaveBeenCalled();
  });

  it("refuses an invalid body before charging the rate limit", async () => {
    const invalid = [
      {},
      { ...VOTE, choice: "maybe" },
      { ...VOTE, signedAt: "yesterday" },
      { ...VOTE, key: "not hex" },
      { ...VOTE, signature: "zz" },
      { choice: "agree", signedAt: VOTE.signedAt, key: VOTE.key },
    ];
    for (const body of invalid) expect((await post(body)).status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.cast).not.toHaveBeenCalled();
  });

  it("casts the signed ballot as the session wallet, never a voter named in the body", async () => {
    const res = await post({ ...VOTE, reason: "Fine by me", voter: "addr_test1other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ballotVersion: 3 });
    expect(mocks.rateLimit).toHaveBeenCalledWith("proposalVote", WALLET);
    expect(mocks.cast).toHaveBeenCalledWith(ID, WALLET, { ...VOTE, reason: "Fine by me" });
  });

  it("stops at the rate limit", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    expect((await post(VOTE)).status).toBe(429);
    expect(mocks.cast).not.toHaveBeenCalled();
  });

  it("maps the lib's refusals to their status", async () => {
    mocks.cast.mockRejectedValueOnce(new ForbiddenError("You are not in this proposal's electorate"));
    expect((await post(VOTE)).status).toBe(403);
    mocks.cast.mockRejectedValueOnce(new ConflictError("Voting has closed"));
    expect((await post(VOTE)).status).toBe(409);
  });
});

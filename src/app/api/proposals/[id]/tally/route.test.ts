import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), member: vi.fn(), slug: vi.fn(), load: vi.fn(), ballots: vi.fn(), build: vi.fn(), frozen: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/communities", () => ({ communitySlug: mocks.slug }));
vi.mock("@/lib/db/governance", () => ({
  loadProposal: mocks.load, loadProposalBallots: mocks.ballots, loadTallyDocument: mocks.frozen,
}));
vi.mock("@/lib/governance/tallyDocument", () => ({
  buildTallyDocument: mocks.build, tallyDocumentText: (doc: unknown) => JSON.stringify(doc),
}));

import { GET } from "./route";

const WALLET = "addr_test1member";
const ID = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const proposal = (state: string, hideResults: boolean) => ({ id: ID, community_id: COMMUNITY, number: 7, state, rules: { hideResults } });
const BALLOTS = { voters: [{ wallet_address: "addr_a", recused: false }], votes: [{ voter: "addr_a", choice: "yes" }] };
const DOCUMENT = { format: "guild-vault-tally", hash: "abc" };
const get = (id = ID) => GET(new Request(`http://localhost/api/proposals/${id}/tally`), { params: Promise.resolve({ id }) });

const savedAppUrl = process.env.APP_URL;
beforeAll(() => {
  process.env.APP_URL = "https://vault.example";
});
afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.load.mockResolvedValue(proposal("passed", true));
  mocks.member.mockResolvedValue("member");
  mocks.slug.mockResolvedValue("signius");
  mocks.ballots.mockResolvedValue(BALLOTS);
  mocks.build.mockReturnValue(DOCUMENT);
  mocks.frozen.mockResolvedValue(null);
});

function nothingRead() {
  expect(mocks.ballots).not.toHaveBeenCalled();
  expect(mocks.build).not.toHaveBeenCalled();
}

describe("GET /api/proposals/[id]/tally", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
    nothingRead();
  });

  it("answers 404 for an unknown proposal", async () => {
    mocks.load.mockRejectedValue(new NotFoundError("Proposal not found"));
    expect((await get("not-a-uuid")).status).toBe(404);
    nothingRead();
  });

  it("requires a member of the proposal's community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a member of this community"));
    expect((await get()).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    nothingRead();
  });

  it("refuses with 409 while ballots are hidden, reading none of them", async () => {
    for (const state of ["discussion", "voting"]) {
      mocks.load.mockResolvedValue(proposal(state, true));
      const res = await get();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "Ballots stay hidden until voting closes", conflict: true });
    }
    nothingRead();
  });

  it("serves the signed tally of a closed proposal as a no-store download", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DOCUMENT);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="signius-proposal-7-tally.json"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.slug).toHaveBeenCalledWith(COMMUNITY);
    expect(mocks.ballots).toHaveBeenCalledWith(ID);
    expect(mocks.build).toHaveBeenCalledWith({
      app: "vault.example", community: "signius", proposal: proposal("passed", true), ...BALLOTS,
    });
  });

  it("serves it during voting when the rules show results live", async () => {
    mocks.load.mockResolvedValue(proposal("voting", false));
    expect((await get()).status).toBe(200);
    expect(mocks.build).toHaveBeenCalledTimes(1);
  });

  it("serves a frozen document byte for byte, building nothing", async () => {
    const stored = '{"body":{"frozen":true},"hash":"def","hashAlgorithm":"blake2b-256"}';
    mocks.frozen.mockResolvedValue({ proposal_id: ID, document: stored, hash: "def" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(stored);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(mocks.frozen).toHaveBeenCalledWith(ID);
    nothingRead();
  });
});

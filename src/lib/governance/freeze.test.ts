import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalRow } from "@/lib/db/types";

const mocks = vi.hoisted(() => ({
  slug: vi.fn(), ballots: vi.fn(), freeze: vi.fn(), toFreeze: vi.fn(), build: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ communitySlug: mocks.slug }));
vi.mock("@/lib/db/governance", () => ({
  loadProposalBallots: mocks.ballots, freezeProposalTally: mocks.freeze, listProposalsToFreeze: mocks.toFreeze,
}));
vi.mock("./tallyDocument", () => ({
  buildTallyDocument: mocks.build, tallyDocumentText: (doc: unknown) => JSON.stringify(doc),
}));

import { freezable, freezeMissingTallyDocuments, freezeTallyDocument, tryFreezeTallyDocument } from "./freeze";

const row = (patch: Partial<ProposalRow>) => ({
  id: "p-1", community_id: "c-1", state: "passed", voting_opened_at: "2026-09-28T10:00:00Z", ...patch,
}) as unknown as ProposalRow;
const DOC = { hashAlgorithm: "blake2b-256", body: { x: 1 }, hash: "ab".repeat(32) };

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
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.slug.mockResolvedValue("signius");
  mocks.ballots.mockResolvedValue({ voters: [], votes: [] });
  mocks.build.mockReturnValue(DOC);
  mocks.freeze.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("freezable", () => {
  it("is final and reached voting", () => {
    expect(freezable(row({}))).toBe(true);
    for (const state of ["rejected", "expired", "cancelled", "withdrawn"] as const) expect(freezable(row({ state }))).toBe(true);
    expect(freezable(row({ state: "voting" }))).toBe(false);
    expect(freezable(row({ state: "discussion" }))).toBe(false);
    // Withdrawn before voting, or cancelled for want of voters: no ballots to record.
    expect(freezable(row({ state: "withdrawn", voting_opened_at: null }))).toBe(false);
    expect(freezable(row({ state: "cancelled", voting_opened_at: null }))).toBe(false);
  });
});

describe("freezeTallyDocument", () => {
  it("builds the document from the app host, slug and ballots and stores its text and hash once", async () => {
    expect(await freezeTallyDocument(row({}))).toBe(true);
    expect(mocks.build).toHaveBeenCalledWith({ app: "vault.example", community: "signius", proposal: row({}), voters: [], votes: [] });
    expect(mocks.freeze).toHaveBeenCalledWith("p-1", JSON.stringify(DOC), "ab".repeat(32));
    mocks.freeze.mockResolvedValue(false);
    expect(await freezeTallyDocument(row({}))).toBe(false);
  });

  it("does nothing for a proposal that is not freezable", async () => {
    expect(await freezeTallyDocument(row({ state: "voting" }))).toBe(false);
    expect(mocks.ballots).not.toHaveBeenCalled();
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it("never lets a failure out of tryFreezeTallyDocument", async () => {
    mocks.freeze.mockRejectedValue(new Error("db down"));
    await expect(tryFreezeTallyDocument(row({}))).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("freeze tally document of proposal p-1 failed", expect.any(Error));
  });
});

describe("freezeMissingTallyDocuments", () => {
  it("freezes the backlog one by one, counting failures and carrying on", async () => {
    mocks.toFreeze.mockResolvedValue([row({ id: "p-1" }), row({ id: "p-2" }), row({ id: "p-3" })]);
    mocks.freeze.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(true);
    expect(await freezeMissingTallyDocuments()).toEqual({ frozen: 2, failed: 1 });
    expect(mocks.freeze).toHaveBeenCalledTimes(3);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "@/lib/storage";

const mocks = vi.hoisted(() => ({
  communities: vi.fn(), documents: vi.fn(), record: vi.fn(), toCheck: vi.fn(), checked: vi.fn(),
}));
vi.mock("@/lib/db/governance", () => ({
  listPublishingCommunities: mocks.communities,
  listDocumentsToPublish: mocks.documents,
  recordDocumentCopy: mocks.record,
  listCopiesToCheck: mocks.toCheck,
  markCopyChecked: mocks.checked,
}));

import { COPY_CHECK_INTERVAL_MS, documentFilename, publishTallyDocuments } from "./publish";

const NOW = new Date("2026-09-30T12:00:00Z");
const DOC = JSON.stringify({
  hashAlgorithm: "blake2b-256", hash: "ab".repeat(32),
  body: { type: "guild-vault/proposal-tally", version: 1, community: "signius", proposal: { number: 4 } },
});
const document = (proposalId: string, copies: { store: string; locator: string }[] = []) => ({
  proposal_id: proposalId, community_id: "c-1", document: DOC, hash: "ab".repeat(32), frozen_at: "2026-09-29T00:00:00Z",
  proposal_document_copies: copies,
});

function fakeStore(): DocumentStore & { put: ReturnType<typeof vi.fn>; resolves: ReturnType<typeof vi.fn> } {
  return {
    name: "ipfs",
    put: vi.fn(async () => "bafy-new"),
    url: (locator: string) => `https://gw/ipfs/${locator}`,
    resolves: vi.fn(async () => true),
  };
}

let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  store = fakeStore();
  mocks.communities.mockResolvedValue([{ community_id: "c-1", document_store: "ipfs", document_store_since: "2026-09-01T00:00:00Z" }]);
  mocks.documents.mockResolvedValue([]);
  mocks.toCheck.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("documentFilename", () => {
  it("names the file by community and proposal number, with a fallback for an unreadable document", () => {
    expect(documentFilename(DOC, "p-1")).toBe("signius-proposal-4-tally.json");
    expect(documentFilename("not json", "p-1")).toBe("proposal-p-1-tally.json");
  });
});

describe("publishTallyDocuments", () => {
  it("publishes the frozen documents since the store was chosen that lack a copy there, and records each", async () => {
    mocks.documents.mockResolvedValue([document("p-1"), document("p-2", [{ store: "ipfs", locator: "bafy-old" }]), document("p-3")]);
    const result = await publishTallyDocuments(NOW, () => store);
    expect(result).toEqual({ published: 2, republished: 0, failed: 0, checked: 0 });
    expect(mocks.documents).toHaveBeenCalledWith("c-1", "2026-09-01T00:00:00Z");
    expect(store.put).toHaveBeenCalledTimes(2);
    const [bytes, filename, tags] = store.put.mock.calls[0]!;
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(DOC);
    expect(filename).toBe("signius-proposal-4-tally.json");
    expect(tags).toEqual({ hash: "ab".repeat(32), proposal: "p-1" });
    expect(mocks.record).toHaveBeenCalledWith({ proposal_id: "p-1", community_id: "c-1", store: "ipfs", locator: "bafy-new" });
    expect(mocks.record).toHaveBeenCalledWith({ proposal_id: "p-3", community_id: "c-1", store: "ipfs", locator: "bafy-new" });
  });

  it("counts a failed upload and moves on to the next document", async () => {
    mocks.documents.mockResolvedValue([document("p-1"), document("p-2")]);
    store.put.mockRejectedValueOnce(new Error("pinata 502")).mockResolvedValueOnce("bafy-2");
    const result = await publishTallyDocuments(NOW, () => store);
    expect(result).toMatchObject({ published: 1, failed: 1 });
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("publish tally document of proposal p-1 to ipfs failed", expect.any(Error));
  });

  it("does nothing for a community with no store, and nothing at all without documents", async () => {
    mocks.communities.mockResolvedValue([]);
    expect(await publishTallyDocuments(NOW, () => store)).toEqual({ published: 0, republished: 0, failed: 0, checked: 0 });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("checks copies not seen for a week: a resolving copy is stamped, a missing one republished from the database", async () => {
    mocks.toCheck.mockResolvedValue([
      { id: "copy-1", proposal_id: "p-1", community_id: "c-1", store: "ipfs", locator: "bafy-1", proposal_tally_documents: { document: DOC } },
      { id: "copy-2", proposal_id: "p-2", community_id: "c-1", store: "ipfs", locator: "bafy-2", proposal_tally_documents: { document: DOC } },
    ]);
    store.resolves.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await publishTallyDocuments(NOW, () => store);
    expect(result).toEqual({ published: 0, republished: 1, failed: 0, checked: 2 });
    expect(mocks.toCheck).toHaveBeenCalledWith(new Date(NOW.getTime() - COPY_CHECK_INTERVAL_MS).toISOString(), 10);
    expect(mocks.checked).toHaveBeenCalledExactlyOnceWith("copy-1");
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith({ proposal_id: "p-2", community_id: "c-1", store: "ipfs", locator: "bafy-new" });
  });
});

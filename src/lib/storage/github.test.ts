import { describe, expect, it, vi } from "vitest";
import { gitBlobSha, githubLocator, githubStore, tallyPath } from "./github";
import { copyUrl, parseGithubLocator } from "./locator";

const BYTES = new TextEncoder().encode('{"hash":"abc"}');
const BLOB = gitBlobSha(BYTES);
const REPO_ID = 42;
const FULL = "guild/archive";

describe("gitBlobSha / locator", () => {
  it("matches git's blob SHA-1 and builds a short locator", () => {
    expect(BLOB).toMatch(/^[0-9a-f]{40}$/);
    expect(githubLocator(REPO_ID, BLOB)).toBe(`${REPO_ID}/${BLOB}`);
    expect(tallyPath(BLOB)).toBe(`tallies/${BLOB}.json`);
    expect(parseGithubLocator(`${REPO_ID}/${BLOB}`)).toEqual({ repoId: REPO_ID, blobSha: BLOB });
    expect(parseGithubLocator("bad")).toBeNull();
  });
});

describe("githubStore", () => {
  it("creates the content-addressed file and returns repoId/blobSha", async () => {
    const createOrUpdateFileContents = vi.fn(async () => ({ data: { content: { sha: BLOB } } }));
    const getContent = vi.fn(async () => {
      const err = new Error("missing") as Error & { status: number };
      err.status = 404;
      throw err;
    });
    const store = githubStore({
      repoId: REPO_ID, fullName: FULL, installationId: 7,
      octokit: async () => ({ rest: { repos: { createOrUpdateFileContents, getContent } } }) as never,
    });
    expect(await store.put(BYTES, "ignored.json", { hash: "x" })).toBe(`${REPO_ID}/${BLOB}`);
    expect(createOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({
      owner: "guild", repo: "archive", path: `tallies/${BLOB}.json`,
      content: Buffer.from(BYTES).toString("base64"),
    }));
  });

  it("reuses an existing file with the same blob sha and refuses a conflict", async () => {
    const createOrUpdateFileContents = vi.fn();
    const getContent = vi.fn(async () => ({ data: { type: "file", sha: BLOB } }));
    const store = githubStore({
      repoId: REPO_ID, fullName: FULL, installationId: 7,
      octokit: async () => ({ rest: { repos: { createOrUpdateFileContents, getContent } } }) as never,
    });
    expect(await store.put(BYTES, "x.json", {})).toBe(`${REPO_ID}/${BLOB}`);
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();

    getContent.mockResolvedValueOnce({ data: { type: "file", sha: "a".repeat(40) } });
    await expect(store.put(BYTES, "x.json", {})).rejects.toThrow(/different bytes/);
  });

  it("builds the raw.githubusercontent.com URL through the shared locator helper", () => {
    const store = githubStore({
      repoId: REPO_ID, fullName: FULL, installationId: 7,
      octokit: async () => { throw new Error("unused"); },
    });
    const locator = `${REPO_ID}/${BLOB}`;
    const url = `https://raw.githubusercontent.com/${FULL}/HEAD/tallies/${BLOB}.json`;
    expect(store.url(locator)).toBe(url);
    expect(copyUrl("github", locator, {
      ipfsGateway: "",
      githubFullNameByRepoId: { [String(REPO_ID)]: FULL },
    })).toBe(url);
  });

  it("resolves through a HEAD on the raw URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const store = githubStore({
      repoId: REPO_ID, fullName: FULL, installationId: 7,
      octokit: async () => { throw new Error("unused"); },
      fetchImpl,
    });
    const locator = `${REPO_ID}/${BLOB}`;
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await store.resolves(locator)).toBe(true);
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await store.resolves(locator)).toBe(false);
  });
});

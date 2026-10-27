// GitHub Contents API as a document store (migration 0067): frozen tally
 // JSON is committed under tallies/{blobSha}.json in a community's archive
 // repository. The locator is `{repoId}/{blobSha}` (fits the 64-byte
 // metadatum cap); the on-chain hash still proves the bytes.
import "server-only";

import { createHash } from "node:crypto";
import type { Octokit } from "octokit";
import { installationOctokit } from "@/lib/github/app";
import { splitRepoFullName } from "@/lib/github/repoName";
import { copyUrl, parseGithubLocator } from "./locator";
import type { DocumentStore } from "./types";

const RESOLVE_TIMEOUT_MS = 15_000;

/** Git's blob SHA-1 of `bytes` (what the Contents API stores as content.sha). */
export function gitBlobSha(bytes: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const data = new Uint8Array(header.length + bytes.byteLength);
  data.set(header, 0);
  data.set(bytes, header.length);
  return createHash("sha1").update(data).digest("hex");
}

export function githubLocator(repoId: number, blobSha: string): string {
  return `${repoId}/${blobSha}`;
}

export { parseGithubLocator };

export function tallyPath(blobSha: string): string {
  return `tallies/${blobSha}.json`;
}

export function githubStore(deps: {
  repoId: number;
  fullName: string;
  installationId: number;
  octokit?: () => Promise<Octokit>;
  fetchImpl?: typeof fetch;
}): DocumentStore {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const octokitOf = deps.octokit ?? (() => installationOctokit(deps.installationId));
  const { owner, repo } = splitRepoFullName(deps.fullName);

  return {
    name: "github",
    async put(bytes) {
      const blobSha = gitBlobSha(bytes);
      const path = tallyPath(blobSha);
      const locator = githubLocator(deps.repoId, blobSha);
      const octokit = await octokitOf();

      const existing = await readContents(octokit, owner, repo, path);
      if (existing) {
        if (existing.sha !== blobSha) {
          throw new Error(`GitHub archive path ${path} already holds different bytes`);
        }
        return locator;
      }

      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message: `Publish tally ${blobSha.slice(0, 12)}`,
        content: Buffer.from(bytes).toString("base64"),
      });
      return locator;
    },
    url(locator) {
      return copyUrl("github", locator, {
        ipfsGateway: "",
        githubFullNameByRepoId: { [String(deps.repoId)]: deps.fullName },
      });
    },
    async resolves(locator) {
      const url = copyUrl("github", locator, {
        ipfsGateway: "",
        githubFullNameByRepoId: { [String(deps.repoId)]: deps.fullName },
      });
      try {
        const res = await fetchImpl(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

async function readContents(
  octokit: Octokit, owner: string, repo: string, path: string,
): Promise<{ sha: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if (Array.isArray(data) || data.type !== "file") return null;
    return { sha: data.sha };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

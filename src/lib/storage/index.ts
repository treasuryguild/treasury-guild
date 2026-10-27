// The registry of document stores by name (proposal_document_copies.store,
// governance_community_settings.document_store). Adding a store: one
// adapter file implementing DocumentStore, one entry here, and its name in
// the check constraints (0059 / 0067). GitHub needs community archive
// fields — use documentStoreFor, not documentStore("github") alone.
import "server-only";

import type { PublishingCommunity } from "@/lib/db/governance";
import type { DocumentStoreName } from "@/lib/db/types";
import { resolveCommunityRepo } from "@/lib/github/repoAccess";
import { githubStore, parseGithubLocator } from "./github";
import { ipfsStore } from "./ipfs";
import type { DocumentStore } from "./types";

export type { DocumentStore } from "./types";

const STORES: Record<DocumentStoreName, true> = { ipfs: true, github: true };

/** IPFS (and any name-only store). Prefer documentStoreFor when the community may publish to GitHub. */
export function documentStore(name: DocumentStoreName): DocumentStore {
  if (name === "ipfs") return ipfsStore();
  throw new Error(`documentStore(${name}) needs community archive context; use documentStoreFor`);
}

/**
 * The store a publishing community (or an existing copy) writes to. For
 * GitHub, `locator` of an existing copy wins over the community's current
 * archive so a republish lands in the same repo.
 */
export async function documentStoreFor(
  community: Pick<PublishingCommunity, "community_id" | "document_store" | "document_archive_repo_id" | "document_archive_full_name">,
  locator?: string,
): Promise<DocumentStore> {
  if (community.document_store === "ipfs") return ipfsStore();

  const fromLocator = locator ? parseGithubLocator(locator) : null;
  const repoId = fromLocator?.repoId
    ?? (community.document_archive_repo_id == null ? null : Number(community.document_archive_repo_id));
  if (repoId == null) {
    throw new Error(`community ${community.community_id} publishes to GitHub but has no archive repo`);
  }
  const accessible = await resolveCommunityRepo(community.community_id, repoId);
  return githubStore({
    repoId,
    fullName: accessible.fullName,
    installationId: accessible.installationId,
  });
}

export function isDocumentStoreName(value: unknown): value is DocumentStoreName {
  return typeof value === "string" && value in STORES;
}

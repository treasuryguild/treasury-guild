// Publishing frozen tally documents to the store a community chose
// (governance_community_settings.document_store, migration 0059), and
// keeping the copies alive: the reconcile sweep publishes every frozen
// document since the store was chosen that lacks a copy there, retries what
// failed last time, and periodically checks that existing copies still
// resolve, republishing from the database when one is gone. The database
// copy is the source; a copy is a replica the on-chain hash proves.
import "server-only";

import {
  listCopiesToCheck, listDocumentsToPublish, listPublishingCommunities, markCopyChecked, recordDocumentCopy,
} from "@/lib/db/governance";
import type { DocumentStoreName } from "@/lib/db/types";
import { documentStore, type DocumentStore } from "@/lib/storage";
import { parseTallyDocument } from "./tallyDocument";

/** How long a copy goes unchecked before the sweep looks again. */
export const COPY_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLISH_PER_COMMUNITY = 5;
const CHECKS_PER_RUN = 10;

export interface PublishSweepResult {
  published: number;
  republished: number;
  failed: number;
  checked: number;
}

/** The published file's name: what a person sees in the store, no title or wallet in it. */
export function documentFilename(document: string, proposalId: string): string {
  const doc = parseTallyDocument(document);
  return doc ? `${doc.body.community}-proposal-${doc.body.proposal.number}-tally.json` : `proposal-${proposalId}-tally.json`;
}

async function publishOne(
  store: DocumentStore, doc: { proposal_id: string; community_id: string; document: string; hash: string },
): Promise<void> {
  const locator = await store.put(
    new TextEncoder().encode(doc.document),
    documentFilename(doc.document, doc.proposal_id),
    { hash: doc.hash, proposal: doc.proposal_id },
  );
  await recordDocumentCopy({ proposal_id: doc.proposal_id, community_id: doc.community_id, store: store.name, locator });
}

export async function publishTallyDocuments(
  now: Date,
  stores: (name: DocumentStoreName) => DocumentStore = documentStore,
): Promise<PublishSweepResult> {
  const result: PublishSweepResult = { published: 0, republished: 0, failed: 0, checked: 0 };

  for (const community of await listPublishingCommunities()) {
    const store = stores(community.document_store);
    let due;
    try {
      due = await listDocumentsToPublish(community.community_id, community.document_store_since);
    } catch (err) {
      console.error(`list documents to publish for ${community.community_id} failed`, err);
      result.failed += 1;
      continue;
    }
    const missing = due.filter((doc) => !doc.proposal_document_copies.some((c) => c.store === store.name));
    for (const doc of missing.slice(0, PUBLISH_PER_COMMUNITY)) {
      try {
        await publishOne(store, doc);
        result.published += 1;
      } catch (err) {
        console.error(`publish tally document of proposal ${doc.proposal_id} to ${store.name} failed`, err);
        result.failed += 1;
      }
    }
  }

  // Copies not looked at for a week: still there, or gone and put back.
  const before = new Date(now.getTime() - COPY_CHECK_INTERVAL_MS).toISOString();
  for (const copy of await listCopiesToCheck(before, CHECKS_PER_RUN)) {
    const store = stores(copy.store);
    try {
      if (await store.resolves(copy.locator)) {
        await markCopyChecked(copy.id);
      } else {
        await publishOne(store, {
          proposal_id: copy.proposal_id, community_id: copy.community_id,
          document: copy.proposal_tally_documents.document, hash: hashOf(copy.proposal_tally_documents.document),
        });
        result.republished += 1;
      }
      result.checked += 1;
    } catch (err) {
      console.error(`check copy ${copy.id} in ${copy.store} failed`, err);
      result.failed += 1;
    }
  }
  return result;
}

function hashOf(document: string): string {
  return parseTallyDocument(document)?.hash ?? "";
}

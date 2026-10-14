// The registry of document stores by name (proposal_document_copies.store,
// governance_community_settings.document_store). Adding a store: one
// adapter file implementing DocumentStore, one entry here, and its name in
// the two check constraints of migration 0059's successor.
import "server-only";

import type { DocumentStoreName } from "@/lib/db/types";
import { ipfsStore } from "./ipfs";
import type { DocumentStore } from "./types";

export type { DocumentStore } from "./types";

const STORES: Record<DocumentStoreName, () => DocumentStore> = {
  ipfs: () => ipfsStore(),
};

export function documentStore(name: DocumentStoreName): DocumentStore {
  return STORES[name]();
}

export function isDocumentStoreName(value: unknown): value is DocumentStoreName {
  return typeof value === "string" && value in STORES;
}

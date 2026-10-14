// The hashes every ballot signs: what the proposal says and the rules it is
// decided by. sha256 over canonical JSON, so the same content always hashes
// the same whatever the key order it was built with.
import "server-only";

import { sha256Hex } from "@/lib/auth/crypto";
import type { ProposalKind } from "@/lib/constants";
import type { ProposalPayload } from "./payload";
import { canonicalJson, type ProposalRules } from "./rules";

export function proposalContentHash(content: {
  kind: ProposalKind;
  title: string;
  body: string;
  discussionUrl: string | null;
  payload: ProposalPayload;
}): string {
  return sha256Hex(canonicalJson(content));
}

export function proposalRulesHash(rules: ProposalRules): string {
  return sha256Hex(canonicalJson(rules));
}

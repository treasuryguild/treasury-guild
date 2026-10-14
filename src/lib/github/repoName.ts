// "owner/repo" helpers. Pure.

import { DomainError } from "@/lib/errors";

/** Split a GitHub full name into owner and repo; throws on malformed input. */
export function splitRepoFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new DomainError(`Invalid repository name: ${fullName}`);
  }
  return { owner, repo };
}

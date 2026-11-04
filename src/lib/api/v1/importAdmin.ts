// imports:write is an admin's permission. A lead or a signer holding the
// scope still cannot import: the pages are admin-only, and so are these.
import "server-only";

import type { ApiCaller } from "@/lib/api/caller";
import { Role } from "@/lib/constants";
import type { CommunityRow } from "@/lib/db/types";
import { ForbiddenError } from "@/lib/errors";
import { memberCommunity } from "./shared";

export async function requireImportAdmin(caller: ApiCaller, slug: string): Promise<CommunityRow> {
  const { community, role } = await memberCommunity(caller, slug);
  if (role !== Role.Owner && role !== Role.Admin) {
    throw new ForbiddenError("Only a community admin can import payment history or a funding schedule");
  }
  return community;
}

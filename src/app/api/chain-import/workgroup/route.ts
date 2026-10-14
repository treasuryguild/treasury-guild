// An admin settles a workgroup name an on-chain record uses: create the
// workgroup, or point the name at an existing one. The choice is kept as an
// alias, so later transactions with that name import on their own, and every
// held import that was waiting for the name is tried again at once.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { chainImportWorkgroupSchema } from "@/lib/api/schemas";
import type { ChainImportRunResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { importExternalTxs } from "@/lib/chainImport/run";
import { loadBlockedByWorkgroup, loadImportTreasury, upsertWorkgroupAlias } from "@/lib/db/chainImport";
import { createWorkgroupWithBoard, requireActiveWorkgroup, workgroupCommunityId } from "@/lib/db/workgroups";
import { BadRequestError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, name, action, workgroupId } = await parseJson(req, chainImportWorkgroupSchema);
  await requireAdmin(communityId, session.wallet);

  let target: string;
  if (action === "map") {
    target = workgroupId!;
    if ((await workgroupCommunityId(target)) !== communityId) {
      throw new BadRequestError("That workgroup is not in this community");
    }
    await requireActiveWorkgroup(target);
  } else {
    target = await createWorkgroupWithBoard(communityId, name);
  }
  // Also after a create: the on-chain name may be a truncated workgroup name.
  await upsertWorkgroupAlias(communityId, name, target, session.wallet);

  const waiting = await loadBlockedByWorkgroup(communityId, name);
  const byTreasury = new Map<string, string[]>();
  for (const row of waiting) byTreasury.set(row.treasury_id, [...(byTreasury.get(row.treasury_id) ?? []), row.tx_hash]);

  const result: ChainImportRunResponse = { imported: [], blocked: [] };
  for (const [treasuryId, hashes] of byTreasury) {
    const treasury = await loadImportTreasury(treasuryId);
    if (!treasury) continue;
    const run = await importExternalTxs(treasury, { hashes, limit: hashes.length });
    result.imported.push(...run.imported);
    result.blocked.push(...run.blocked);
  }
  return result;
});

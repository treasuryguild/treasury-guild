// An admin settles a workgroup name a history CSV uses: create the workgroup,
// or point the name at an existing one. Unlike the chain import, an archived
// workgroup is a valid target: history can belong to a wound-down workgroup.
// The choice is kept as an alias (shared with the chain import), so the next
// preview and later files match on their own.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { legacyWorkgroupSchema } from "@/lib/api/schemas";
import type { LegacyWorkgroupResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { upsertWorkgroupAlias } from "@/lib/db/chainImport";
import { createWorkgroupWithBoard, workgroupCommunityId } from "@/lib/db/workgroups";
import { BadRequestError } from "@/lib/errors";
import { normalizeWorkgroupName } from "@/lib/legacyHistory/parse";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, name, action, workgroupId, displayName } = await parseJson(req, legacyWorkgroupSchema);
  await requireAdmin(communityId, session.wallet);
  const key = normalizeWorkgroupName(name);
  if (key === "") throw new BadRequestError("Name the workgroup");

  let target: string;
  if (action === "map") {
    target = workgroupId!;
    if ((await workgroupCommunityId(target)) !== communityId) {
      throw new BadRequestError("That workgroup is not in this community");
    }
  } else {
    target = await createWorkgroupWithBoard(communityId, (displayName ?? name).trim());
  }
  await upsertWorkgroupAlias(communityId, key, target, session.wallet);
  return { workgroupId: target } satisfies LegacyWorkgroupResponse;
});

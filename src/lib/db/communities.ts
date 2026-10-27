import "server-only";

import { PgCode, Role } from "@/lib/constants";
import { ConflictError, InvariantError, NotFoundError } from "@/lib/errors";
import { check, maybe, serviceClient } from "./client";
import { COMMUNITY_COLUMNS, type CommunityRow } from "./types";

export async function communityById(
  communityId: string,
): Promise<CommunityRow | null> {
  return maybe<CommunityRow>(
    await serviceClient()
      .from("communities")
      .select(COMMUNITY_COLUMNS)
      .eq("id", communityId)
      .maybeSingle(),
    "load community",
  );
}

/** The community; 404 when it is gone. */
export async function requireCommunity(communityId: string): Promise<CommunityRow> {
  const community = await communityById(communityId);
  if (!community) throw new NotFoundError("Community not found");
  return community;
}

/** The community's slug; 404 when the community is gone. */
export async function communitySlug(communityId: string): Promise<string> {
  const row = maybe<{ slug: string }>(
    await serviceClient()
      .from("communities")
      .select("slug")
      .eq("id", communityId)
      .maybeSingle(),
    "load community slug",
  );
  if (!row) throw new NotFoundError("Community not found");
  return row.slug;
}

/** The community with this slug; 404 when there is none. */
export async function requireCommunityBySlug(slug: string): Promise<CommunityRow> {
  const community = maybe<CommunityRow>(
    await serviceClient()
      .from("communities")
      .select(COMMUNITY_COLUMNS)
      .eq("slug", slug)
      .maybeSingle(),
    "load community by slug",
  );
  if (!community) throw new NotFoundError("Community not found");
  return community;
}

/** A new community with its creator as owner; 409 when the slug is taken. */
export async function createCommunity(input: {
  slug: string;
  name: string;
  description: string | null;
  network: number;
  visibility: string;
  createdBy: string;
}): Promise<CommunityRow> {
  const db = serviceClient();
  const { data: community, error } = await db
    .from("communities")
    .insert({
      slug: input.slug,
      name: input.name,
      description: input.description,
      network: input.network,
      visibility: input.visibility,
      created_by: input.createdBy,
    })
    .select()
    .single();
  if (error) {
    if (error.code === PgCode.UniqueViolation) throw new ConflictError("Slug already taken");
    throw new InvariantError(`create community: ${error.message}`);
  }
  check(
    await db.from("community_members").insert({
      community_id: community.id,
      wallet_address: input.createdBy,
      role: Role.Owner,
    }),
    "add owner",
  );
  return community as CommunityRow;
}

/** Community settings: there is no client write policy, the route authorizes. */
export async function updateCommunity(communityId: string, patch: Record<string, unknown>): Promise<void> {
  check(
    await serviceClient().from("communities").update(patch).eq("id", communityId),
    "update community settings",
  );
}

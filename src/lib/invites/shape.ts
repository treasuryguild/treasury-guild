// Map DB invite rows to the admin API wire shape (client-safe).
import type { CommunityInviteInfo } from "@/lib/api/types";
import type { CommunityInviteSummary } from "@/lib/db/types";

export function inviteInfo(row: CommunityInviteSummary): CommunityInviteInfo {
  return {
    id: row.id,
    communityId: row.community_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    label: row.label,
  };
}

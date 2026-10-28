// Admin-only Integrations completeness for the hub, Overview checklist and
// feature notices. Null key skips the fetch (non-admins).
import { apiFetch } from "@/lib/api/client";
import type { IntegrationsStatusResponse } from "@/lib/api/types";
import { useAsyncData, type AsyncData } from "@/hooks/useAsyncData";

export function useIntegrationsStatus(
  communityId: string | null | undefined,
): AsyncData<IntegrationsStatusResponse> {
  return useAsyncData(communityId, async () =>
    apiFetch<IntegrationsStatusResponse>("/api/community/integrations-status", {
      query: { communityId: communityId! },
    }),
  );
}

"use client";

// Creating or importing a script that already belongs to an archived treasury
// restores that row instead of inserting a second one.
import { useRouter } from "next/navigation";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse } from "@/lib/api/types";
import { routes } from "@/lib/routes";
import { Button, ErrorText } from "@/components/ui";

export function RestoreArchivedTreasury({ slug, treasuryId }: { slug: string; treasuryId: string }) {
  const router = useRouter();
  const restore = useAsyncAction("Could not restore this treasury. Please try again.");

  return (
    <div className="space-y-2">
      <Button variant="secondary" loading={restore.busy} onClick={() => void restore.run(async () => {
        await apiFetch<OkResponse>("/api/treasury/lifecycle", { body: { treasuryId, action: "restore" } });
        router.push(routes.treasury(slug));
      })}>
        Restore this treasury
      </Button>
      <ErrorText error={restore.error} />
    </div>
  );
}

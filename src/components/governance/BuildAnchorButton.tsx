"use client";

// Build a dedicated anchor transaction from one of the community's
// treasuries and go to its signing page. Treasury actors only (admins, or
// base signers of the chosen treasury); with one treasury there is nothing
// to choose. A community with no treasury cannot anchor at all; a treasury
// locked until a date cannot anchor before it.
import { useState } from "react";
import type { BuildAnchorResponse } from "@/lib/api/types";
import { TxKind, type SpendingPath } from "@/lib/constants";
import type { TreasurySummary } from "@/lib/db/types";
import { actsForTreasury } from "@/lib/roles";
import { useBuildTx } from "@/hooks/useBuildTx";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { offeredPaths, PathPicker } from "@/components/tx/PathPicker";
import { Button, ErrorText, Select } from "@/components/ui";

export function BuildAnchorButton({ slug, communityId, treasuries, isAdmin, disabled = false }: {
  slug: string;
  communityId: string;
  treasuries: readonly TreasurySummary[];
  isAdmin: boolean;
  disabled?: boolean;
}) {
  const roles = useMyTreasuryRoles(communityId);
  const { build, busy, error } = useBuildTx(slug);
  const eligible = treasuries.filter((t) => actsForTreasury({ isAdmin, ...roles }, t.id));
  const [treasuryId, setTreasuryId] = useState("");
  const [path, setPath] = useState<SpendingPath | "">("");
  // Fixed at mount: a render must not read the clock.
  const [nowMs] = useState(() => Date.now());
  const chosen = eligible.length === 1 ? eligible[0]!.id : treasuryId;
  const treasury = eligible.find((t) => t.id === chosen) ?? null;
  const offered = treasury ? offeredPaths(treasury, TxKind.Anchor, nowMs) : { paths: [], blocked: null };
  const chosenPath = path && offered.paths.includes(path) ? path : offered.paths[0];

  if (treasuries.length === 0) {
    return <p className="text-sm text-zinc-500">Anchoring needs a treasury: the anchor is a transaction its signers sign.</p>;
  }
  if (eligible.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {eligible.length > 1 && (
          <Select value={chosen} onChange={(e) => setTreasuryId(e.target.value)} disabled={busy || disabled} aria-label="Treasury">
            <option value="">Choose a treasury</option>
            {eligible.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
        <Button variant="secondary" loading={busy} disabled={disabled || !chosen || !chosenPath}
          onClick={() => void build<BuildAnchorResponse>("/api/tx/build-anchor", { treasuryId: chosen, path: chosenPath })}>
          Build anchor transaction
        </Button>
        <ErrorText error={error} />
      </div>
      <PathPicker treasury={treasury} kind={TxKind.Anchor} value={chosenPath ?? ""} onChange={setPath} disabled={busy || disabled} nowMs={nowMs} />
    </div>
  );
}

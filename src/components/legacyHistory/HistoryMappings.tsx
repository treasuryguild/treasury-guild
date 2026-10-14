"use client";

// What a CSV names that could not be matched on its own: a ticker (pick
// among treasury tokens sharing it, or enter the token's unit) or a workgroup
// (create it, or point the name at an existing one, archived ones included).
import { useState } from "react";
import type { LegacyWorkgroupBody } from "@/lib/api/schemas";
import { shortUnit } from "@/lib/format";
import type { TickerResolution, WorkgroupResolution } from "@/lib/legacyHistory/types";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, Input, Select, WarningText } from "@/components/ui";

const UNIT_RE = /^[0-9a-f]{56,120}$/;

export function TickerResolver({
  resolution,
  busy,
  onChoose,
}: {
  resolution: Exclude<TickerResolution, { status: "resolved" }>;
  busy: boolean;
  onChoose: (unit: string) => void;
}) {
  const [unit, setUnit] = useState(resolution.status === "unknown" ? resolution.manualUnit ?? "" : "");
  const typed = unit.trim().toLowerCase();
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 p-3">
      <p className="text-sm">
        Token <span className="font-medium">{resolution.ticker}</span>
        {resolution.status === "ambiguous"
          ? ": several tokens in your treasuries use this ticker. Choose the one the old wallet paid."
          : ": no treasury token or earlier import uses this ticker. Enter its unit (policy id + asset name, hex)."}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {resolution.status === "ambiguous" ? (
          <Select aria-label={`Token for ${resolution.ticker}`} value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">Choose a token…</option>
            {resolution.candidates.map((c) => (
              <option key={c.unit} value={c.unit}>{c.ticker} · {shortUnit(c.unit)} · {c.decimals} decimals</option>
            ))}
          </Select>
        ) : (
          <Input aria-label={`Unit for ${resolution.ticker}`} value={unit} className="font-mono text-xs"
            spellCheck={false} placeholder="f43a62fd…41474958" onChange={(e) => setUnit(e.target.value)} />
        )}
        <Button variant="secondary" disabled={busy || !UNIT_RE.test(typed)} onClick={() => onChoose(typed)}>
          Use this token
        </Button>
      </div>
      {resolution.status === "unknown" && resolution.manualUnit && (
        <WarningText small>The chain has no token with the unit {shortUnit(resolution.manualUnit)}. Check it and try again.</WarningText>
      )}
    </div>
  );
}

export function WorkgroupResolver({
  resolution,
  workgroups,
  busy,
  onResolve,
}: {
  resolution: Exclude<WorkgroupResolution, { status: "resolved" }>;
  /** Every workgroup of the community, archived ones included. */
  workgroups: WorkgroupSummary[];
  busy: boolean;
  onResolve: (body: Omit<LegacyWorkgroupBody, "communityId">) => void;
}) {
  const options = resolution.status === "ambiguous"
    ? workgroups.filter((w) => resolution.candidates.some((c) => c.id === w.id))
    : workgroups;
  const [target, setTarget] = useState("");
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 p-3">
      <p className="text-sm">
        Workgroup <span className="font-medium">“{resolution.name}”</span>
        {resolution.status === "ambiguous"
          ? ": several workgroups have this name. Choose the one it means."
          : ": no workgroup has this name."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {resolution.status === "missing" && (
          <>
            <Button variant="secondary" disabled={busy}
              onClick={() => onResolve({ name: resolution.ref, action: "create", displayName: resolution.name })}>
              Create workgroup “{resolution.name}”
            </Button>
            <span className="text-xs text-zinc-500">or</span>
          </>
        )}
        <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-auto"
          aria-label={`Existing workgroup for ${resolution.name}`}>
          <option value="">Use an existing workgroup…</option>
          {options.map((w) => (
            <option key={w.id} value={w.id}>{w.name}{w.archived_at ? " (archived)" : ""}</option>
          ))}
        </Select>
        <Button variant="secondary" disabled={busy || !target}
          onClick={() => onResolve({ name: resolution.ref, action: "map", workgroupId: target })}>
          Use it
        </Button>
      </div>
    </div>
  );
}

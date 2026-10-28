// Service-role stamps for Discord anchor reminders (migration 0070): one row
// per (proposal, step, kind) keyed by due_since so a rejected-and-re-due step
// can alert again, while the same episode never reposts.
import "server-only";

import type { AnchorStep } from "@/lib/constants";
import type { AnchorAlertKind } from "@/lib/governance/anchorsDue";
import { check, rows, serviceClient } from "./client";

export interface AnchorAlertStamp {
  proposal_id: string;
  step: AnchorStep;
  kind: AnchorAlertKind;
  due_since: string;
  alerted_at: string;
}

export type AnchorAlertStampKey = {
  proposalId: string;
  step: AnchorStep;
  kind: AnchorAlertKind;
  dueSince: string;
};

/** Existing stamps for these proposals (empty input → empty). */
export async function loadAnchorAlertStamps(
  proposalIds: readonly string[],
): Promise<AnchorAlertStamp[]> {
  if (proposalIds.length === 0) return [];
  return rows<AnchorAlertStamp>(
    await serviceClient().from("proposal_anchor_alerts")
      .select("proposal_id, step, kind, due_since, alerted_at")
      .in("proposal_id", [...proposalIds]),
    "load anchor alert stamps",
  );
}

/**
 * Record that these alerts were posted (or skipped without posting). Upserts
 * so a new due_since episode overwrites the previous stamp.
 */
export async function stampAnchorAlerts(alerts: readonly AnchorAlertStampKey[]): Promise<void> {
  if (alerts.length === 0) return;
  const now = new Date().toISOString();
  check(
    await serviceClient().from("proposal_anchor_alerts").upsert(
      alerts.map((a) => ({
        proposal_id: a.proposalId,
        step: a.step,
        kind: a.kind,
        due_since: a.dueSince,
        alerted_at: now,
      })),
      { onConflict: "proposal_id,step,kind" },
    ),
    "stamp anchor alerts",
  );
}

/** Whether a candidate still needs a post: no stamp, or a different due_since. */
export function needsAnchorAlert(
  stamps: readonly AnchorAlertStamp[],
  candidate: AnchorAlertStampKey,
): boolean {
  const existing = stamps.find(
    (s) => s.proposal_id === candidate.proposalId && s.step === candidate.step && s.kind === candidate.kind,
  );
  if (!existing) return true;
  return Date.parse(existing.due_since) !== Date.parse(candidate.dueSince);
}

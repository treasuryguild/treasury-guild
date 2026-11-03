// Pure season scoring from recognition events. Client-safe.

import { RecognitionKind } from "@/lib/constants";

export interface ScoreEvent {
  kind: string;
  subject_wallet: string;
  actor_wallet: string;
  weight: number | string;
  created_at: string;
  revoked_at: string | null;
}

export const RecognitionTier = {
  None: "none",
  Noted: "noted",
  Craft: "craft",
  Exemplar: "exemplar",
} as const;
export type RecognitionTier = (typeof RecognitionTier)[keyof typeof RecognitionTier];

/** Points per active event kind (weight multiplies). */
export const KIND_SCORE: Record<string, number> = {
  [RecognitionKind.Endorsement]: 3,
  [RecognitionKind.PeerKudos]: 0.25,
  [RecognitionKind.Steward]: 1,
  [RecognitionKind.SeasonAward]: 0,
};

/**
 * Ignore peer kudos from A→B when B→A also exists within this many ms
 * (anti-circle). Endorsements are never dampened.
 */
export const RECIPROCAL_KUDOS_MS = 7 * 24 * 60 * 60 * 1000;

export function tierForScore(score: number): RecognitionTier {
  if (score >= 6) return RecognitionTier.Exemplar;
  if (score >= 3) return RecognitionTier.Craft;
  if (score >= 1) return RecognitionTier.Noted;
  return RecognitionTier.None;
}

export const TIER_LABELS: Record<RecognitionTier, string> = {
  [RecognitionTier.None]: "—",
  [RecognitionTier.Noted]: "Noted",
  [RecognitionTier.Craft]: "Craft",
  [RecognitionTier.Exemplar]: "Exemplar",
};

function eventPoints(kind: string, weight: number | string): number {
  const base = KIND_SCORE[kind] ?? 0;
  return base * Number(weight);
}

/**
 * Season score per subject wallet from active events. Peer kudos that are
 * reciprocated inside RECIPROCAL_KUDOS_MS contribute 0.
 */
export function seasonScores(events: readonly ScoreEvent[]): Map<string, number> {
  const active = events.filter((e) => e.revoked_at == null);
  const reciprocal = new Set<string>();
  for (const a of active) {
    if (a.kind !== RecognitionKind.PeerKudos) continue;
    const aAt = Date.parse(a.created_at);
    for (const b of active) {
      if (b.kind !== RecognitionKind.PeerKudos) continue;
      if (b.actor_wallet !== a.subject_wallet || b.subject_wallet !== a.actor_wallet) continue;
      if (Math.abs(Date.parse(b.created_at) - aAt) <= RECIPROCAL_KUDOS_MS) {
        reciprocal.add(`${a.actor_wallet}\0${a.subject_wallet}\0${a.created_at}`);
        reciprocal.add(`${b.actor_wallet}\0${b.subject_wallet}\0${b.created_at}`);
      }
    }
  }

  const scores = new Map<string, number>();
  for (const e of active) {
    if (
      e.kind === RecognitionKind.PeerKudos
      && reciprocal.has(`${e.actor_wallet}\0${e.subject_wallet}\0${e.created_at}`)
    ) {
      continue;
    }
    const pts = eventPoints(e.kind, e.weight);
    if (pts === 0) continue;
    scores.set(e.subject_wallet, (scores.get(e.subject_wallet) ?? 0) + pts);
  }
  return scores;
}

export function scoreForWallet(events: readonly ScoreEvent[], wallet: string): number {
  return seasonScores(events).get(wallet) ?? 0;
}

// Recognition module settings: defaults when the row is missing (off),
// presets, and row ↔ app mapping. Client-safe.

import type { RecognitionSettingsRow } from "@/lib/db/types";

export const RecognitionSeason = {
  Month: "month",
  Quarter: "quarter",
} as const;
export type RecognitionSeason = (typeof RecognitionSeason)[keyof typeof RecognitionSeason];

/** App-facing recognition settings (camelCase). */
export interface RecognitionSettings {
  enabled: boolean;
  season: RecognitionSeason;
  maxEndorsementsPerActorSeason: number;
  showLeaderboard: boolean;
  peerKudosEnabled: boolean;
  minMemberDaysToKudos: number;
  electorateEndorsed: boolean;
  /** Minimum season score to sit in the endorsed electorate (3 per endorsement). */
  endorsedMinScore: number;
}

export const DEFAULT_RECOGNITION_SETTINGS: RecognitionSettings = {
  enabled: false,
  season: RecognitionSeason.Quarter,
  maxEndorsementsPerActorSeason: 10,
  showLeaderboard: false,
  peerKudosEnabled: false,
  minMemberDaysToKudos: 30,
  electorateEndorsed: false,
  endorsedMinScore: 3,
};

export const RecognitionPreset = {
  Quiet: "quiet",
  Standard: "standard",
  Loud: "loud",
} as const;
export type RecognitionPreset = (typeof RecognitionPreset)[keyof typeof RecognitionPreset];

/** Quiet / Standard / Loud blobs admins can apply before saving. */
export const RECOGNITION_PRESETS: Record<RecognitionPreset, Partial<RecognitionSettings>> = {
  [RecognitionPreset.Quiet]: {
    season: RecognitionSeason.Quarter,
    maxEndorsementsPerActorSeason: 5,
    showLeaderboard: false,
    peerKudosEnabled: false,
  },
  [RecognitionPreset.Standard]: {
    season: RecognitionSeason.Quarter,
    maxEndorsementsPerActorSeason: 10,
    showLeaderboard: false,
    peerKudosEnabled: false,
  },
  [RecognitionPreset.Loud]: {
    season: RecognitionSeason.Month,
    maxEndorsementsPerActorSeason: 20,
    showLeaderboard: true,
    peerKudosEnabled: true,
  },
};

export function recognitionSettingsFromRow(
  row: RecognitionSettingsRow | null | undefined,
): RecognitionSettings {
  if (!row) return DEFAULT_RECOGNITION_SETTINGS;
  return {
    enabled: row.enabled,
    season: row.season,
    maxEndorsementsPerActorSeason: row.max_endorsements_per_actor_season,
    showLeaderboard: row.show_leaderboard,
    peerKudosEnabled: row.peer_kudos_enabled,
    minMemberDaysToKudos: row.min_member_days_to_kudos,
    electorateEndorsed: row.electorate_endorsed,
    endorsedMinScore: Number(row.endorsed_min_score),
  };
}

/** Snake_case JSON for save_recognition_settings. */
export function recognitionSettingsToRow(settings: RecognitionSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    season: settings.season,
    max_endorsements_per_actor_season: settings.maxEndorsementsPerActorSeason,
    show_leaderboard: settings.showLeaderboard,
    peer_kudos_enabled: settings.peerKudosEnabled,
    min_member_days_to_kudos: settings.minMemberDaysToKudos,
    electorate_endorsed: settings.electorateEndorsed,
    endorsed_min_score: settings.endorsedMinScore,
  };
}

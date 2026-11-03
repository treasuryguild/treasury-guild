// Season keys for recognition events ("YYYY-MM" or "YYYY-Qn"). Client-safe.

import { monthOf, quarterCode } from "@/lib/budgets";
import { RecognitionSeason } from "./settings";

/** Season key for `at` under the community's cadence. */
export function recognitionSeasonKey(
  season: RecognitionSeason,
  at: Date | string = new Date(),
): string {
  const month = monthOf(at);
  return season === RecognitionSeason.Quarter ? quarterCode(month) : month;
}

/** Previous season key (one month or one quarter earlier). */
export function previousRecognitionSeasonKey(
  season: RecognitionSeason,
  at: Date | string = new Date(),
): string {
  const d = typeof at === "string" ? new Date(at) : new Date(at.getTime());
  if (season === RecognitionSeason.Quarter) {
    d.setUTCMonth(d.getUTCMonth() - 3);
  } else {
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return recognitionSeasonKey(season, d);
}

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECOGNITION_SETTINGS,
  RECOGNITION_PRESETS,
  RecognitionPreset,
  recognitionSettingsFromRow,
  recognitionSettingsToRow,
} from "./settings";

describe("recognitionSettingsFromRow", () => {
  it("returns defaults when the row is missing", () => {
    expect(recognitionSettingsFromRow(null)).toEqual(DEFAULT_RECOGNITION_SETTINGS);
    expect(recognitionSettingsFromRow(undefined).enabled).toBe(false);
  });

  it("round-trips through toRow", () => {
    const on = { ...DEFAULT_RECOGNITION_SETTINGS, enabled: true, ...RECOGNITION_PRESETS[RecognitionPreset.Loud] };
    const row = recognitionSettingsToRow(on);
    expect(row.enabled).toBe(true);
    expect(row.season).toBe("month");
    expect(row.max_endorsements_per_actor_season).toBe(20);
  });
});

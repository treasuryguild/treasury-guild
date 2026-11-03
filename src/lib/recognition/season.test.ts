import { describe, expect, it } from "vitest";
import { RecognitionSeason } from "./settings";
import { previousRecognitionSeasonKey, recognitionSeasonKey } from "./season";

describe("recognitionSeasonKey", () => {
  it("uses YYYY-MM for month cadence", () => {
    expect(recognitionSeasonKey(RecognitionSeason.Month, "2026-05-20T00:00:00Z")).toBe("2026-05");
  });

  it("uses YYYY-Qn for quarter cadence", () => {
    expect(recognitionSeasonKey(RecognitionSeason.Quarter, "2026-05-20T00:00:00Z")).toBe("2026-Q2");
  });
});

describe("previousRecognitionSeasonKey", () => {
  it("steps back one month or quarter", () => {
    expect(previousRecognitionSeasonKey(RecognitionSeason.Month, "2026-05-20T00:00:00Z")).toBe("2026-04");
    expect(previousRecognitionSeasonKey(RecognitionSeason.Quarter, "2026-05-20T00:00:00Z")).toBe("2026-Q1");
  });
});

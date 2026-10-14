import { describe, expect, it } from "vitest";
import {
  CHECKIN_CODE_LENGTH, checkinCodeMatches, checkinWindow, generateCheckinCode, normalizeCheckinCode,
} from "./checkinCode";

describe("check-in code", () => {
  it("generates unambiguous codes", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCheckinCode()).toMatch(new RegExp(`^[A-HJKMNP-Z2-9]{${CHECKIN_CODE_LENGTH}}$`));
    }
  });

  it("compares as typed", () => {
    expect(normalizeCheckinCode(" abc-234 ")).toBe("ABC234");
    expect(checkinCodeMatches("abc 234", "ABC234")).toBe(true);
    expect(checkinCodeMatches("ABC235", "ABC234")).toBe(false);
    expect(checkinCodeMatches("ABC2345", "ABC234")).toBe(false);
    expect(checkinCodeMatches("", "ABC234")).toBe(false);
  });
});

describe("checkinWindow", () => {
  const call = { starts_at: "2026-09-01T17:00:00Z", ends_at: "2026-09-01T18:00:00Z" };
  const at = (iso: string) => Date.parse(iso);

  it("opens 15 minutes early and closes with the call", () => {
    expect(checkinWindow(call, at("2026-09-01T16:44:59Z"))).toBe("early");
    expect(checkinWindow(call, at("2026-09-01T16:45:00Z"))).toBe("open");
    expect(checkinWindow(call, at("2026-09-01T18:00:00Z"))).toBe("open");
    expect(checkinWindow(call, at("2026-09-01T18:00:01Z"))).toBe("closed");
  });
});

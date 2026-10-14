import { describe, expect, it } from "vitest";
import { isMeetingRef, parseMeetingRef } from "./meetingRef";

describe("meeting references", () => {
  it("normalises a typed Zoom meeting id", () => {
    expect(parseMeetingRef("zoom", "812 3456 7890")).toBe("81234567890");
    expect(parseMeetingRef("zoom", "812-345-678")).toBe("812345678");
    expect(parseMeetingRef("zoom", "1234")).toBeNull();
    expect(parseMeetingRef("zoom", "812 3456 789x")).toBeNull();
  });

  it("reads a Meet code from a link or the bare code", () => {
    expect(parseMeetingRef("meet", "https://meet.google.com/abc-mnop-xyz")).toBe("abc-mnop-xyz");
    expect(parseMeetingRef("meet", "ABCMNOPXYZ")).toBe("abc-mnop-xyz");
    expect(parseMeetingRef("meet", "abc-mnop")).toBeNull();
  });

  it("checks stored references by platform", () => {
    expect(isMeetingRef("zoom", "81234567890")).toBe(true);
    expect(isMeetingRef("zoom", "abc-mnop-xyz")).toBe(false);
    expect(isMeetingRef("meet", "abc-mnop-xyz")).toBe(true);
    expect(isMeetingRef("meet", "81234567890")).toBe(false);
  });
});

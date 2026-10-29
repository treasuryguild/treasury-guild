import { describe, expect, it } from "vitest";
import { attendeeStanding, attendeesToFinalize, countStandings, meetsThreshold } from "./qualify";

const call = { min_snapshots: 2, min_minutes: 30 };
const base = {
  provider: "manual", status: "auto", snapshots_seen: 0, minutes: 0, wallet_address: "addr1", task_id: null,
} as const;

describe("call attendance threshold", () => {
  it("takes a manager's entry as proof of presence; a check-in needs confirm", () => {
    expect(meetsThreshold(call, base)).toBe(true);
    expect(meetsThreshold(call, { ...base, provider: "checkin" })).toBe(false);
    expect(meetsThreshold(call, { ...base, provider: "checkin", status: "confirmed" })).toBe(true);
  });

  it("holds captured attendees to the call's threshold", () => {
    expect(meetsThreshold(call, { ...base, provider: "discord", snapshots_seen: 1 })).toBe(false);
    expect(meetsThreshold(call, { ...base, provider: "discord", snapshots_seen: 2 })).toBe(true);
    expect(meetsThreshold(call, { ...base, provider: "zoom", minutes: 29 })).toBe(false);
    expect(meetsThreshold(call, { ...base, provider: "meet", minutes: 30 })).toBe(true);
  });

  it("lets a manager override in both directions", () => {
    expect(meetsThreshold(call, { ...base, provider: "discord", status: "confirmed" })).toBe(true);
    expect(meetsThreshold(call, { ...base, status: "excluded" })).toBe(false);
  });

  it("names each attendee's standing", () => {
    expect(attendeeStanding(call, base)).toBe("ready");
    expect(attendeeStanding(call, { ...base, wallet_address: null })).toBe("unlinked");
    expect(attendeeStanding(call, { ...base, provider: "zoom" })).toBe("below-threshold");
    expect(attendeeStanding(call, { ...base, status: "excluded" })).toBe("excluded");
    // A task wins over everything: the reward is already on its way.
    expect(attendeeStanding(call, { ...base, status: "excluded", task_id: "t1" })).toBe("rewarded");
  });

  it("finalizes only the ready ones", () => {
    const list = [
      { ...base, id: "a" },
      { ...base, id: "b", wallet_address: null },
      { ...base, id: "c", task_id: "t1" },
      { ...base, id: "d", provider: "discord" as const, snapshots_seen: 5 },
    ];
    expect(attendeesToFinalize(call, list).map((a) => a.id)).toEqual(["a", "d"]);
    expect(countStandings(call, list)).toEqual({
      ready: 2, unlinked: 1, rewarded: 1, excluded: 0, "below-threshold": 0,
    });
  });
});

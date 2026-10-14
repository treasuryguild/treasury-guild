import { describe, expect, it } from "vitest";
import {
  groupDetectedMeetings, iso, normalizeMeetingId, sessionFromWebhook, sessionsFromReport, type PendingMeetingEvent,
} from "./zoomSessions";

const names = {
  aliases: new Map([["al", "addr_alice"]]),
  members: [{ wallet: "addr_bob", handle: "Bob", githubUsername: null }],
};

describe("sessionFromWebhook", () => {
  it("keys a signed-in participant by Zoom user id and a guest by name", () => {
    expect(sessionFromWebhook("meeting.participant_joined", {
      user_name: "Al", id: "zoomUser1", participant_uuid: "stay-1", join_time: "2026-09-01T17:00:05Z",
    }, names)).toEqual({
      key: "zoomUser1", name: "Al", wallet: "addr_alice",
      joined: "2026-09-01T17:00:05.000Z", left: null, source: "zoom:wh:stay-1:2026-09-01T17:00:05.000Z",
    });
    expect(sessionFromWebhook("meeting.participant_joined", {
      user_name: "  BOB (Guest) ", id: "", user_id: "16778240", join_time: "2026-09-01T17:01:00Z",
    }, names)).toMatchObject({ key: "name:bob", wallet: "addr_bob", source: "zoom:wh:16778240:2026-09-01T17:01:00.000Z" });
  });

  it("turns a leave into a leave-only session under the same key", () => {
    expect(sessionFromWebhook("meeting.participant_left", {
      user_name: "Bob", leave_time: "2026-09-01T17:30:00Z",
    }, names)).toEqual({
      key: "name:bob", name: "Bob", wallet: "addr_bob", joined: null, left: "2026-09-01T17:30:00.000Z", source: null,
    });
  });

  it("ignores events that name nobody or carry no usable time", () => {
    expect(sessionFromWebhook("meeting.participant_joined", { user_name: "  ", join_time: "2026-09-01T17:00:00Z" }, names)).toBeNull();
    expect(sessionFromWebhook("meeting.participant_joined", { user_name: "Zed" }, names)).toBeNull();
    expect(sessionFromWebhook("meeting.participant_left", { user_name: "Zed", leave_time: "not a date" }, names)).toBeNull();
  });
});

describe("sessionsFromReport", () => {
  it("makes one session per stay, the same person under one key", () => {
    const sessions = sessionsFromReport([
      { id: "", name: "Zed", join_time: "2026-09-01T17:00:00Z", leave_time: "2026-09-01T17:10:00Z" },
      { id: "", name: "zed", join_time: "2026-09-01T17:20:00Z", leave_time: "2026-09-01T17:50:00Z" },
      { id: "zoomUser1", name: "Al", join_time: "2026-09-01T17:00:00Z" },
      { id: "", name: "", join_time: "2026-09-01T17:00:00Z" },
      { id: "", name: "No join" },
    ], names);
    expect(sessions.map((s) => [s.key, s.source, s.left])).toEqual([
      ["name:zed", "zoom:rp:name:zed:2026-09-01T17:00:00.000Z", "2026-09-01T17:10:00.000Z"],
      ["name:zed", "zoom:rp:name:zed:2026-09-01T17:20:00.000Z", "2026-09-01T17:50:00.000Z"],
      ["zoomUser1", "zoom:rp:zoomUser1:2026-09-01T17:00:00.000Z", null],
    ]);
    expect(sessions[0]?.wallet).toBeNull();
    expect(sessions[2]?.wallet).toBe("addr_alice");
  });
});

describe("normalizeMeetingId", () => {
  it("drops the spaces and dashes people paste", () => {
    expect(normalizeMeetingId(" 812 3456-7890 ")).toBe("81234567890");
  });
});

describe("groupDetectedMeetings", () => {
  const event = (over: Partial<PendingMeetingEvent>): PendingMeetingEvent => ({
    meetingRef: "81234567890", instance: "uuid-1", topic: null, key: "name:ann", joined: null, left: null, ...over,
  });

  it("groups by occurrence, counts people once and knows when the meeting ended", () => {
    const meetings = groupDetectedMeetings([
      event({ joined: "2026-09-21T06:00:00.000Z", topic: "Town hall" }),
      event({ key: "name:bob", joined: "2026-09-21T06:05:00.000Z" }),
      event({ left: "2026-09-21T06:30:00.000Z" }),
      event({ key: "name:bob", left: "2026-09-21T06:40:00.000Z" }),
      event({ instance: "uuid-2", joined: "2026-09-22T06:00:00.000Z" }),
    ]);
    expect(meetings).toEqual([
      { meetingRef: "81234567890", instance: "uuid-2", topic: null, startedAt: "2026-09-22T06:00:00.000Z", endedAt: null, participants: 1 },
      { meetingRef: "81234567890", instance: "uuid-1", topic: "Town hall", startedAt: "2026-09-21T06:00:00.000Z", endedAt: "2026-09-21T06:40:00.000Z", participants: 2 },
    ]);
  });

  it("is still running after someone rejoins", () => {
    const [meeting] = groupDetectedMeetings([
      event({ joined: "2026-09-21T06:00:00.000Z" }),
      event({ left: "2026-09-21T06:10:00.000Z" }),
      event({ joined: "2026-09-21T06:12:00.000Z" }),
    ]);
    expect(meeting?.endedAt).toBeNull();
    expect(meeting?.participants).toBe(1);
  });
});

describe("iso", () => {
  it("normalises a provider timestamp to canonical UTC ISO with milliseconds", () => {
    expect(iso("2026-09-01T17:00:05Z")).toBe("2026-09-01T17:00:05.000Z");
    expect(iso("2026-09-01T17:00:05.250Z")).toBe("2026-09-01T17:00:05.250Z");
    expect(iso("2026-09-01T19:00:05+02:00")).toBe("2026-09-01T17:00:05.000Z");
    expect(iso("2026-09-01T12:00:05-05:00")).toBe("2026-09-01T17:00:05.000Z");
    // A date alone is UTC midnight.
    expect(iso("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("is null when the value is absent or unreadable", () => {
    expect(iso(undefined)).toBeNull();
    expect(iso("")).toBeNull();
    expect(iso("soon")).toBeNull();
    expect(iso("2026-13-01T00:00:00Z")).toBeNull();
    expect(iso("2026-09-01T25:00:00Z")).toBeNull();
  });

  it("gives two spellings of one instant the same string, so session keys built from it agree", () => {
    expect(iso("2026-09-01T17:00:05Z")).toBe(iso("2026-09-01T17:00:05.000+00:00"));
    const joined = sessionFromWebhook("meeting.participant_joined", {
      user_name: "Al", id: "zoomUser1", participant_uuid: "stay-1", join_time: "2026-09-01T19:00:05+02:00",
    }, names);
    expect(joined?.joined).toBe(iso("2026-09-01T17:00:05Z"));
    expect(joined?.source).toBe(`zoom:wh:stay-1:${iso("2026-09-01T17:00:05Z")}`);
  });

  it("is idempotent", () => {
    const once = iso("2026-09-01T19:00:05+02:00")!;
    expect(iso(once)).toBe(once);
  });
});

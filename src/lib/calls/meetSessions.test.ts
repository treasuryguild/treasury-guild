import { describe, expect, it } from "vitest";
import {
  followedEnd, linkedOccurrence, meetAccountId, normalizeMeetCode, pickConferenceRecord, sessionsFromMeetParticipant,
} from "./meetSessions";

const ctx = {
  names: { aliases: new Map([["bea", "addr_bea"]]), members: [] },
  walletsByAccount: new Map([["1089", "addr_alice"]]),
};
const P = "conferenceRecords/r1/participants/p1";

describe("sessionsFromMeetParticipant", () => {
  it("recognises a signed-in participant by their linked Google account", () => {
    const sessions = sessionsFromMeetParticipant(
      { name: P, signedinUser: { user: "users/1089", displayName: "Alice A." } },
      [
        { name: `${P}/participantSessions/s1`, startTime: "2026-09-01T17:00:00Z", endTime: "2026-09-01T17:20:00Z" },
        { name: `${P}/participantSessions/s2`, startTime: "2026-09-01T17:30:00Z" },
      ],
      ctx,
    );
    expect(sessions).toEqual([
      { key: "1089", name: "Alice A.", wallet: "addr_alice", joined: "2026-09-01T17:00:00.000Z",
        left: "2026-09-01T17:20:00.000Z", source: `meet:${P}/participantSessions/s1` },
      { key: "1089", name: "Alice A.", wallet: "addr_alice", joined: "2026-09-01T17:30:00.000Z",
        left: null, source: `meet:${P}/participantSessions/s2` },
    ]);
  });

  it("keys guests by name and only suggests a wallet for them", () => {
    const [guest] = sessionsFromMeetParticipant(
      { name: P, anonymousUser: { displayName: " Bea " } },
      [{ name: `${P}/participantSessions/s1`, startTime: "2026-09-01T17:00:00Z" }],
      ctx,
    );
    expect(guest).toMatchObject({ key: "name:bea", name: "Bea", wallet: "addr_bea" });
    // Signed in but not linked: no wallet, even though the account id is known.
    const [unlinked] = sessionsFromMeetParticipant(
      { name: P, signedinUser: { user: "users/555", displayName: "Zed" } },
      [{ name: `${P}/participantSessions/s1`, startTime: "2026-09-01T17:00:00Z" }],
      ctx,
    );
    expect(unlinked).toMatchObject({ key: "555", wallet: null });
  });

  it("falls back to the first-to-last span when the stays could not be read", () => {
    expect(sessionsFromMeetParticipant(
      { name: P, phoneUser: { displayName: "Caller" }, earliestStartTime: "2026-09-01T17:05:00Z", latestEndTime: "2026-09-01T17:55:00Z" },
      null,
      ctx,
    )).toEqual([{ key: "name:caller", name: "Caller", wallet: null, joined: "2026-09-01T17:05:00.000Z",
      left: "2026-09-01T17:55:00.000Z", source: `meet:${P}:span` }]);
  });

  it("drops participants with no name and no account, or no start", () => {
    expect(sessionsFromMeetParticipant({ name: P, anonymousUser: { displayName: " " } }, null, ctx)).toEqual([]);
    expect(sessionsFromMeetParticipant({ name: P, anonymousUser: { displayName: "Dan" } }, [{ name: "s" }], ctx)).toEqual([]);
    expect(meetAccountId({ name: P, signedinUser: { user: "people/1" } })).toBeNull();
  });
});

describe("pickConferenceRecord", () => {
  const call = { starts_at: "2026-09-08T17:00:00Z", ends_at: "2026-09-08T18:00:00Z" };
  const rec = (name: string, startTime: string, endTime?: string) => ({ name, startTime, endTime });

  it("takes this week's occurrence of a reused code, even when opened early or still running", () => {
    const records = [
      rec("last-week", "2026-09-01T17:00:00Z", "2026-09-01T18:00:00Z"),
      rec("this-week", "2026-09-08T16:50:00Z"),
      rec("later-today", "2026-09-08T20:00:00Z", "2026-09-08T20:30:00Z"),
    ];
    expect(pickConferenceRecord(records, call)?.name).toBe("this-week");
  });

  it("prefers the latest start among overlapping records and ignores ones over before the call", () => {
    const records = [
      rec("test-run", "2026-09-08T16:10:00Z", "2026-09-08T16:20:00Z"),
      rec("first", "2026-09-08T16:55:00Z", "2026-09-08T17:10:00Z"),
      rec("restart", "2026-09-08T17:12:00Z", "2026-09-08T18:05:00Z"),
    ];
    expect(pickConferenceRecord(records, call)?.name).toBe("restart");
    expect(pickConferenceRecord([records[0]!], call)).toBeNull();
    expect(pickConferenceRecord([], call)).toBeNull();
  });
});

describe("linkedOccurrence", () => {
  const link = { created_at: "2026-09-01T00:00:00Z", duration_minutes: 60 };
  const R = "conferenceRecords/r1";

  it("turns a running conference into a call of the usual length", () => {
    expect(linkedOccurrence({ name: R, startTime: "2026-09-08T17:00:00Z" }, link, new Date("2026-09-08T17:04:00Z")))
      .toEqual({ instance: R, startsAt: "2026-09-08T17:00:00.000Z", endsAt: "2026-09-08T18:00:00.000Z" });
  });

  it("keeps a conference found late, or running since before the link, open a little longer", () => {
    expect(linkedOccurrence({ name: R, startTime: "2026-09-08T17:00:00Z" }, link, new Date("2026-09-08T18:30:00Z"))?.endsAt)
      .toBe("2026-09-08T18:35:00.000Z");
    expect(linkedOccurrence({ name: R, startTime: "2026-08-31T23:50:00Z" }, link, new Date("2026-09-01T00:10:00Z"))?.endsAt)
      .toBe("2026-09-01T00:50:00.000Z");
  });

  it("still catches a short meeting that ended between two runs", () => {
    const record = { name: R, startTime: "2026-09-08T17:00:00Z", endTime: "2026-09-08T17:03:00Z" };
    expect(linkedOccurrence(record, link, new Date("2026-09-08T17:05:00Z")))
      .toEqual({ instance: R, startsAt: "2026-09-08T17:00:00.000Z", endsAt: "2026-09-08T17:03:00.000Z" });
  });

  it("leaves alone what ended long ago, began before the link, or has no usable times", () => {
    const ended = { name: R, startTime: "2026-09-08T17:00:00Z", endTime: "2026-09-08T18:00:00Z" };
    expect(linkedOccurrence(ended, link, new Date("2026-09-08T19:01:00Z"))).toBeNull();
    expect(linkedOccurrence(ended, { ...link, created_at: "2026-09-08T17:30:00Z" }, new Date("2026-09-08T18:05:00Z"))).toBeNull();
    expect(linkedOccurrence({ name: R }, link, new Date("2026-09-08T17:00:00Z"))).toBeNull();
    expect(linkedOccurrence({ name: R, startTime: "2026-09-08T17:00:00Z", endTime: "2026-09-08T17:00:00Z" }, link, new Date("2026-09-08T17:01:00Z"))).toBeNull();
  });
});

describe("followedEnd", () => {
  const call = { starts_at: "2026-09-08T17:00:00Z", ends_at: "2026-09-08T18:00:00Z" };
  const running = { name: "conferenceRecords/r1", startTime: "2026-09-08T17:00:00Z" };

  it("takes Google's end once the conference is over, once", () => {
    expect(followedEnd({ ...running, endTime: "2026-09-08T17:42:10Z" }, call, new Date("2026-09-08T17:45:00Z")))
      .toBe("2026-09-08T17:42:10.000Z");
    expect(followedEnd({ ...running, endTime: "2026-09-08T18:00:00Z" }, call, new Date("2026-09-08T18:20:00Z"))).toBeNull();
    // Never before the start (calls check: ends_at > starts_at).
    expect(followedEnd({ ...running, endTime: "2026-09-08T16:59:00Z" }, call, new Date("2026-09-08T18:20:00Z"))).toBeNull();
  });

  it("moves the end ahead of a conference that runs on", () => {
    expect(followedEnd(running, call, new Date("2026-09-08T17:30:00Z"))).toBeNull();
    expect(followedEnd(running, call, new Date("2026-09-08T17:55:00Z"))).toBe("2026-09-08T18:05:00.000Z");
    expect(followedEnd(running, call, new Date("2026-09-08T18:20:00Z"))).toBe("2026-09-08T18:30:00.000Z");
  });
});

describe("normalizeMeetCode", () => {
  it("reads a code or a link, with or without dashes", () => {
    expect(normalizeMeetCode("abc-mnop-xyz")).toBe("abc-mnop-xyz");
    expect(normalizeMeetCode(" ABCMNOPXYZ ")).toBe("abc-mnop-xyz");
    expect(normalizeMeetCode("https://meet.google.com/abc-mnop-xyz?authuser=0")).toBe("abc-mnop-xyz");
  });

  it("refuses anything else", () => {
    expect(normalizeMeetCode("81234567890")).toBeNull();
    expect(normalizeMeetCode("abc-mnop")).toBeNull();
    expect(normalizeMeetCode("https://zoom.us/j/81234567890")).toBeNull();
  });
});

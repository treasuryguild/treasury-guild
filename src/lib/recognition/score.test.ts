import { describe, expect, it } from "vitest";
import { RecognitionKind } from "@/lib/constants";
import {
  RecognitionTier,
  scoreForWallet,
  seasonScores,
  tierForScore,
  type ScoreEvent,
} from "./score";

function ev(partial: Partial<ScoreEvent> & Pick<ScoreEvent, "kind" | "subject_wallet" | "actor_wallet">): ScoreEvent {
  return {
    weight: 1,
    created_at: "2026-01-15T12:00:00Z",
    revoked_at: null,
    ...partial,
  };
}

describe("tierForScore", () => {
  it("maps score bands", () => {
    expect(tierForScore(0)).toBe(RecognitionTier.None);
    expect(tierForScore(1)).toBe(RecognitionTier.Noted);
    expect(tierForScore(3)).toBe(RecognitionTier.Craft);
    expect(tierForScore(6)).toBe(RecognitionTier.Exemplar);
  });
});

describe("seasonScores", () => {
  it("scores endorsements at 3 and ignores revoked", () => {
    const events = [
      ev({ kind: RecognitionKind.Endorsement, subject_wallet: "alice", actor_wallet: "lead" }),
      ev({
        kind: RecognitionKind.Endorsement,
        subject_wallet: "alice",
        actor_wallet: "admin",
        revoked_at: "2026-01-16T00:00:00Z",
      }),
      ev({ kind: RecognitionKind.Endorsement, subject_wallet: "bob", actor_wallet: "lead" }),
    ];
    expect(scoreForWallet(events, "alice")).toBe(3);
    expect(scoreForWallet(events, "bob")).toBe(3);
    expect(seasonScores(events).size).toBe(2);
  });

  it("counts peer kudos at 0.25 and dampens reciprocals", () => {
    const events = [
      ev({
        kind: RecognitionKind.PeerKudos,
        subject_wallet: "alice",
        actor_wallet: "bob",
        created_at: "2026-01-15T12:00:00Z",
      }),
      ev({
        kind: RecognitionKind.PeerKudos,
        subject_wallet: "bob",
        actor_wallet: "alice",
        created_at: "2026-01-16T12:00:00Z",
      }),
      ev({
        kind: RecognitionKind.PeerKudos,
        subject_wallet: "carol",
        actor_wallet: "bob",
        created_at: "2026-01-15T12:00:00Z",
      }),
    ];
    expect(scoreForWallet(events, "alice")).toBe(0);
    expect(scoreForWallet(events, "bob")).toBe(0);
    expect(scoreForWallet(events, "carol")).toBe(0.25);
  });
});

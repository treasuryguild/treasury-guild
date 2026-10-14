import { describe, expect, it } from "vitest";
import { communityGate, devGate, GATE_MESSAGES, sessionGate } from "./gate";

describe("communityGate", () => {
  it("waits while loading", () => {
    expect(
      communityGate({ loading: true, hasCommunity: false, role: null, require: "member" }),
    ).toEqual({ kind: "loading" });
  });

  it("blocks on a missing community regardless of requirement", () => {
    expect(
      communityGate({ loading: false, hasCommunity: false, role: null, require: "community" }),
    ).toEqual({ kind: "blocked", message: GATE_MESSAGES.notFound });
  });

  it("applies member and admin requirements", () => {
    const base = { loading: false, hasCommunity: true };
    expect(communityGate({ ...base, role: null, require: "community" })).toEqual({ kind: "ok" });
    expect(communityGate({ ...base, role: null, require: "member" })).toEqual({
      kind: "blocked",
      message: GATE_MESSAGES.membersOnly,
    });
    expect(communityGate({ ...base, role: "member", require: "member" })).toEqual({ kind: "ok" });
    expect(communityGate({ ...base, role: "member", require: "admin" })).toEqual({
      kind: "blocked",
      message: GATE_MESSAGES.adminOnly,
    });
    expect(communityGate({ ...base, role: "owner", require: "admin" })).toEqual({ kind: "ok" });
  });
});

describe("sessionGate", () => {
  it("requires a session wallet", () => {
    expect(sessionGate({ loading: true, sessionWallet: null })).toEqual({ kind: "loading" });
    expect(sessionGate({ loading: false, sessionWallet: null })).toEqual({
      kind: "blocked",
      message: GATE_MESSAGES.signIn,
    });
    expect(sessionGate({ loading: false, sessionWallet: "addr1" })).toEqual({ kind: "ok" });
  });
});

describe("devGate", () => {
  it("asks for sign-in first, then for the allowlist", () => {
    expect(devGate({ loading: true, sessionWallet: null, developer: false })).toEqual({ kind: "loading" });
    expect(devGate({ loading: false, sessionWallet: null, developer: false })).toEqual({
      kind: "blocked",
      message: GATE_MESSAGES.signIn,
    });
    expect(devGate({ loading: false, sessionWallet: "addr1", developer: false })).toEqual({
      kind: "blocked",
      message: GATE_MESSAGES.devOnly,
    });
    expect(devGate({ loading: false, sessionWallet: "addr1", developer: true })).toEqual({ kind: "ok" });
  });
});

import { describe, expect, it } from "vitest";
import { matchName, normalizeName, parsePastedNames } from "./nameMatch";

const members = [
  { wallet: "addr_alice", handle: "Alice Müller", githubUsername: "alice-dev" },
  { wallet: "addr_bob", handle: "bob", githubUsername: null },
  { wallet: "addr_bob2", handle: null, githubUsername: "Bob" },
];

describe("normalizeName", () => {
  it("ignores case, accents, punctuation and meeting-app suffixes", () => {
    expect(normalizeName("  Alice   MÜLLER ")).toBe("alice muller");
    expect(normalizeName("@alice-dev")).toBe("alice dev");
    expect(normalizeName("Alice Müller (Host, me)")).toBe("alice muller");
    expect(normalizeName("Carol (Guest)")).toBe("carol");
    expect(normalizeName("()")).toBe("");
  });
});

describe("parsePastedNames", () => {
  it("reads one name per line and drops blanks and repeats", () => {
    expect(parsePastedNames("Alice\r\n\n  bob  smith \nALICE\n")).toEqual(["Alice", "bob smith"]);
  });
});

describe("matchName", () => {
  const ctx = { aliases: new Map([["al", "addr_alice"], ["bob", "addr_bob2"]]), members };

  it("prefers a remembered alias", () => {
    expect(matchName("Al", ctx)).toBe("addr_alice");
    expect(matchName("BOB", ctx)).toBe("addr_bob2");
  });

  it("matches a unique handle or GitHub username", () => {
    const plain = { aliases: new Map<string, string>(), members };
    expect(matchName("alice muller", plain)).toBe("addr_alice");
    expect(matchName("Alice-Dev", plain)).toBe("addr_alice");
  });

  it("refuses to guess between two members", () => {
    expect(matchName("bob", { aliases: new Map(), members })).toBeNull();
  });

  it("returns null for strangers and empty names", () => {
    expect(matchName("Zed", ctx)).toBeNull();
    expect(matchName("  ", ctx)).toBeNull();
  });
});

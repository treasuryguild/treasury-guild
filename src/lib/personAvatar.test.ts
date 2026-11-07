import { describe, expect, it } from "vitest";
import {
  githubAvatarUrl,
  personHue,
  personInitial,
  personMarkStyle,
} from "./personAvatar";

describe("githubAvatarUrl", () => {
  it("builds a sized GitHub CDN URL and strips a leading @", () => {
    expect(githubAvatarUrl("alice")).toBe(
      "https://avatars.githubusercontent.com/alice?s=96",
    );
    expect(githubAvatarUrl("@bob", 48)).toBe(
      "https://avatars.githubusercontent.com/bob?s=48",
    );
  });
});

describe("personInitial", () => {
  it("prefers handle, then GitHub, then display name, then wallet", () => {
    expect(personInitial({ handle: "ada", githubUsername: "gh", wallet: "addr1" })).toBe("A");
    expect(personInitial({ handle: null, githubUsername: "@bob", wallet: "addr1" })).toBe("B");
    expect(personInitial({ displayName: "Carol", wallet: "addr1" })).toBe("C");
    expect(personInitial({ wallet: "addr1…" })).toBe("A");
    expect(personInitial({})).toBe("?");
  });
});

describe("personHue", () => {
  it("is stable for the same seed and differs across seeds", () => {
    expect(personHue("addr_test1aaa")).toBe(personHue("addr_test1aaa"));
    expect(personHue("addr_test1aaa")).not.toBe(personHue("addr_test1bbb"));
    expect(personHue(null)).toBe(220);
  });

  it("feeds a mark style with matching hsl colours", () => {
    const style = personMarkStyle("alice");
    expect(style.backgroundColor).toMatch(/^hsl\(\d+ 35% 22%\)$/);
    expect(style.color).toMatch(/^hsl\(\d+ 40% 78%\)$/);
  });
});

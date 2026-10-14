import { describe, expect, it } from "vitest";
import { splitRepoFullName } from "./repoName";

describe("splitRepoFullName", () => {
  it("splits owner and repo", () => {
    expect(splitRepoFullName("guild/vault")).toEqual({ owner: "guild", repo: "vault" });
  });

  it("rejects malformed names", () => {
    expect(() => splitRepoFullName("vault")).toThrow(/Invalid repository name/);
    expect(() => splitRepoFullName("a/b/c")).toThrow();
    expect(() => splitRepoFullName("/b")).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { mergeAssigneesAfterGithubSync } from "./useTaskSave";

describe("mergeAssigneesAfterGithubSync", () => {
  it("rebuilds github rows from the sync and keeps manuals, preferring form wallets by login", () => {
    expect(
      mergeAssigneesAfterGithubSync(
        [
          { source: "github", id: "stale", wallet: "addr1old" },
          { source: "manual", wallet: "addr1bob" },
        ],
        [
          { id: "new-a", ghLogin: "Carol", wallet: "addr1sync" },
          { id: "new-b", ghLogin: "dave", wallet: null },
        ],
        { carol: "addr1form", dave: "addr1dave" },
      ),
    ).toEqual([
      { source: "github", id: "new-a", wallet: "addr1form" },
      { source: "github", id: "new-b", wallet: "addr1dave" },
      { source: "manual", wallet: "addr1bob" },
    ]);
  });

  it("falls back to the synced wallet when the form has no entry for that login", () => {
    expect(
      mergeAssigneesAfterGithubSync(
        [{ source: "manual", wallet: "addr1bob" }],
        [{ id: "g1", ghLogin: "carol", wallet: "addr1sync" }],
        {},
      ),
    ).toEqual([
      { source: "github", id: "g1", wallet: "addr1sync" },
      { source: "manual", wallet: "addr1bob" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  decideSyncAction,
  diffAssigneeLogins,
  matchesImportFilter,
} from "./syncRules";

const repo = { payable_label: "audited", import_status: "In review" };

describe("matchesImportFilter", () => {
  it("requires both the review status and the payable label", () => {
    expect(matchesImportFilter(repo, ["audited"], "In review")).toBe(true);
    expect(matchesImportFilter(repo, ["audited"], "Done")).toBe(false);
    expect(matchesImportFilter(repo, ["bug"], "In review")).toBe(false);
    expect(matchesImportFilter(repo, [], "In review")).toBe(false);
  });

  it("is case-insensitive on both status and label", () => {
    expect(matchesImportFilter(repo, ["AUDITED"], "in REVIEW")).toBe(true);
    expect(
      matchesImportFilter(
        { payable_label: "Audited", import_status: "in review" },
        ["audited"],
        "In Review",
      ),
    ).toBe(true);
  });

  it("never matches without a project status", () => {
    expect(matchesImportFilter(repo, ["audited"], null)).toBe(false);
    expect(matchesImportFilter(repo, ["audited"], undefined)).toBe(false);
    expect(matchesImportFilter(repo, ["audited"], "")).toBe(false);
  });
});

describe("diffAssigneeLogins", () => {
  it("adds every login of a brand-new task", () => {
    expect(diffAssigneeLogins([], ["alice", "bob"])).toEqual({
      added: ["alice", "bob"],
      removed: [],
      kept: [],
    });
  });

  it("separates added, removed and kept logins", () => {
    expect(diffAssigneeLogins(["alice", "carol"], ["bob", "alice"])).toEqual({
      added: ["bob"],
      removed: ["carol"],
      kept: ["alice"],
    });
  });

  it("matches case-insensitively and keeps the stored casing", () => {
    expect(diffAssigneeLogins(["aLiCe"], ["Alice"])).toEqual({
      added: [],
      removed: [],
      kept: ["aLiCe"],
    });
  });

  it("de-duplicates the incoming list and ignores empty logins", () => {
    expect(diffAssigneeLogins([], ["Bob", "bob", "", "BOB"])).toEqual({
      added: ["Bob"],
      removed: [],
      kept: [],
    });
  });

  it("removes everyone on unassignment", () => {
    expect(diffAssigneeLogins(["alice", "bob"], [])).toEqual({
      added: [],
      removed: ["alice", "bob"],
      kept: [],
    });
  });
});

describe("decideSyncAction", () => {
  it("covers the full decision matrix", () => {
    // matching filter
    expect(
      decideSyncAction({ exists: false, settled: false, matchesFilter: true }),
    ).toBe("insert");
    expect(
      decideSyncAction({ exists: true, settled: false, matchesFilter: true }),
    ).toBe("update");
    expect(
      decideSyncAction({ exists: true, settled: true, matchesFilter: true }),
    ).toBe("update_mirror_only");
    // not matching filter
    expect(
      decideSyncAction({ exists: false, settled: false, matchesFilter: false }),
    ).toBe("skip");
    expect(
      decideSyncAction({ exists: true, settled: false, matchesFilter: false }),
    ).toBe("delete");
    // a paid issue moved to the Paid column keeps mirroring its status
    expect(
      decideSyncAction({ exists: true, settled: true, matchesFilter: false }),
    ).toBe("update_mirror_only");
  });
});

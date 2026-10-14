import { describe, expect, it } from "vitest";
import {
  COMMUNITY_CARDS,
  COMMUNITY_NAV,
  communityHref,
  communitySlugFromPath,
  maskCommunitySlug,
  pageLabel,
  routes,
} from "./routes";

describe("routes", () => {
  it("builds community-scoped paths", () => {
    expect(routes.community("dao")).toBe("/c/dao");
    expect(routes.tx("dao", "abc")).toBe("/c/dao/tx/abc");
    expect(routes.board("dao", "wg")).toBe("/c/dao/boards/wg");
    expect(routes.dashboard("dao")).toBe("/c/dao/dashboard");
    expect(routes.dashboard("dao", { month: "2026-07", view: "quarter" })).toBe("/c/dao/dashboard?month=2026-07&view=quarter");
    expect(routes.budgets("dao", { month: "2026-07", view: "month" })).toBe("/c/dao/budgets?month=2026-07&view=month");
    expect(routes.call("dao", "abc")).toBe("/c/dao/calls/abc");
    expect(routes.callCheckin("dao", "abc")).toBe("/c/dao/calls/abc/checkin");
    expect(routes.proposal("dao", "abc")).toBe("/c/dao/proposals/abc");
    expect(routes.proposals("dao", { kind: "task", workgroupId: "wg" })).toBe("/c/dao/proposals?new=task&workgroupId=wg");
    expect(routes.payments("dao")).toBe("/c/dao/payments");
    expect(routes.payments("dao", {
      treasuryId: "40000000-0000-0000-0000-000000000002", month: "2026-10", proposalId: "60000000-0000-0000-0000-000000000001",
      amounts: { lovelace: "2500" },
    })).toBe("/c/dao/payments?to=40000000-0000-0000-0000-000000000002&month=2026-10&proposal=60000000-0000-0000-0000-000000000001&amounts=lovelace%3A2500");
    expect(communityHref("governanceSettings", "dao")).toBe("/c/dao/settings/governance");
    expect(communityHref("githubSettings", "dao")).toBe("/c/dao/settings/github");
  });

  it("extracts the slug from a pathname", () => {
    expect(communitySlugFromPath("/c/my%20dao/treasury")).toBe("my dao");
    expect(communitySlugFromPath("/discover")).toBeNull();
  });

  it("nav and cards only reference community routes", () => {
    for (const entry of [...COMMUNITY_NAV, ...COMMUNITY_CARDS]) {
      expect(communityHref(entry.key, "x")).toMatch(/^\/c\/x/);
    }
  });

  it("labels pages in precedence order", () => {
    expect(pageLabel("/")).toBe("Home");
    expect(pageLabel("/discover")).toBe("Discover communities");
    expect(pageLabel("/c/dao/treasury/new")).toBe("New treasury");
    expect(pageLabel("/c/dao/treasury/import")).toBe("Import treasury");
    expect(pageLabel("/c/mint-guild/payday")).toBe("Payday");
    expect(pageLabel("/c/calls")).toBe("Community overview");
    expect(pageLabel("/c/dao/treasury")).toBe("Treasury");
    expect(pageLabel("/c/dao/budgets")).toBe("Budgets");
    expect(pageLabel("/c/dao/dashboard")).toBe("Dashboard");
    expect(pageLabel("/c/dao/settings/github")).toBe("GitHub");
    expect(pageLabel("/c/dao/calls")).toBe("Calls");
    expect(pageLabel("/c/dao/settings/calls")).toBe("Call capture");
    expect(pageLabel("/c/dao/calls/abc")).toBe("Call");
    expect(pageLabel("/c/dao/calls/abc/checkin")).toBe("Call check-in");
    expect(pageLabel("/c/dao/proposals")).toBe("Proposals");
    expect(pageLabel("/c/dao/proposals/abc")).toBe("Proposal");
    expect(pageLabel("/c/dao/settings/governance")).toBe("Governance");
    expect(pageLabel("/c/dao/boards/wg")).toBe("Workgroup board");
    expect(pageLabel("/c/dao/tx/abc")).toBe("Transaction");
    expect(pageLabel("/c/dao")).toBe("Community overview");
    expect(pageLabel("/docs")).toBe("Documentation");
    expect(pageLabel("/docs/treasury")).toBe("Documentation");
    expect(pageLabel("/dev")).toBe("Developer tools");
    expect(pageLabel("/something-else")).toBe("Guild Vault");
  });
});

describe("pageLabel: the remaining pages", () => {
  it("labels the pages outside a community", () => {
    expect(pageLabel(routes.newCommunity())).toBe("New community");
    expect(pageLabel("/communities/new")).toBe("New community");
    expect(pageLabel(routes.settings())).toBe("Profile & settings");
    expect(pageLabel(routes.welcome())).toBe("Welcome");
    expect(pageLabel("/oauth/consent")).toBe("Connect an AI assistant");
    // The consent route carries its handle in the query; the pathname alone decides.
    expect(pageLabel(routes.oauthConsent({ request: "handle.mac" }).split("?")[0]!)).toBe("Connect an AI assistant");
  });

  it("labels the community pages", () => {
    expect(pageLabel(routes.paymentHistory("dao"))).toBe("Payment history");
    expect(pageLabel(routes.payments("dao"))).toBe("Payments");
    expect(pageLabel(routes.mint("dao"))).toBe("Mint");
    expect(pageLabel(routes.reconcile("dao"))).toBe("Incoming & reconciliation");
    expect(pageLabel(routes.funding("dao"))).toBe("Funding sources");
    expect(pageLabel(routes.members("dao"))).toBe("Members");
  });

  it("puts the payment history ahead of the treasury it sits under", () => {
    expect(pageLabel("/c/dao/treasury/history")).toBe("Payment history");
    expect(pageLabel("/c/dao/treasury")).toBe("Treasury");
  });

  it("matches the top-level pages exactly, not as prefixes or community slugs", () => {
    expect(pageLabel("/settings/other")).toBe("Guild Vault");
    expect(pageLabel("/welcome/back")).toBe("Guild Vault");
    expect(pageLabel("/communities")).toBe("Guild Vault");
    // A community whose slug is a page name is still just a community.
    for (const slug of ["settings", "welcome", "payments", "mint", "reconcile", "funding", "members", "treasury", "docs", "dev"]) {
      expect(pageLabel(routes.community(slug)), slug).toBe("Community overview");
    }
  });

  it("gives every sidebar entry a label of its own, whatever the community is called", () => {
    for (const entry of COMMUNITY_NAV) {
      const label = pageLabel(communityHref(entry.key, "dao"));
      expect(label, entry.key).not.toBe("Guild Vault");
      if (entry.key !== "community") expect(label, entry.key).not.toBe("Community overview");
      for (const slug of ["treasury", "payments", "mint-guild", "calls", "funding", "proposals", "settings"]) {
        expect(pageLabel(communityHref(entry.key, slug)), `${entry.key} in ${slug}`).toBe(label);
      }
    }
  });
});

describe("maskCommunitySlug", () => {
  it("replaces the community slug and keeps the rest of the path", () => {
    expect(maskCommunitySlug("/c/dao")).toBe("/c/-");
    expect(maskCommunitySlug("/c/mint-guild/mint")).toBe("/c/-/mint");
    expect(maskCommunitySlug("/c/my%20dao/treasury/new")).toBe("/c/-/treasury/new");
    expect(maskCommunitySlug("/c/dao/boards/wg-1")).toBe("/c/-/boards/wg-1");
  });

  it("masks only the first segment after /c/", () => {
    expect(maskCommunitySlug("/c/a/c/b")).toBe("/c/-/c/b");
    expect(maskCommunitySlug("/c/treasury/treasury")).toBe("/c/-/treasury");
  });

  it("leaves paths outside a community alone", () => {
    for (const path of ["/", "/discover", "/settings", "/docs/c/dao", "/communities/new", "/c", "/c/", "/cc/dao"]) {
      expect(maskCommunitySlug(path), path).toBe(path);
    }
  });

  it("masks every community route to the same shape for any slug", () => {
    for (const entry of COMMUNITY_NAV) {
      expect(maskCommunitySlug(communityHref(entry.key, "mint-guild")), entry.key).toBe(maskCommunitySlug(communityHref(entry.key, "dao")));
    }
  });
});

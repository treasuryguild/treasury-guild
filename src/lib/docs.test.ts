// Keeps the user docs honest: every registry entry has a file and vice
// versa, every app route resolves to a doc, and every deep link (from
// DOC_PATHS or from one doc to another) points at a heading that exists.
// Adding a page without documenting it fails here, not in review.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOC_GROUPS,
  DOC_PATHS,
  DOCS,
  docBySlug,
  docForPath,
  docHref,
  docNeighbours,
  docsByGroup,
  headingText,
  isDocSlug,
  slugifyHeading,
} from "./docs";
import { CIP25_METADATA_LEGEND, PAYMENT_METADATA_LEGEND, PAYOUT_METADATA_LEGEND } from "./cardano/metadataLegend";
import { routes } from "./routes";

const CONTENT_DIR = fileURLToPath(new URL("../content/docs/", import.meta.url));

const files = readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith(".mdx"))
  .map((f) => f.slice(0, -".mdx".length));

const source = (slug: string) => readFileSync(`${CONTENT_DIR}${slug}.mdx`, "utf8");

/** Slugified H2/H3 headings of a doc, read straight from the markdown. */
const headingsOf = (slug: string) =>
  [...source(slug).matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => slugifyHeading(m[1] ?? ""));

describe("docs registry", () => {
  it("has exactly one MDX file per entry", () => {
    expect([...files].sort()).toEqual(DOCS.map((d) => d.slug).sort());
  });

  it("has unique slugs and known groups", () => {
    const slugs = DOCS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const doc of DOCS) expect(DOC_GROUPS).toContain(doc.group);
    expect(docsByGroup().flatMap((g) => g.docs)).toHaveLength(DOCS.length);
  });

  // The docs pages themselves, and internal pages that are not a user
  // feature (the DEV_WALLETS-only tools page), need no user doc.
  const INTERNAL_ROUTES = new Set(["docs", "doc", "dev"]);

  it("covers every app route", () => {
    for (const [key, build] of Object.entries(routes)) {
      if (INTERNAL_ROUTES.has(key)) continue;
      const path = (build as (...args: string[]) => string)("dao", "abc");
      expect(docForPath(path), `route ${key} (${path}) has no doc`).not.toBeNull();
    }
    expect(docForPath("/docs")).toBeNull();
    expect(docForPath("/docs/treasury")).toBeNull();
    expect(docForPath("/dev")).toBeNull();
    expect(docForPath("/c/dao/treasury/new")).toEqual({ slug: "treasury", hash: "creating-a-treasury" });
    expect(docForPath("/c/dao")).toEqual({ slug: "communities", hash: "community-overview" });
    expect(docForPath("/c/dao/treasury/import")).toEqual({ slug: "treasury", hash: "importing-a-treasury" });
    expect(docForPath("/c/dao/treasury/history")).toEqual({ slug: "treasury", hash: "payment-history-from-a-previous-wallet" });
    // A slug that names a page does not decide the match.
    expect(docForPath("/c/mint-guild/boards/abc")).toEqual({ slug: "workgroups-boards" });
    expect(docForPath("/c/treasury")).toEqual({ slug: "communities", hash: "community-overview" });
  });

  it("deep-links from pages to headings that exist", () => {
    for (const [, link] of DOC_PATHS) {
      if (!link.hash) continue;
      expect(headingsOf(link.slug), docHref(link)).toContain(link.hash);
    }
  });

  it("only links between docs that exist", () => {
    for (const slug of files) {
      for (const m of source(slug).matchAll(/\]\(\/docs\/([^)#]+)(?:#([^)]+))?\)/g)) {
        const target = m[1] ?? "";
        expect(isDocSlug(target), `${slug}.mdx links to /docs/${target}`).toBe(true);
        if (m[2]) {
          expect(headingsOf(target), `${slug}.mdx → /docs/${target}#${m[2]}`).toContain(m[2]);
        }
      }
    }
  });

  it("does not use H1 or import lines in content", () => {
    for (const slug of files) {
      const src = source(slug);
      expect(src, `${slug}.mdx has an H1`).not.toMatch(/^#\s/m);
      expect(src, `${slug}.mdx imports`).not.toMatch(/^import\s/m);
    }
  });

  it("walks prev/next in reading order", () => {
    const first = DOCS[0];
    const last = DOCS.at(-1);
    if (!last) throw new Error("registry is empty");
    expect(docNeighbours(first.slug).prev).toBeNull();
    expect(docNeighbours(first.slug).next?.slug).toBe(DOCS[1]?.slug);
    expect(docNeighbours(last.slug).next).toBeNull();
  });

  it("builds hrefs", () => {
    expect(docHref({ slug: "payday" })).toBe("/docs/payday");
    expect(docHref({ slug: "budgets", hash: "dashboard" })).toBe("/docs/budgets#dashboard");
  });
});

describe("heading ids", () => {
  it("slugifies like GitHub", () => {
    expect(slugifyHeading("Creating a treasury")).toBe("creating-a-treasury");
    expect(slugifyHeading("Members & roles")).toBe("members-roles");
    expect(slugifyHeading("Networks: mainnet and preprod")).toBe("networks-mainnet-and-preprod");
    expect(slugifyHeading("  Who can build a payout?  ")).toBe("who-can-build-a-payout");
  });

  it("flattens nested children to text", () => {
    expect(headingText(["Sign ", "in"])).toBe("Sign in");
    expect(headingText(42)).toBe("42");
  });
});

describe("docBySlug", () => {
  it("returns the registry entry of every slug", () => {
    for (const doc of DOCS) expect(docBySlug(doc.slug)).toBe(doc);
  });

  it("carries the title, summary and group the docs index shows", () => {
    expect(docBySlug("profile")).toEqual({
      slug: "profile",
      title: "Profile & settings",
      summary: expect.stringMatching(/\S/),
      group: "Start here",
    });
    expect(docBySlug("getting-started").title).toBe("Getting started");
    for (const doc of DOCS) {
      expect(docBySlug(doc.slug).title.trim(), doc.slug).not.toBe("");
      expect(docBySlug(doc.slug).summary.trim(), doc.slug).not.toBe("");
    }
  });

  it("agrees with the group listing and the neighbours", () => {
    for (const group of docsByGroup()) {
      for (const doc of group.docs) expect(docBySlug(doc.slug as Parameters<typeof docBySlug>[0]).group).toBe(group.group);
    }
    const second = DOCS[1]!;
    expect(docNeighbours(DOCS[0].slug).next).toBe(docBySlug(second.slug));
  });
});

describe("doc links of the metadata legends", () => {
  const legends = [PAYOUT_METADATA_LEGEND, PAYMENT_METADATA_LEGEND, CIP25_METADATA_LEGEND];

  it("point at the sections that explain each record", () => {
    expect(legends.map((legend) => legend.docs.href)).toEqual([
      "/docs/transactions#on-chain-metadata",
      "/docs/payments#on-chain-record",
      "/docs/mint#signing-and-confirmation",
    ]);
  });

  it("resolve to a doc and a heading that exist", () => {
    for (const legend of legends) {
      const match = /^\/docs\/([^#]+)#(.+)$/.exec(legend.docs.href);
      expect(match, `${legend.title}: ${legend.docs.href}`).not.toBeNull();
      const [, slug, hash] = match!;
      expect(isDocSlug(slug!), `${legend.title} links to /docs/${slug}`).toBe(true);
      expect(headingsOf(slug!), `${legend.title} → ${legend.docs.href}`).toContain(hash);
    }
  });

  it("label the link with the heading it opens", () => {
    for (const legend of legends) {
      const hash = legend.docs.href.split("#")[1];
      expect(slugifyHeading(legend.docs.label), legend.title).toBe(hash);
    }
  });
});

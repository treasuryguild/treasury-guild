// Single source of truth for the user documentation: the ordered list of
// docs (one MDX file each under src/content/docs/), their groups, and which
// doc explains which app page. The docs nav, landing cards, topbar Help link,
// static params and the coverage test (docs.test.ts) all derive from here —
// the same way routes.ts drives the sidebar.

import { Children, isValidElement, type ReactNode } from "react";
import { maskCommunitySlug, routes } from "./routes";

export const DOC_GROUPS = [
  "Start here",
  "Your community",
  "Paying contributors",
  "Reference",
] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];

export interface DocEntry {
  slug: string;
  title: string;
  summary: string;
  group: DocGroup;
}

/** Reading order. Every entry has a file at src/content/docs/<slug>.mdx. */
export const DOCS = [
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "What Treasury Guild is, wallets, signing in, networks and your first visit.",
    group: "Start here",
  },
  {
    slug: "profile",
    title: "Profile & settings",
    summary: "Your display handle, linking GitHub, Discord and Google accounts, connected AI assistants, and signing out.",
    group: "Start here",
  },
  {
    slug: "communities",
    title: "Communities",
    summary: "Finding, joining and creating a community, and the overview page.",
    group: "Start here",
  },
  {
    slug: "members-roles",
    title: "Members & roles",
    summary: "Owners, admins, members, treasury signers, workgroup leads and visibility.",
    group: "Your community",
  },
  {
    slug: "workgroups-boards",
    title: "Workgroups & boards",
    summary: "Creating or proposing workgroups, running a task board, proposing tasks on app boards, bounties and assignees.",
    group: "Your community",
  },
  {
    slug: "integrations",
    title: "Integrations",
    summary: "Discord server, payout Discord destinations, and the status of GitHub, call platforms and published records.",
    group: "Your community",
  },
  {
    slug: "github",
    title: "GitHub integration",
    summary: "Installing the GitHub App and turning issues into payable tasks.",
    group: "Your community",
  },

  {
    slug: "treasury",
    title: "Treasury",
    summary: "Multisig wallets: creating one, funding it and reading balances.",
    group: "Your community",
  },
  {
    slug: "budgets",
    title: "Budgets",
    summary: "Planning workgroup and treasury budgets and tracking spend against them.",
    group: "Your community",
  },
  {
    slug: "governance",
    title: "Proposals & voting",
    summary: "Polls, budget consent, new workgroups and task proposals on app boards: who proposes, who votes, how votes are signed and counted.",
    group: "Your community",
  },
  {
    slug: "payday",
    title: "Payday",
    summary: "Selecting payable tasks and building one batch payout transaction.",
    group: "Paying contributors",
  },
  {
    slug: "payments",
    title: "Payments",
    summary: "Paying outside addresses, members or another treasury from a treasury, against its own budget.",
    group: "Paying contributors",
  },
  {
    slug: "calls",
    title: "Call attendance",
    summary: "Rewarding people for attending Discord, Zoom or Meet calls: check-in, attendee lists and payout.",
    group: "Paying contributors",
  },
  {
    slug: "transactions",
    title: "Signing transactions",
    summary: "Signing, rejecting, submitting and confirming, plus the on-chain record.",
    group: "Paying contributors",
  },
  {
    slug: "mint",
    title: "Minting tokens",
    summary: "Creating fungible tokens and NFTs under the treasury's multisig policy.",
    group: "Paying contributors",
  },
  {
    slug: "reconciliation",
    title: "Incoming & reconciliation",
    summary: "Classifying treasury inflows and matching refunds to past payouts.",
    group: "Paying contributors",
  },
  {
    slug: "funding",
    title: "Funding sources",
    summary: "What outside funders committed, and what has arrived so far.",
    group: "Paying contributors",
  },
  {
    slug: "ai-assistants",
    title: "AI assistants",
    summary: "Connecting Claude or another AI assistant to read your communities, and the API behind it.",
    group: "Reference",
  },
  {
    slug: "faq",
    title: "FAQ & glossary",
    summary: "Common messages, what to do about them, and the terms used in the app.",
    group: "Reference",
  },
  {
    slug: "privacy",
    title: "Privacy policy",
    summary: "What Treasury Guild stores about you, who can see it, and how to have it changed or deleted.",
    group: "Reference",
  },
  {
    slug: "terms",
    title: "Terms of service",
    summary: "What you agree to when you use Treasury Guild: wallets, communities, on-chain activity and integrations.",
    group: "Reference",
  },
] as const satisfies readonly DocEntry[];

export type DocSlug = (typeof DOCS)[number]["slug"];

/** A doc, optionally deep-linked to one of its H2/H3 headings. */
export interface DocLink {
  slug: DocSlug;
  hash?: string;
}

export function isDocSlug(slug: string): slug is DocSlug {
  return DOCS.some((d) => d.slug === slug);
}

export function docBySlug(slug: DocSlug): DocEntry {
  // The slug is narrowed, so the entry exists.
  return DOCS.find((d) => d.slug === slug) as DocEntry;
}

export function docHref(link: DocLink): string {
  const base = routes.doc(link.slug);
  return link.hash ? `${base}#${link.hash}` : base;
}

export function docNeighbours(slug: DocSlug): {
  prev: DocEntry | null;
  next: DocEntry | null;
} {
  const index = DOCS.findIndex((d) => d.slug === slug);
  return {
    prev: index > 0 ? (DOCS[index - 1] ?? null) : null,
    next: index >= 0 && index < DOCS.length - 1 ? (DOCS[index + 1] ?? null) : null,
  };
}

export function docsByGroup(): { group: DocGroup; docs: DocEntry[] }[] {
  return DOC_GROUPS.map((group) => ({
    group,
    docs: DOCS.filter((d) => d.group === group),
  })).filter((g) => g.docs.length > 0);
}

/**
 * App pathname → the doc (and heading) that explains that page. Same shape
 * and precedence rules as PAGE_LABELS in routes.ts: first match wins, so
 * more specific paths come first. Every route helper must resolve here
 * (docs.test.ts checks), and every hash must be a real heading.
 */
export const DOC_PATHS: readonly [test: (p: string) => boolean, link: DocLink][] = [
  [(p) => p === "/", { slug: "getting-started", hash: "home" }],
  [(p) => p === "/welcome", { slug: "getting-started", hash: "the-welcome-page" }],
  [(p) => p === "/settings", { slug: "profile" }],
  [(p) => p.startsWith("/oauth/consent"), { slug: "ai-assistants", hash: "approving-a-connection" }],
  [(p) => p === "/discover", { slug: "communities", hash: "discover" }],
  [(p) => p === "/communities/new", { slug: "communities", hash: "creating-a-community" }],
  [(p) => p.includes("/treasury/new"), { slug: "treasury", hash: "creating-a-treasury" }],
  [(p) => p.includes("/treasury/import"), { slug: "treasury", hash: "importing-a-treasury" }],
  [(p) => p.includes("/treasury/history"), { slug: "treasury", hash: "payment-history-from-a-previous-wallet" }],
  [(p) => p.includes("/treasury"), { slug: "treasury" }],
  [(p) => p.includes("/dashboard"), { slug: "budgets", hash: "dashboard" }],
  [(p) => p.includes("/budgets"), { slug: "budgets" }],
  [(p) => p.includes("/payday"), { slug: "payday" }],
  [(p) => p.includes("/payments"), { slug: "payments" }],
  [(p) => p.includes("/settings/calls"), { slug: "calls", hash: "call-platforms" }],
  [(p) => p.includes("/calls/") && p.endsWith("/checkin"), { slug: "calls", hash: "checking-in" }],
  [(p) => p.includes("/calls"), { slug: "calls" }],
  [(p) => p.includes("/mint"), { slug: "mint" }],
  [(p) => p.includes("/reconcile"), { slug: "reconciliation" }],
  [(p) => p.includes("/funding"), { slug: "funding" }],
  [(p) => p.includes("/settings/integrations"), { slug: "integrations" }],
  [(p) => p.includes("/settings/governance"), { slug: "governance", hash: "governance-settings" }],
  [(p) => p.includes("/proposals/"), { slug: "governance", hash: "voting" }],
  [(p) => p.includes("/proposals"), { slug: "governance" }],
  [(p) => p.includes("/settings/github"), { slug: "github" }],
  [(p) => p.includes("/settings/members"), { slug: "members-roles" }],
  [(p) => p.includes("/boards/"), { slug: "workgroups-boards" }],
  [(p) => p.includes("/tx/"), { slug: "transactions" }],
  [(p) => p.startsWith("/c/"), { slug: "communities", hash: "community-overview" }],
];

/** The doc for an app page, or null on the docs pages themselves. */
export function docForPath(pathname: string): DocLink | null {
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return null;
  const path = maskCommunitySlug(pathname);
  for (const [test, link] of DOC_PATHS) {
    if (test(path)) return link;
  }
  return null;
}

/** GitHub-style heading id: lowercase, punctuation dropped, spaces → "-". */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** Flatten a heading's rendered children back to plain text. */
export function headingText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return headingText(child.props.children);
      }
      return "";
    })
    .join("");
}

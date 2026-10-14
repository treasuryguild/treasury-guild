// Single source of truth for app paths: page links, sidebar nav, dashboard
// cards and the header label are all derived from here.

import { isPaymentPrefill, paymentPrefillQuery, type PaymentPrefill } from "@/lib/payments/prefill";

/** A budget period a Budgets or Dashboard link opens at (?month=YYYY-MM&view=…). */
export interface PeriodQuery {
  month: string;
  view: string;
}

function withPeriod(path: string, period?: PeriodQuery): string {
  return period ? `${path}?${new URLSearchParams({ month: period.month, view: period.view })}` : path;
}

export const routes = {
  home: () => "/",
  discover: () => "/discover",
  newCommunity: () => "/communities/new",
  settings: () => "/settings",
  /** Where an AI client sends the user to approve a connection (?request=<signed handle>, or ?error=). */
  oauthConsent: (query: { request: string } | { error: string }) =>
    `/oauth/consent?${new URLSearchParams(query)}`,
  welcome: () => "/welcome",
  docs: () => "/docs",
  doc: (slug: string) => `/docs/${slug}`,
  /** Internal developer tools; only DEV_WALLETS can open it (no user docs). */
  dev: () => "/dev",
  community: (slug: string) => `/c/${slug}`,
  treasury: (slug: string) => `/c/${slug}/treasury`,
  newTreasury: (slug: string) => `/c/${slug}/treasury/new`,
  importTreasury: (slug: string) => `/c/${slug}/treasury/import`,
  /** Payment history imported from a previous wallet's CSV (admins). */
  paymentHistory: (slug: string) => `/c/${slug}/treasury/history`,
  payday: (slug: string) => `/c/${slug}/payday`,
  /** `prefill` opens the form with a transfer funding a voted budget ("Fund this budget" on a budget proposal). */
  payments: (slug: string, prefill?: PaymentPrefill) =>
    isPaymentPrefill(prefill) ? `/c/${slug}/payments?${paymentPrefillQuery(prefill)}` : `/c/${slug}/payments`,
  calls: (slug: string) => `/c/${slug}/calls`,
  call: (slug: string, callId: string) => `/c/${slug}/calls/${callId}`,
  /** The link a host shares: attendees confirm presence with their wallet. */
  callCheckin: (slug: string, callId: string) => `/c/${slug}/calls/${callId}/checkin`,
  mint: (slug: string) => `/c/${slug}/mint`,
  reconcile: (slug: string) => `/c/${slug}/reconcile`,
  /** Outside funders, what they committed and what arrived. */
  funding: (slug: string) => `/c/${slug}/funding`,
  /** Community decisions: polls and budget changes put to a vote. */
  /** `propose` opens the new-proposal form for that kind (and board, for a task). */
  proposals: (slug: string, propose?: { kind: string; workgroupId?: string }) =>
    propose ? `/c/${slug}/proposals?${new URLSearchParams({ new: propose.kind, ...(propose.workgroupId ? { workgroupId: propose.workgroupId } : {}) })}` : `/c/${slug}/proposals`,
  proposal: (slug: string, proposalId: string) => `/c/${slug}/proposals/${proposalId}`,
  budgets: (slug: string, period?: PeriodQuery) => withPeriod(`/c/${slug}/budgets`, period),
  dashboard: (slug: string, period?: PeriodQuery) => withPeriod(`/c/${slug}/dashboard`, period),
  githubSettings: (slug: string) => `/c/${slug}/settings/github`,
  /** Connect the platforms calls are captured from (Discord server). */
  callSettings: (slug: string) => `/c/${slug}/settings/calls`,
  /** Who proposes and votes on what, per proposal kind (admins edit). */
  governanceSettings: (slug: string) => `/c/${slug}/settings/governance`,
  members: (slug: string) => `/c/${slug}/settings/members`,
  board: (slug: string, workgroupId: string) =>
    `/c/${slug}/boards/${workgroupId}`,
  tx: (slug: string, txId: string) => `/c/${slug}/tx/${txId}`,
} as const;

export type CommunityRouteKey =
  | "community"
  | "treasury"
  | "payday"
  | "payments"
  | "calls"
  | "mint"
  | "reconcile"
  | "funding"
  | "budgets"
  | "dashboard"
  | "proposals"
  | "githubSettings"
  | "callSettings"
  | "governanceSettings"
  | "members";

export interface CommunityNavEntry {
  key: CommunityRouteKey;
  label: string;
  /** Match the path exactly (overview) rather than by prefix. */
  exact?: boolean;
}

/** Sidebar entries for a community, in display order. Icons live in AppShell. */
export const COMMUNITY_NAV: readonly CommunityNavEntry[] = [
  { key: "community", label: "Overview", exact: true },
  { key: "treasury", label: "Treasury" },
  { key: "budgets", label: "Budgets" },
  { key: "dashboard", label: "Dashboard" },
  { key: "proposals", label: "Proposals" },
  { key: "payday", label: "Payday" },
  { key: "payments", label: "Payments" },
  { key: "calls", label: "Calls" },
  { key: "mint", label: "Mint" },
  { key: "reconcile", label: "Incoming" },
  { key: "funding", label: "Funding" },
  { key: "githubSettings", label: "GitHub" },
  { key: "callSettings", label: "Call capture" },
  { key: "governanceSettings", label: "Governance" },
  { key: "members", label: "Members" },
];

export interface CommunityCard {
  key: Exclude<CommunityRouteKey, "community">;
  title: string;
  blurb: string;
}

/** Dashboard cards on the community overview page. */
export const COMMUNITY_CARDS: readonly CommunityCard[] = [
  { key: "budgets", title: "Budgets", blurb: "Track project budgets, balances & spending" },
  { key: "proposals", title: "🗳️ Proposals", blurb: "Vote on budgets and community decisions" },
  { key: "treasury", title: "💰 Treasury", blurb: "Multisig wallets & pending transactions" },
  { key: "payday", title: "💸 Payday", blurb: "Batch-pay audited tasks" },
  { key: "payments", title: "📤 Payments", blurb: "Pay addresses, members or another treasury" },
  { key: "calls", title: "🎙️ Calls", blurb: "Reward call attendance with tokens" },
  { key: "mint", title: "🪙 Mint", blurb: "Create community tokens & NFTs" },
  { key: "reconcile", title: "🔁 Reconcile", blurb: "Match refunds sent back to the treasury" },
  { key: "funding", title: "🏦 Funding sources", blurb: "Committed funding vs what arrived" },
  { key: "githubSettings", title: "🐙 GitHub", blurb: "Connect repos & project boards" },
  { key: "members", title: "👥 Members", blurb: "Roles & workgroup leads" },
];

export function communityHref(key: CommunityRouteKey, slug: string): string {
  return routes[key](slug);
}

/** Community slug from a pathname like /c/<slug>/..., or null. */
export function communitySlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/c\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * The pathname with its community slug masked, for the page rules below and
 * DOC_PATHS: a slug such as "mint-guild" must not read as the Mint page.
 */
export function maskCommunitySlug(pathname: string): string {
  return pathname.replace(/^\/c\/[^/]+/, "/c/-");
}

const PAGE_LABELS: readonly [test: (p: string) => boolean, label: string][] = [
  [(p) => p === "/", "Home"],
  [(p) => p === "/discover", "Discover communities"],
  [(p) => p === "/communities/new", "New community"],
  [(p) => p === "/settings", "Profile & settings"],
  [(p) => p === "/welcome", "Welcome"],
  [(p) => p.startsWith("/oauth/consent"), "Connect an AI assistant"],
  [(p) => p === "/dev", "Developer tools"],
  // Before the `includes` rows: /docs/treasury must not read as "Treasury".
  [(p) => p === "/docs" || p.startsWith("/docs/"), "Documentation"],
  [(p) => p.includes("/treasury/new"), "New treasury"],
  [(p) => p.includes("/treasury/import"), "Import treasury"],
  [(p) => p.includes("/treasury/history"), "Payment history"],
  [(p) => p.includes("/treasury"), "Treasury"],
  [(p) => p.includes("/dashboard"), "Dashboard"],
  [(p) => p.includes("/budgets"), "Budgets"],
  [(p) => p.includes("/payday"), "Payday"],
  [(p) => p.includes("/payments"), "Payments"],
  // Before the /calls rows: /settings/calls contains "/calls".
  [(p) => p.includes("/settings/calls"), "Call capture"],
  [(p) => p.includes("/calls/") && p.endsWith("/checkin"), "Call check-in"],
  [(p) => p.includes("/calls/"), "Call"],
  [(p) => p.includes("/calls"), "Calls"],
  [(p) => p.includes("/mint"), "Mint"],
  [(p) => p.includes("/reconcile"), "Incoming & reconciliation"],
  [(p) => p.includes("/funding"), "Funding sources"],
  [(p) => p.includes("/settings/governance"), "Governance"],
  [(p) => p.includes("/proposals/"), "Proposal"],
  [(p) => p.includes("/proposals"), "Proposals"],
  [(p) => p.includes("/settings/github"), "GitHub"],
  [(p) => p.includes("/settings/members"), "Members"],
  [(p) => p.includes("/boards/"), "Workgroup board"],
  [(p) => p.includes("/tx/"), "Transaction"],
  [(p) => p.startsWith("/c/"), "Community overview"],
];

/** Header label for the current page. */
export function pageLabel(pathname: string): string {
  const path = maskCommunitySlug(pathname);
  for (const [test, label] of PAGE_LABELS) {
    if (test(path)) return label;
  }
  return "Guild Vault";
}

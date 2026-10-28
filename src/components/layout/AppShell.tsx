"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Banknote,
  Blocks,
  BookOpen,
  ChartNoAxesCombined,
  ChartPie,
  CircleQuestionMark,
  Compass,
  FolderGit2,
  Home,
  Landmark,
  Scale,
  LayoutDashboard,
  Menu,
  Mic,
  Plug,
  Radio,
  PanelLeftClose,
  PanelLeftOpen,
  PlusCircle,
  RefreshCcw,
  HandCoins,
  Send,
  Settings,
  Users,
  Vote,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { SIDEBAR_STORAGE_KEY } from "@/lib/constants";
import { docForPath, docHref } from "@/lib/docs";
import {
  COMMUNITY_NAV,
  communityHref,
  communitySlugFromPath,
  pageLabel,
  routes,
  type CommunityRouteKey,
} from "@/lib/routes";
import { CommunityNetworkStrip } from "@/components/community/NetworkNotice";
import { WalletBar } from "./WalletBar";
import { BrandLogo } from "./BrandLogo";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
}

const PRIMARY_ITEMS: NavItem[] = [
  { label: "Home", href: routes.home(), icon: Home, exact: true },
  { label: "Discover", href: routes.discover(), icon: Compass },
  { label: "New community", href: routes.newCommunity(), icon: PlusCircle },
  { label: "Profile & settings", href: routes.settings(), icon: Settings },
  { label: "Docs", href: routes.docs(), icon: BookOpen },
];

/** Shown only to wallets on the DEV_WALLETS allowlist (session `developer`). */
const DEV_ITEM: NavItem = { label: "Dev tools", href: routes.dev(), icon: Wrench };

const COMMUNITY_ICONS: Record<CommunityRouteKey, LucideIcon> = {
  community: LayoutDashboard,
  treasury: Landmark,
  budgets: ChartNoAxesCombined,
  dashboard: ChartPie,
  proposals: Vote,
  payday: Banknote,
  payments: Send,
  calls: Mic,
  mint: Blocks,
  reconcile: RefreshCcw,
  funding: HandCoins,
  integrations: Plug,
  githubSettings: FolderGit2,
  callSettings: Radio,
  governanceSettings: Scale,
  members: Users,
};

function communityItems(slug: string): NavItem[] {
  return COMMUNITY_NAV.map((entry) => ({
    label: entry.label,
    href: communityHref(entry.key, slug),
    icon: COMMUNITY_ICONS[entry.key],
    exact: entry.exact,
  }));
}

function NavLink({
  item,
  compact,
  onNavigate,
}: {
  item: NavItem;
  compact: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={compact ? item.label : undefined}
      className={`sidebar-link ${active ? "sidebar-link-active" : ""} ${
        compact ? "sidebar-link-compact" : ""
      }`}
    >
      <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
      <span className={compact ? "sr-only" : "truncate"}>{item.label}</span>
    </Link>
  );
}

function SidebarContent({
  compact,
  onNavigate,
}: {
  compact: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { developer } = useSession();
  const communitySlug = useMemo(() => communitySlugFromPath(pathname), [pathname]);
  const items = communitySlug ? communityItems(communitySlug) : [];
  const primary = developer ? [...PRIMARY_ITEMS, DEV_ITEM] : PRIMARY_ITEMS;

  return (
    <>
      <div className={`sidebar-brand ${compact ? "justify-center" : ""}`}>
        <span className="brand-mark" aria-hidden="true">
          <BrandLogo className="h-7 w-7" />
        </span>
        <span className={compact ? "sr-only" : "brand-copy"}>
          <strong>Treasury Guild</strong>
          <small>Community treasury</small>
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Main navigation">
        <div className="space-y-1">
          {primary.map((item) => (
            <NavLink key={item.href} item={item} compact={compact} onNavigate={onNavigate} />
          ))}
        </div>

        {communitySlug && (
          <div className="mt-6">
            <p className={compact ? "sidebar-divider" : "sidebar-label"}>
              {compact ? <span className="sr-only">Community</span> : communitySlug}
            </p>
            <div className="mt-2 space-y-1">
              {items.map((item) => (
                <NavLink key={item.href} item={item} compact={compact} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* In the server-rendered chrome of every page, the public home included. */}
      <p className={compact ? "sr-only" : "px-6 pb-4 text-xs text-zinc-500"}>
        <Link href={routes.doc("privacy")} className="hover:text-zinc-300" onClick={onNavigate}>
          Privacy policy
        </Link>
        {" · "}
        <Link href={routes.doc("terms")} className="hover:text-zinc-300" onClick={onNavigate}>
          Terms of service
        </Link>
      </p>
    </>
  );
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // storage unavailable: the preference just doesn't persist
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const communitySlug = useMemo(() => communitySlugFromPath(pathname), [pathname]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Contextual help: the doc page that explains the current screen.
  const help = docForPath(pathname);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  function toggleCollapsed() {
    setCollapsed((value) => {
      const next = !value;
      writeCollapsed(next);
      return next;
    });
  }

  return (
    <div className="app-shell">
      <aside className={`desktop-sidebar ${collapsed ? "desktop-sidebar-collapsed" : ""}`}>
        <SidebarContent compact={collapsed} />
        <button
          type="button"
          className={`sidebar-collapse ${collapsed ? "justify-center" : ""}`}
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
          {!collapsed && <span>Collapse sidebar</span>}
        </button>
      </aside>

      {mobileOpen && (
        <button type="button" className="mobile-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />
      )}
      <aside
        className={`mobile-sidebar ${mobileOpen ? "mobile-sidebar-open" : ""}`}
        aria-hidden={!mobileOpen}
        inert={!mobileOpen ? true : undefined}
      >
        <button type="button" className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
          <X className="h-5 w-5" />
        </button>
        <SidebarContent compact={false} onNavigate={() => setMobileOpen(false)} />
      </aside>

      <div className="min-w-0 flex-1">
        <header className="topbar">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="mobile-menu-button" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-expanded={mobileOpen}>
              <Menu className="h-5 w-5" />
            </button>
            <span className="truncate text-sm font-medium">{pageLabel(pathname)}</span>
            {help && (
              <Link
                href={docHref(help)}
                className="topbar-help"
                title="Help for this page"
                aria-label="Help for this page"
              >
                <CircleQuestionMark aria-hidden="true" className="h-[18px] w-[18px]" />
              </Link>
            )}
          </div>
          <WalletBar />
        </header>
        {communitySlug && <CommunityNetworkStrip slug={communitySlug} />}
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}

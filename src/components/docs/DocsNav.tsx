"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docsByGroup } from "@/lib/docs";
import { routes } from "@/lib/routes";

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation">
      <Link
        href={routes.docs()}
        onClick={onNavigate}
        aria-current={pathname === routes.docs() ? "page" : undefined}
        className="docs-nav-link docs-nav-home"
      >
        All docs
      </Link>
      {docsByGroup().map(({ group, docs }) => (
        <div key={group} className="mt-4">
          <p className="sidebar-label">{group}</p>
          <div className="mt-1 space-y-0.5">
            {docs.map((doc) => {
              const href = routes.doc(doc.slug);
              return (
                <Link
                  key={doc.slug}
                  href={href}
                  onClick={onNavigate}
                  aria-current={pathname === href ? "page" : undefined}
                  className="docs-nav-link"
                >
                  {doc.title}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** Docs section navigation: a sticky column on desktop, a disclosure on mobile. */
export function DocsNav() {
  return (
    <>
      <details className="docs-nav-mobile lg:hidden">
        <summary>Browse the documentation</summary>
        <div className="pt-2">
          <NavList />
        </div>
      </details>
      <div className="hidden lg:block">
        <NavList />
      </div>
    </>
  );
}

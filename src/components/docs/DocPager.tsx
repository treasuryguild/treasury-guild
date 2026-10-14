import Link from "next/link";
import type { DocEntry } from "@/lib/docs";
import { routes } from "@/lib/routes";

/** Previous / next links at the foot of a doc page, in registry order. */
export function DocPager({
  prev,
  next,
}: {
  prev: DocEntry | null;
  next: DocEntry | null;
}) {
  return (
    <nav className="docs-pager" aria-label="Previous and next">
      {prev ? (
        <Link href={routes.doc(prev.slug)} rel="prev" className="docs-pager-link">
          <span className="docs-pager-label">Previous</span>
          <span>{prev.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link href={routes.doc(next.slug)} rel="next" className="docs-pager-link docs-pager-next">
          <span className="docs-pager-label">Next</span>
          <span>{next.title}</span>
        </Link>
      )}
    </nav>
  );
}

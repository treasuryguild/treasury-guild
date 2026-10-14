// Required by @next/mdx (App Router): the components every MDX file renders
// with. Runs in server components — no hooks here. Docs never write import
// lines; anything they can use (Callout) is exposed from this map.

import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { AnchorHTMLAttributes, HTMLAttributes } from "react";
import { headingText, slugifyHeading } from "@/lib/docs";
import { Callout } from "@/components/docs/Callout";

function DocsAnchor({
  href = "",
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

// Headings carry an id derived from their text so pages can deep-link to
// them (docForPath hashes). Keep H2/H3 text plain — no inline code or links.
function DocsH2({ children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  const id = slugifyHeading(headingText(children));
  return (
    <h2 id={id} {...rest}>
      <a href={`#${id}`} className="docs-anchor">
        {children}
      </a>
    </h2>
  );
}

function DocsH3({ children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  const id = slugifyHeading(headingText(children));
  return (
    <h3 id={id} {...rest}>
      <a href={`#${id}`} className="docs-anchor">
        {children}
      </a>
    </h3>
  );
}

const components: MDXComponents = {
  a: DocsAnchor,
  h2: DocsH2,
  h3: DocsH3,
  Callout,
};

export function useMDXComponents(): MDXComponents {
  return components;
}

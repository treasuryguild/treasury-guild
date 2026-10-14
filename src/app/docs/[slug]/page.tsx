import type { Metadata } from "next";
import type { MDXContent } from "mdx/types";
import { notFound } from "next/navigation";
import { DOCS, docBySlug, docNeighbours, isDocSlug, type DocSlug } from "@/lib/docs";
import { DocPager } from "@/components/docs/DocPager";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!isDocSlug(slug)) return {};
  const doc = docBySlug(slug);
  return {
    title: `${doc.title} – Treasury Guild docs`,
    description: doc.summary,
  };
}

// The documented @next/mdx pattern: Turbopack bundles every file matching
// the template. The only place the untyped dynamic import is cast.
async function loadDoc(slug: DocSlug): Promise<MDXContent> {
  const mod = (await import(`@/content/docs/${slug}.mdx`)) as { default: MDXContent };
  return mod.default;
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!isDocSlug(slug)) notFound();
  const doc = docBySlug(slug);
  const Body = await loadDoc(slug);
  const { prev, next } = docNeighbours(slug);

  return (
    <article className="docs-prose glass-panel rounded-2xl p-5 sm:p-8">
      <h1>{doc.title}</h1>
      <p className="docs-lede">{doc.summary}</p>
      <Body />
      <DocPager prev={prev} next={next} />
    </article>
  );
}

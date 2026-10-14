import type { Metadata } from "next";
import Link from "next/link";
import { docsByGroup } from "@/lib/docs";
import { routes } from "@/lib/routes";
import { Card, PageTitle, SectionTitle } from "@/components/ui";

export const metadata: Metadata = {
  title: "Documentation – Treasury Guild",
  description: "How to use Treasury Guild: communities, treasuries, task boards, Payday and more.",
};

export default function DocsIndexPage() {
  return (
    <div>
      <PageTitle>Documentation</PageTitle>
      <p className="mb-8 max-w-3xl text-zinc-400">
        Treasury Guild is a treasury manager for Cardano communities: a shared
        multisig wallet, task boards for bounty work, and a Payday flow that
        pays contributors in one batch transaction with a verifiable on-chain
        record of who was paid for what. These pages explain every section of
        the site. New here? Start with{" "}
        <Link href={routes.doc("getting-started")} className="text-indigo-400 underline">
          Getting started
        </Link>
        .
      </p>

      {docsByGroup().map(({ group, docs }) => (
        <section key={group} className="mb-8">
          <SectionTitle>{group}</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((doc) => (
              <Link key={doc.slug} href={routes.doc(doc.slug)}>
                <Card className="h-full transition-colors hover:border-indigo-600">
                  <h3 className="font-medium">{doc.title}</h3>
                  <p className="mt-1 text-sm text-zinc-400">{doc.summary}</p>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

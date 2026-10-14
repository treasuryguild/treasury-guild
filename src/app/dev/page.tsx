"use client";

import { useDevGate } from "@/hooks/useCommunityGate";
import { Card, PageTitle, SectionTitle } from "@/components/ui";
import { DEV_TOOLS } from "@/components/dev/tools";

// Internal tools for the team: only wallets listed in DEV_WALLETS get here
// (and only they can call /api/dev/*). Each tool is a section from the
// registry in components/dev/tools.tsx.

export default function DevToolsPage() {
  const { blocked } = useDevGate();
  if (blocked) return blocked;

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <PageTitle>Developer tools</PageTitle>
        <p className="-mt-3 text-sm text-zinc-400">
          Visible to the wallets in <code className="text-zinc-300">DEV_WALLETS</code> only.
        </p>
      </div>

      {DEV_TOOLS.map((tool) => (
        <section key={tool.id} id={tool.id}>
          <SectionTitle className="mb-1">{tool.title}</SectionTitle>
          <p className="mb-4 text-sm text-zinc-400">{tool.description}</p>
          <Card>
            <tool.Component />
          </Card>
        </section>
      ))}
    </div>
  );
}

"use client";

// Onboarding hub, reached automatically after a wallet's first sign-in (and
// linkable any time). A page, not a modal: the GitHub OAuth link is a full
// redirect and lands back here as /welcome?github=connected — by then the
// server has already auto-joined the communities whose tasks are assigned to
// the linked GitHub account, so the directory below reflects it immediately.

import { useState } from "react";
import { useSessionGate } from "@/hooks/useCommunityGate";
import { routes } from "@/lib/routes";
import { LinkButton, PageTitle, SectionTitle } from "@/components/ui";
import { GithubLinkCard } from "@/components/profile/GithubLinkCard";
import { HandleCard } from "@/components/profile/HandleCard";
import { CommunityDirectory } from "@/components/community/CommunityDirectory";

export default function WelcomePage() {
  const { blocked } = useSessionGate();
  const [githubUsername, setGithubUsername] = useState<string | null>(null);
  if (blocked) return blocked;

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle>Welcome to Guild Vault</PageTitle>
      <p className="mb-6 text-zinc-400">
        Two quick optional steps, then pick your communities.
      </p>

      <div className="mb-4">
        <GithubLinkCard returnTo={routes.welcome()} onChange={setGithubUsername} />
        {!githubUsername && (
          <p className="mt-2 text-sm text-zinc-500">
            No GitHub? No problem — you can skip this and a community admin can
            add you directly.
          </p>
        )}
      </div>

      <div className="mb-8">
        <HandleCard />
      </div>

      <SectionTitle className="mb-3">Communities</SectionTitle>
      <CommunityDirectory />

      <div className="mt-8 flex flex-wrap gap-2">
        <LinkButton href={routes.home()} variant="secondary">
          Go to dashboard
        </LinkButton>
        <LinkButton href={routes.doc("getting-started")} variant="ghost">
          Read the getting started guide
        </LinkButton>
      </div>
    </div>
  );
}

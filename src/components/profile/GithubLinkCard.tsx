"use client";

// One-off GitHub account link, shared by /settings and /welcome. Linking lets
// the sync pay GitHub assignees to the right wallet and auto-joins the user
// to communities where tasks are assigned to them. The OAuth round trip is a
// full redirect, so the outcome comes back as ?github=<outcome>&reason=<code>
// on whatever page started it (returnTo).

import { useEffect } from "react";
import { apiFetch, apiUrl } from "@/lib/api/client";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useContributorProfile } from "@/hooks/useContributorProfile";
import { useOAuthOutcome } from "@/hooks/useOAuthOutcome";
import { Button, Card, ErrorText, LinkButton, OAuthOutcomeBanner } from "@/components/ui";

export function GithubLinkCard({
  returnTo,
  onChange,
}: {
  returnTo: string;
  onChange?: (githubUsername: string | null) => void;
}) {
  const { data: profile, setData } = useContributorProfile();
  const outcome = useOAuthOutcome("github");
  const disconnect = useAsyncAction("Could not disconnect GitHub");
  const githubUsername = profile?.github_username ?? null;

  useEffect(() => {
    onChange?.(githubUsername);
  }, [githubUsername, onChange]);

  async function disconnectGithub() {
    const ok = await disconnect.run(() =>
      apiFetch("/api/github/connect", { method: "DELETE" }),
    );
    if (ok) {
      setData((prev) => ({ handle: null, ...prev, github_username: null }));
      outcome.clear();
    }
  }

  return (
    <Card>
      <h3 className="font-medium">🐙 GitHub account</h3>
      <p className="mt-1 text-sm text-zinc-400">
        Link your GitHub account once and tasks assigned to you on GitHub are
        automatically paid to this wallet. You also join the communities whose
        boards already have tasks assigned to you.
      </p>
      <OAuthOutcomeBanner name="GitHub" outcome={outcome.outcome} reason={outcome.reason} messages={{
        connected: "GitHub account connected. Open tasks assigned to you now point at this wallet.",
      }} />
      <ErrorText error={disconnect.error} className="mt-3" />
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3">
        {githubUsername ? (
          <>
            <span className="min-w-0 break-all text-sm">@{githubUsername}</span>
            <Button
              variant="secondary"
              disabled={disconnect.busy}
              onClick={() => void disconnectGithub()}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <LinkButton
            external
            href={apiUrl("/api/github/connect", { returnTo })}
          >
            Connect GitHub
          </LinkButton>
        )}
      </div>
    </Card>
  );
}

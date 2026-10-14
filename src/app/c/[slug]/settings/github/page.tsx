"use client";

import { use, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type {
  GithubRepoOption,
  GithubReposResponse,
  InstallUrlResponse,
  SyncRepoResponse,
} from "@/lib/api/types";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useOAuthOutcome } from "@/hooks/useOAuthOutcome";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  NoticeText,
  OAuthOutcomeBanner,
  PageTitle,
} from "@/components/ui";
import { RepoCard, type RepoLinkFields } from "@/components/github/RepoCard";

export default function GithubSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  const repos = useAsyncData(community?.id, () =>
    apiFetch<GithubReposResponse>("/api/github/repos", {
      query: { communityId: community!.id },
    }),
  );
  const workgroups = useWorkgroups(community?.id, true);
  const installOutcome = useOAuthOutcome("install");
  const action = useAsyncAction();
  const [busyRepo, setBusyRepo] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (blocked) return blocked;

  async function install() {
    const result = await action.run(() =>
      apiFetch<InstallUrlResponse>("/api/github/install-url", {
        query: { communityId: community!.id },
      }),
    );
    if (result) window.location.href = result.url;
  }

  async function withRepo(repoId: number, task: () => Promise<unknown>) {
    setBusyRepo(repoId);
    setNotice(null);
    try {
      await action.run(task);
    } finally {
      setBusyRepo(null);
    }
  }

  async function linkRepo(repo: GithubRepoOption, fields: RepoLinkFields) {
    await withRepo(repo.id, async () => {
      await apiFetch("/api/github/repos", {
        body: {
          communityId: community!.id,
          repoId: repo.id,
          workgroupId: fields.workgroupId,
          payableLabel: fields.label,
          importStatus: fields.importStatus,
          paidStatus: fields.paidStatus,
        },
      });
      repos.reload();
    });
  }

  async function syncRepo(repoId: number) {
    await withRepo(repoId, async () => {
      const result = await apiFetch<SyncRepoResponse>("/api/github/sync", {
        body: { repoId },
      });
      setNotice(`Synced ${result.synced} issues, removed ${result.deleted}`);
    });
  }

  const installed = repos.data?.installed ?? null;
  const error = repos.error ?? action.error;

  return (
    <div>
      <PageTitle>GitHub integration</PageTitle>
      <OAuthOutcomeBanner
        name="GitHub App"
        outcome={installOutcome.outcome}
        reason={installOutcome.reason}
        messages={{
          connected: "GitHub App installed.",
          taken: "That GitHub installation already belongs to another community.",
          error:
            installOutcome.reason === "installation_not_recent"
              ? "That installation was not just installed or updated from here. Open Install GitHub App again and finish on GitHub within 10 minutes."
              : "GitHub App installation could not be saved. Please try again.",
        }}
      />

      {installed === false && (
        <Card>
          <p className="mb-4 text-zinc-400">
            Install the Guild Vault GitHub App on your organization to sync
            issues and project boards. Issues in your project&apos;s import
            column (default &quot;In review&quot;) that carry your payable
            label (default <Badge tone="green">audited</Badge>) are imported
            and become ready for payout automatically.
          </p>
          <ErrorText error={error} className="mb-3" />
          <Button onClick={() => void install()} loading={action.busy}>
            {action.busy ? "Opening GitHub…" : "Install GitHub App"}
          </Button>
        </Card>
      )}

      {installed && (
        <>
          <p className="mb-4 text-sm text-zinc-400">
            Installed on{" "}
            <span className="font-medium">{repos.data?.accountLogin}</span>.
            Map repositories to workgroups — only issues sitting in the import
            column of a project board <em>and</em> carrying the payable label
            are imported. They sync in near-real-time via webhooks, with an
            hourly sweep as backup; issues that leave the column or lose the
            label are removed unless already paid.
          </p>
          <ErrorText error={error} className="mb-3" />
          <NoticeText className="mb-3">{notice}</NoticeText>
          <div className="space-y-3">
            {(repos.data?.repos ?? []).map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                workgroups={workgroups.data ?? []}
                busy={busyRepo === repo.id}
                onLink={(fields) => void linkRepo(repo, fields)}
                onSync={() => void syncRepo(repo.id)}
              />
            ))}
            {repos.data?.repos.length === 0 && (
              <EmptyState>
                No repositories accessible to the installation.
              </EmptyState>
            )}
          </div>
        </>
      )}

      {installed === null && !repos.loading && <ErrorText error={error} />}
    </div>
  );
}

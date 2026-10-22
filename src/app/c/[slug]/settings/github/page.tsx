"use client";

import { use, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type {
  GithubInstallationOption,
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
  ConfirmDialog,
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
  const disconnect = useAsyncAction("Could not disconnect GitHub");
  const [confirmingInstallation, setConfirmingInstallation] = useState<GithubInstallationOption | null>(null);
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

  async function linkRepo(installation: GithubInstallationOption, repo: GithubRepoOption, fields: RepoLinkFields) {
    await withRepo(repo.id, async () => {
      await apiFetch("/api/github/repos", {
        body: {
          communityId: community!.id,
          installationId: installation.installationId,
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

  async function disconnectNow() {
    const installation = confirmingInstallation;
    if (!installation) return;
    const ok = await disconnect.run(() =>
      apiFetch("/api/github/installation", {
        method: "DELETE",
        body: { communityId: community!.id, installationId: installation.installationId },
      }),
    );
    if (ok) {
      setConfirmingInstallation(null);
      setNotice(null);
      repos.reload();
    }
  }

  async function syncRepo(repoId: number) {
    await withRepo(repoId, async () => {
      const result = await apiFetch<SyncRepoResponse>("/api/github/sync", {
        body: { repoId },
      });
      setNotice(`Synced ${result.synced} issues, removed ${result.deleted}`);
    });
  }

  const installations = repos.data?.installations ?? null;
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

      {installations !== null && installations.length === 0 && (
        <Card>
          <p className="mb-4 text-zinc-400">
            Install the Treasury Guild GitHub App on your organization to sync
            issues and project boards. Issues in your project&apos;s import
            column (default &quot;In review&quot;) that carry your payable
            label (default <Badge tone="green">audited</Badge>) are imported
            and become ready for payout automatically.
          </p>
          <ErrorText error={error} className="mb-3" />
          <Button onClick={() => void install()} loading={action.busy}>
            {action.busy ? "Opening GitHub…" : "Install GitHub App"}
          </Button>
          <p className="mt-3 text-sm text-zinc-500">
            Don&apos;t see your organisation on GitHub? You need to be an
            organisation owner to install there.
          </p>
        </Card>
      )}

      {installations !== null && installations.length > 0 && (
        <>
          <p className="mb-4 text-sm text-zinc-400">
            Map repositories to workgroups — only issues sitting in the import
            column of a project board <em>and</em> carrying the payable label
            are imported. They sync in near-real-time via webhooks, with an
            hourly sweep as backup; issues that leave the column or lose the
            label are removed unless already paid. Repositories from any
            connected organisation can be linked to any workgroup.
          </p>
          <ErrorText error={error} className="mb-3" />
          <NoticeText className="mb-3">{notice}</NoticeText>

          {installations.map((installation) => (
            <section key={installation.installationId} className="mb-6">
              <Card className="mb-3">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="min-w-0 flex-1 text-sm">
                    Installed on{" "}
                    <span className="font-medium">{installation.accountLogin}</span>
                    {installation.accountType && (
                      <span className="text-zinc-500"> ({installation.accountType})</span>
                    )}
                  </p>
                  <Button variant="ghost" onClick={() => setConfirmingInstallation(installation)}>
                    Disconnect
                  </Button>
                </div>
              </Card>
              {installation.error ? (
                <ErrorText error={installation.error} className="mb-3" />
              ) : (
                <div className="space-y-3">
                  {installation.repos.map((repo) => (
                    <RepoCard
                      key={repo.id}
                      repo={repo}
                      workgroups={workgroups.data ?? []}
                      busy={busyRepo === repo.id}
                      onLink={(fields) => void linkRepo(installation, repo, fields)}
                      onSync={() => void syncRepo(repo.id)}
                    />
                  ))}
                  {installation.repos.length === 0 && (
                    <EmptyState>
                      No repositories accessible to the installation.
                    </EmptyState>
                  )}
                </div>
              )}
            </section>
          ))}

          <Button variant="secondary" onClick={() => void install()} loading={action.busy}>
            {action.busy ? "Opening GitHub…" : "Add another organisation"}
          </Button>
          <p className="mt-3 text-sm text-zinc-500">
            Don&apos;t see your organisation on GitHub? You need to be an
            organisation owner to install there.
          </p>

          <ConfirmDialog
            open={confirmingInstallation !== null}
            busy={disconnect.busy}
            error={disconnect.error}
            title="Disconnect GitHub?"
            confirmLabel="Disconnect"
            onCancel={() => setConfirmingInstallation(null)}
            onConfirm={() => void disconnectNow()}
          >
            The Treasury Guild app is uninstalled from{" "}
            {confirmingInstallation?.accountLogin ?? "this GitHub account"} and
            this community&apos;s repository and project links for it are
            removed, so sync and payment write-back stop for that organisation.
            Other connected organisations are unaffected. Tasks already
            imported and their payment history stay, frozen — they are no
            longer updated from GitHub — and workgroups fed only by this
            organisation become app boards again.
          </ConfirmDialog>
        </>
      )}

      {installations === null && !repos.loading && <ErrorText error={error} />}
    </div>
  );
}

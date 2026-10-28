"use client";

// The community-level governance settings (migration 0059 / 0067): whether
// frozen tally documents are published to an outside store, and what a spend
// that fails the budget check does. Admins edit; members read. Turning
// publication on is confirmed first, because a published document cannot be
// taken back. GitHub needs an archive repository on the community's App
// installation.
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { GithubReposResponse, OkResponse } from "@/lib/api/types";
import type { DocumentStoreName } from "@/lib/db/types";
import { SpendCheckMode, type GovernanceCommunitySettings } from "@/lib/governance/rules";
import { STORE_LABELS } from "@/lib/storage/locator";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import Link from "next/link";
import { Button, Card, ConfirmDialog, ErrorText, Field, NoticeText, Select, SectionTitle } from "@/components/ui";
import { routes } from "@/lib/routes";

export function RecordsAndChecksCard({ communityId, initial, canEdit, onSaved, slug }: {
  communityId: string;
  initial: GovernanceCommunitySettings;
  canEdit: boolean;
  onSaved: () => void;
  /** For deep links when the GitHub App is missing. */
  slug?: string;
}) {
  const [store, setStore] = useState<DocumentStoreName | null>(initial.documentStore);
  const [archiveRepoId, setArchiveRepoId] = useState<number | null>(initial.documentArchiveRepoId);
  const [spendCheck, setSpendCheck] = useState(initial.spendCheck);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useAsyncAction("Failed to save the settings");
  const off = !canEdit;
  const turningOn = store !== null && initial.documentStore !== store;
  const needsArchive = store === "github";
  const archiveReady = !needsArchive || archiveRepoId != null;

  const repos = useAsyncData(canEdit && needsArchive ? communityId : null, () =>
    apiFetch<GithubReposResponse>("/api/github/repos", { query: { communityId } }));

  const archiveOptions = (repos.data?.installations ?? []).flatMap((installation) =>
    installation.repos.map((repo) => ({
      id: repo.id,
      label: `${repo.fullName}${repo.private ? " (private)" : ""}`,
    })));

  useEffect(() => {
    if (!needsArchive) setArchiveRepoId(null);
  }, [needsArchive]);

  async function submit() {
    setConfirming(false);
    const ok = await save.run(() => apiFetch<OkResponse>("/api/governance/community-settings", {
      body: {
        communityId,
        documentStore: store,
        documentArchiveRepoId: store === "github" ? archiveRepoId : null,
        spendCheck,
      },
    }));
    if (ok) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <Card className="space-y-4">
      <SectionTitle>Records and checks</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Publish signed tallies" size="sm"
          hint="Every proposal that reached a vote gets a frozen, hashed record of its ballots and result, kept here for members. Publishing also puts a copy (with every voter's address and ballot) where it can be fetched by its hash. Applies to proposals closing from when it is turned on.">
          <Select aria-label="Publish signed tallies" value={store ?? ""} disabled={off}
            onChange={(e) => { setSaved(false); setStore((e.target.value || null) as DocumentStoreName | null); }}>
            <option value="">Keep in Treasury Guild only</option>
            {Object.entries(STORE_LABELS).map(([name, label]) => <option key={name} value={name}>{label}</option>)}
          </Select>
        </Field>
        <Field label="A spend that does not fit the voted budgets" size="sm"
          hint="With budget consent on, every payout and payment is checked against the budgets in force before it is built.">
          <Select aria-label="Spending check" value={spendCheck} disabled={off}
            onChange={(e) => { setSaved(false); setSpendCheck(e.target.value as SpendCheckMode); }}>
            <option value={SpendCheckMode.Warn}>Warn the signers on the transaction page</option>
            <option value={SpendCheckMode.Refuse}>Refuse to build it</option>
          </Select>
        </Field>
      </div>
      {needsArchive && (
        <Field label="GitHub archive repository" size="sm"
          hint="A dedicated repository on this community's GitHub App installation. Tallies are committed under tallies/. Prefer a public archive that is not a workgroup board, so anyone can fetch a copy by its hash; a private repo keeps the copy off the open web but is only as private as that repo.">
          <Select aria-label="GitHub archive repository"
            value={archiveRepoId == null ? "" : String(archiveRepoId)} disabled={off || repos.loading}
            onChange={(e) => {
              setSaved(false);
              setArchiveRepoId(e.target.value ? Number(e.target.value) : null);
            }}>
            <option value="">{repos.loading ? "Loading repositories…" : "Select a repository"}</option>
            {archiveOptions.map((repo) => (
              <option key={repo.id} value={repo.id}>{repo.label}</option>
            ))}
          </Select>
          <ErrorText error={repos.error} />
          {!repos.loading && !repos.error && archiveOptions.length === 0 && (
            <p className="mt-1 text-sm text-zinc-500">
              Install the GitHub App and grant it access to an archive repository first
              {slug ? (
                <>
                  {" "}—{" "}
                  <Link className="underline" href={routes.githubSettings(slug)}>GitHub settings</Link>
                  {" "}or{" "}
                  <Link className="underline" href={`${routes.integrations(slug)}#github`}>Integrations</Link>
                </>
              ) : null}
              .
            </p>
          )}
        </Field>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ErrorText error={save.error} />
          <NoticeText>{saved ? "Saved." : null}</NoticeText>
          <Button loading={save.busy} disabled={!archiveReady}
            onClick={() => (turningOn ? setConfirming(true) : void submit())}>Save</Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Publish signed tallies to ${store ? STORE_LABELS[store] : ""}?`}
        confirmLabel="Publish from now on"
        busy={save.busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void submit()}
      >
        Each published record holds every voter&apos;s wallet address, choice, reason and signature for that proposal.{" "}
        {store === "ipfs"
          ? "A copy on IPFS is public and permanent."
          : store === "github"
            ? "A copy on GitHub is as public as the archive repository you choose (prefer a public one so anyone can fetch it by its hash)."
            : "A published copy cannot be taken back."}
        {" "}Turning this off later stops new records from being published but does not remove the ones already there.
      </ConfirmDialog>
    </Card>
  );
}

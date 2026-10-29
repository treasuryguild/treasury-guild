"use client";

import { useState } from "react";
import type { GithubRepoOption } from "@/lib/api/types";
import {
  DEFAULT_IMPORT_STATUS,
  DEFAULT_PAID_STATUS,
  DEFAULT_PAYABLE_LABEL,
} from "@/lib/constants";
import { Button, Card, Field, Input, Select } from "@/components/ui";

export interface RepoLinkFields {
  workgroupId: string;
  label: string;
  importStatus: string;
  /** "" disables moving paid issues to a Status column. */
  paidStatus: string;
}

/** One accessible GitHub repo with its workgroup link editor. */
export function RepoCard({
  repo,
  workgroups,
  busy,
  onLink,
  onSync,
}: {
  repo: GithubRepoOption;
  workgroups: { id: string; name: string; archived_at: string | null }[];
  busy: boolean;
  onLink: (fields: RepoLinkFields) => void;
  onSync: () => void;
}) {
  const [workgroupId, setWorkgroupId] = useState(repo.workgroupId ?? "");
  const archived = !!workgroups.find((w) => w.id === repo.workgroupId)?.archived_at;
  const [label, setLabel] = useState(repo.payableLabel ?? DEFAULT_PAYABLE_LABEL);
  const [importStatus, setImportStatus] = useState(
    repo.importStatus ?? DEFAULT_IMPORT_STATUS,
  );
  const [paidStatus, setPaidStatus] = useState(repo.paidStatus ?? DEFAULT_PAID_STATUS);

  return (
    <Card>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 lg:w-52 lg:shrink-0 lg:pt-5">
          <p className="truncate font-medium">{repo.fullName}</p>
          <p className="text-xs text-zinc-500">
            {archived
              ? "Archived workgroup — imports paused. Restore the workgroup to make changes."
              : repo.workgroupId
                ? "linked"
                : "not linked"}
          </p>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Workgroup" size="sm" className="min-w-0">
            <Select
              value={workgroupId}
              disabled={busy || archived}
              onChange={(e) => setWorkgroupId(e.target.value)}
            >
              <option value="">—</option>
              {workgroups
                .filter((w) => !w.archived_at || w.id === repo.workgroupId)
                .map((w) => (
                  <option key={w.id} value={w.id} disabled={!!w.archived_at}>
                    {w.name}
                    {w.archived_at ? " (Archived)" : ""}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Payable label" size="sm" className="min-w-0">
            <Input
              value={label}
              disabled={busy || archived}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="Import status" size="sm" className="min-w-0">
            <Input
              value={importStatus}
              disabled={busy || archived}
              onChange={(e) => setImportStatus(e.target.value)}
            />
          </Field>
          <Field
            label="Paid status"
            size="sm"
            className="min-w-0"
            hint="Status column paid issues move to. Must exist on the project; leave empty to disable."
          >
            <Input
              value={paidStatus}
              disabled={busy || archived}
              placeholder="(disabled)"
              onChange={(e) => setPaidStatus(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:pt-5">
          <Button
            disabled={busy || archived || !workgroupId}
            onClick={() => onLink({ workgroupId, label, importStatus, paidStatus })}
          >
            {repo.workgroupId ? "Update" : "Link"}
          </Button>
          {repo.workgroupId && (
            <Button
              variant="secondary"
              loading={busy}
              disabled={archived}
              onClick={onSync}
            >
              {busy ? "Syncing…" : "Full sync"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

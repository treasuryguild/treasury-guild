"use client";

// Admin-only queue on the Treasury page: payouts and payments found on-chain
// that carry a Guild Vault record but could not be imported on their own.
// Each row says why, and offers what settles it: name the workgroup, import
// the task under a new number, try again, or dismiss it.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ChainImportResolveBody, ChainImportWorkgroupBody } from "@/lib/api/schemas";
import type { ChainImportRunResponse } from "@/lib/api/types";
import {
  chainImportIssueText,
  conflictingNumbers,
  workgroupNamesToResolve,
} from "@/lib/chainImport/issueText";
import type { Network } from "@/lib/config";
import { ChainImportStatus } from "@/lib/constants";
import type { ExternalTxRow } from "@/lib/db/types";
import { describeExternalTx } from "@/lib/externalTx";
import { formatDate, plural, shortHash } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, Card, ErrorText, ExplorerLink, NoticeText, SectionTitle, Select } from "@/components/ui";

function outcomeText(result: ChainImportRunResponse): string {
  const imported = result.imported.length;
  const held = result.blocked.length;
  if (imported === 0 && held === 0) return "Done.";
  const parts: string[] = [];
  if (imported > 0) parts.push(`Imported ${plural(imported, "transaction")}`);
  if (held > 0) parts.push(`${held} still need${held === 1 ? "s" : ""} attention`);
  return `${parts.join("; ")}.`;
}

function WorkgroupResolver({
  name,
  workgroups,
  busy,
  onResolve,
}: {
  name: string;
  workgroups: WorkgroupSummary[];
  busy: boolean;
  onResolve: (body: Omit<ChainImportWorkgroupBody, "communityId">) => void;
}) {
  const [target, setTarget] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => onResolve({ name, action: "create" })}>
        Create workgroup “{name}”
      </Button>
      <span className="text-xs text-zinc-500">or</span>
      <Select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-auto"
        aria-label={`Existing workgroup for ${name}`}
      >
        <option value="">Use an existing workgroup…</option>
        {workgroups.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </Select>
      <Button
        variant="secondary"
        disabled={busy || !target}
        onClick={() => onResolve({ name, action: "map", workgroupId: target })}
      >
        Use it
      </Button>
    </div>
  );
}

export function ChainImportQueue({
  communityId,
  network,
  rows,
  workgroups,
  treasuryName,
  onChanged,
}: {
  communityId: string;
  network: Network;
  rows: ExternalTxRow[];
  /** Active workgroups an on-chain name can be pointed at. */
  workgroups: WorkgroupSummary[];
  /** Null when the community has one treasury (nothing to tell apart). */
  treasuryName: ((id: string) => string) | null;
  onChanged: () => void;
}) {
  const action = useAsyncAction();
  const [notice, setNotice] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);

  const held = rows.filter((r) => r.import_status === ChainImportStatus.Blocked);
  const ignored = rows.filter((r) => r.import_status === ChainImportStatus.Ignored);
  if (rows.length === 0) return null;

  async function send(path: string, body: ChainImportResolveBody | ChainImportWorkgroupBody) {
    setNotice(null);
    const result = await action.run(() => apiFetch<ChainImportRunResponse>(path, { body }));
    if (result) setNotice(outcomeText(result));
    // Also after a failure: "no longer waiting" means someone else imported it.
    onChanged();
  }
  const resolve = (body: ChainImportResolveBody) => send("/api/chain-import/resolve", body);

  function row(tx: ExternalTxRow) {
    const { title, detail } = describeExternalTx(tx);
    const isIgnored = tx.import_status === ChainImportStatus.Ignored;
    const numbers = conflictingNumbers(tx.import_issues);
    return (
      <Card key={tx.tx_hash} className="space-y-3 py-4">
        <div>
          <p className="text-sm">{title}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {treasuryName && <>{treasuryName(tx.treasury_id)} · </>}
            {formatDate(tx.block_time, "datetime")} · {detail} ·{" "}
            <ExplorerLink network={network} target={{ txHash: tx.tx_hash }}
              className="font-mono underline-offset-2 hover:underline">
              {shortHash(tx.tx_hash, 12)}
            </ExplorerLink>
          </p>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-300">
          {tx.import_issues.map((issue, i) => (
            <li key={i}>{chainImportIssueText(issue)}</li>
          ))}
        </ul>
        {!isIgnored &&
          workgroupNamesToResolve(tx.import_issues).map((name) => (
            <WorkgroupResolver
              key={name}
              name={name}
              workgroups={workgroups}
              busy={action.busy}
              onResolve={(body) => send("/api/chain-import/workgroup", { communityId, ...body })}
            />
          ))}
        <div className="flex flex-wrap gap-2">
          {isIgnored ? (
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() => resolve({ txHash: tx.tx_hash, action: "unignore" })}
            >
              Restore
            </Button>
          ) : (
            <>
              {numbers.length > 0 && (
                <Button
                  variant="secondary"
                  disabled={action.busy}
                  title="The task keeps its on-chain number as a note; here it gets the next free number."
                  onClick={() => resolve({ txHash: tx.tx_hash, action: "new_number", chainNumbers: numbers })}
                >
                  Import #{numbers.join(", #")} as new task number{numbers.length === 1 ? "" : "s"}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() => resolve({ txHash: tx.tx_hash, action: "retry" })}
              >
                Try again
              </Button>
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() => resolve({ txHash: tx.tx_hash, action: "ignore" })}
              >
                Ignore
              </Button>
            </>
          )}
        </div>
      </Card>
    );
  }

  return (
    <section className="mb-8">
      <SectionTitle>On-chain payments waiting for import ({held.length})</SectionTitle>
      <p className="-mt-2 mb-3 text-sm text-zinc-400">
        These transactions were sent from a treasury by another copy of Guild Vault. Their tasks and
        payments are added here once the points below are settled.
      </p>
      <ErrorText error={action.error} className="mb-3" />
      <NoticeText className="mb-3">{notice}</NoticeText>
      <div className="space-y-3">{held.map(row)}</div>
      {ignored.length > 0 && (
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setShowIgnored((v) => !v)}>
            {showIgnored ? "Hide" : "Show"} ignored ({ignored.length})
          </Button>
          {showIgnored && <div className="mt-3 space-y-3">{ignored.map(row)}</div>}
        </div>
      )}
    </section>
  );
}

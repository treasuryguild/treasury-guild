"use client";

// The co-signer check of a co-signed transaction: run live for whoever
// looks (a member co-signer reads it before signing), with the decisions
// the app-held co-signer recorded and, for treasury actors, a button to ask
// it to check again once a refusal has been dealt with.
import { apiFetch } from "@/lib/api/client";
import type { CosignCheckResponse, CosignResponse } from "@/lib/api/types";
import { CosignerKind, TxState, type CosignerKind as CosignerKindValue } from "@/lib/constants";
import type { CosignerDecisionRow } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Button, Card, ErrorText, Spinner } from "@/components/ui";

export function CosignerCard({
  txId,
  txState,
  cosignerKind,
  initialDecisions,
  canRerun,
  onChanged,
}: {
  txId: string;
  txState: number;
  cosignerKind: CosignerKindValue | null;
  initialDecisions: CosignerDecisionRow[];
  canRerun: boolean;
  onChanged: () => void;
}) {
  const check = useAsyncData(txId, () => apiFetch<CosignCheckResponse>(`/api/tx/${txId}/cosign-check`));
  const rerun = useAsyncAction("The co-signer could not check again");
  const decisions = check.data?.decisions ?? initialDecisions;
  const app = cosignerKind === CosignerKind.App;

  async function askAgain() {
    const result = await rerun.run(() => apiFetch<CosignResponse>(`/api/tx/${txId}/cosign`, { method: "POST" }));
    if (!result) return;
    check.reload();
    onChanged();
  }

  return (
    <Card className={`mb-4 ${check.data && !check.data.passed ? "border-amber-500/30" : ""}`}>
      <h3 className="mb-2 text-sm font-medium text-zinc-400">Co-signer check</h3>
      <p className="mb-2 text-xs text-zinc-400">
        {app
          ? "Guild Vault holds this treasury's co-signer key and signs only what passes: the outputs match the stored rows, the spend fits the voted budgets and every cited decision passed and was applied."
          : "The co-signer signs only what passes: the outputs match the stored rows, the spend fits the voted budgets and every cited decision passed and was applied. Read the result before signing."}
      </p>
      {check.loading && (
        <p role="status" className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> Checking…</p>
      )}
      <ErrorText error={check.error} />
      {check.data && (check.data.passed ? (
        <p className="text-sm text-emerald-400">The transaction passes the check.</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-200">
          {check.data.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      ))}
      {app && decisions.length > 0 && (
        <ol className="mt-3 space-y-1 text-xs text-zinc-500">
          {decisions.map((d) => (
            <li key={d.id}>
              {formatDate(d.decided_at, "datetime")}: {d.signed ? "passed and signed" : d.error ? `passed, signing failed: ${d.error}` : d.passed ? "passed, signature not added" : `refused (${d.problems.length} problem${d.problems.length === 1 ? "" : "s"})`}
              {" · "}{d.trigger === "sign" ? "after a signature" : d.trigger === "manual" ? "on request" : "by the sweep"}
            </li>
          ))}
        </ol>
      )}
      <ErrorText error={rerun.error} className="mt-2" />
      {app && canRerun && txState === TxState.Pending && (
        <Button variant="secondary" className="mt-3" onClick={() => void askAgain()} loading={rerun.busy}>
          Run the co-signer check again
        </Button>
      )}
    </Card>
  );
}

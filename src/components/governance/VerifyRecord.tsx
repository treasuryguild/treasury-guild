"use client";

// Verify: fetch the frozen tally document, check it in the browser
// (checkTallyDocument: fingerprints, every ballot's signature, the recount),
// read each confirmed anchor's record from the chain and compare
// (compareAnchors). The checker pulls in Mesh's crypto, so it is loaded only
// when the button is clicked.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { TxMetadataResponse } from "@/lib/api/types";
import { parseAnchorMetadata } from "@/lib/cardano/anchorMetadata";
import type { Network } from "@/lib/config";
import { ANCHOR_STEPS } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import type { AnchorStatus } from "@/lib/governance/anchors";
import { electorateHash } from "@/lib/governance/electorateHash";
import { compareAnchors, type AnchorComparison, type VerifiedAnchor } from "@/lib/governance/verify";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, NoticeText, WarningText } from "@/components/ui";

interface VerifyReport {
  documentProblems: string[];
  anchors: AnchorComparison;
}

export function VerifyRecord({ proposal, anchors, network }: {
  proposal: ProposalRow;
  anchors: AnchorStatus;
  network: Network;
}) {
  const { run, busy, error } = useAsyncAction("Could not verify the record");
  const [report, setReport] = useState<VerifyReport | null>(null);

  async function verify(): Promise<VerifyReport> {
    // The frozen document as served; its hash is over canonical JSON, so the parsed shape is all the check needs.
    const downloaded = await apiFetch<unknown>(`/api/proposals/${proposal.id}/tally`);
    const { parseTallyDocument, checkTallyDocument } = await import("@/lib/governance/tallyDocument");
    const doc = parseTallyDocument(JSON.stringify(downloaded));
    if (!doc) throw new Error("The download is not a tally document");
    const documentProblems = await checkTallyDocument(doc);
    const confirmed = ANCHOR_STEPS.filter((step) => anchors[step].status === "anchored" && anchors[step].txHash);
    const onChain: VerifiedAnchor[] = await Promise.all(confirmed.map(async (step) => {
      const txHash = anchors[step].txHash!;
      const meta = await apiFetch<TxMetadataResponse>("/api/chain/tx-metadata", { query: { hash: txHash, network } });
      return { step, txHash, blockTime: meta.blockTime, record: parseAnchorMetadata(meta.anchor) };
    }));
    const listHash = doc.body.proposal.electorateHash ? await electorateHash(doc.body.electorate) : null;
    return { documentProblems, anchors: compareAnchors(doc, onChain, listHash) };
  }

  const problems = report ? [...report.documentProblems, ...report.anchors.problems] : [];
  return (
    <div className="mt-4 space-y-2">
      <Button variant="secondary" loading={busy} onClick={() => void run(verify).then((r) => r && setReport(r))}>
        Verify record and anchors
      </Button>
      <p className="text-xs text-zinc-500">
        Runs in your browser: checks the frozen record (fingerprints, every ballot&apos;s signature, the count) and compares it
        with the anchors read from the chain.
      </p>
      <ErrorText error={error} />
      {report && problems.length === 0 && (
        <NoticeText>
          The record checks out
          {report.anchors.found.length > 0
            ? ` and matches its ${report.anchors.found.length === 1 ? "anchor" : "anchors"} on-chain (${report.anchors.found.join(", ")}).`
            : "; no anchor is on-chain yet to compare it with."}
          {report.anchors.anchoredBeforeVoting === true && " The content and voter list were anchored before voting opened."}
          {report.anchors.anchoredBeforeVoting === false && " Note: an anchor landed only after voting opened."}
        </NoticeText>
      )}
      {report && problems.length > 0 && (
        <div>
          <WarningText>The record or its anchors do not check out:</WarningText>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-200">
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

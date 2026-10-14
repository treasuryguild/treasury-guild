"use client";

// Human rendering of the label-190001 payout metadata (v3): per recipient
// output, one row per task with its number, workgroup, budget period,
// bounties and the decisions it cites. Decoded from the tx CBOR, so signers
// verify what is actually on chain. The format is positional (see
// metadata.ts); this resolves every index back to its name. Periods render
// exactly as written ("2026-05" or "2026-Q2") so what the signer reads is
// what the chain holds.

import { parsePayoutMetadata, type Citation } from "@/lib/cardano/metadata";
import { CitationLinks } from "./CitationLinks";

export function PayoutMetadataTable({
  meta,
  slug,
  localTaskNumbers = {},
  citedProposals = {},
}: {
  meta: unknown;
  slug: string;
  /** On-chain task number → the task's number here, where the import renumbered it. */
  localTaskNumbers?: Record<number, number>;
  /** Cited proposal number → its id here, for links. */
  citedProposals?: Record<number, string>;
}) {
  const parsed = parsePayoutMetadata(meta);
  if (!parsed) return null;
  // The decisions each task cites, from the record's `g`.
  const citationsByTask = new Map<number, Citation[]>();
  for (const [number, contentHash, tasks] of parsed.g ?? []) {
    for (const task of tasks) citationsByTask.set(task, [...(citationsByTask.get(task) ?? []), { number, contentHash }]);
  }
  const cites = citationsByTask.size > 0;
  return (
    <div className="mt-3 space-y-3">
      {parsed.p.map(([outputIndex, tasks]) => (
        <div key={outputIndex}>
          <p className="mb-1 text-xs text-zinc-400">Output #{outputIndex + 1}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="pr-3 font-normal">Task</th>
                  <th className="pr-3 font-normal">Workgroup</th>
                  <th className="pr-3 font-normal">Period</th>
                  {cites && <th className="pr-3 font-normal">Decisions</th>}
                  <th className="text-right font-normal">Bounty</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {tasks.map(([number, w, b, amounts]) => {
                  const paid = amounts
                    .map((amount, k) => ({ amount, ticker: parsed.k[k] ?? "?" }))
                    .filter(({ amount }) => amount !== "");
                  return (
                    <tr key={number}>
                      <td className="pr-3 font-mono">
                        {parsed.c}#{number}
                        {localTaskNumbers[number] !== undefined && (
                          <span className="ml-1 font-sans text-zinc-500" title="Imported under a new task number">
                            (#{localTaskNumbers[number]} here)
                          </span>
                        )}
                      </td>
                      <td className="pr-3">{parsed.w[w] ?? "?"}</td>
                      <td className="pr-3">{parsed.b[b] ?? "?"}</td>
                      {cites && (
                        <td className="pr-3">
                          {citationsByTask.has(number)
                            ? <CitationLinks slug={slug} citations={citationsByTask.get(number)!} citedProposals={citedProposals} />
                            : <span className="text-zinc-500">—</span>}
                        </td>
                      )}
                      <td className="text-right">
                        {paid.map(({ amount, ticker }) => (
                          <span key={ticker} className="block">
                            {amount} {ticker}
                          </span>
                        ))}
                        {paid.length === 0 && <span className="text-zinc-500">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
